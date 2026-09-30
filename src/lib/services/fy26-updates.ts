/**
 * Write paths for Design Goals FY 26.
 *
 * Mirrors the contract of `services/updates.ts` — diff field by field, refuse
 * the baseline, write the change and its audit rows in one transaction — but
 * stays a separate module because FY26 packages are deliberately not part of
 * `ENTITY_TYPES` and so not part of the reschedule graph.
 *
 * Every field written here is also appended to `userEditedFields`, which is
 * what stops the next import overwriting a manual edit.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { fy26PackageDependencies, fy26PackageRevisions, fy26Packages } from '@/db/schema';
import { recordAudit, type Actor } from '@/lib/audit';
import { newId } from '@/lib/ids';
import { parseEditedFields } from '@/lib/import/design-goals-fy26/upsert';
import type { Fy26DependencyCreate, Fy26DependencyUpdate, Fy26PackageUpdate } from '@/lib/validation';

export interface FieldChange {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

function fmt(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function mergeEditedFields(existing: string, fields: string[]): string {
  const set = parseEditedFields(existing);
  for (const f of fields) set.add(f);
  return [...set].sort().join(',');
}

/** Columns an import may write, and therefore columns worth protecting. */
const PACKAGE_SOURCE_FIELDS = new Set([
  'packageDescription',
  'fy26PhaseId',
  'disciplineId',
  'responsibleUserId',
  'currentExpectedReleaseDate',
  'planBillingCr',
  'actualBillingCr',
  'plannedPackageQuantity',
  'actualPackageQuantity',
  'remarks',
]);

const DEPENDENCY_SOURCE_FIELDS = new Set([
  'stepLabel',
  'description',
  'targetDate',
  'responsibleText',
  'remarks',
]);

export interface UpdateResult {
  id: string;
  changes: FieldChange[];
}

export async function updateFy26Package(
  id: string,
  patch: Fy26PackageUpdate,
  actor: Actor,
): Promise<UpdateResult> {
  const { reason, ...fields } = patch;

  // Structural guarantee, matching the rest of the application: the baseline
  // column cannot be written through this path at all.
  if ('baselineReleaseDate' in fields) {
    throw new Error('The original (baseline) release date is immutable. Change the current expected date instead.');
  }

  const [before] = await db.select().from(fy26Packages).where(eq(fy26Packages.id, id)).limit(1);
  if (!before) throw new Error(`FY26 package ${id} not found`);

  const changes: FieldChange[] = [];
  const effective: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const oldStr = fmt((before as Record<string, unknown>)[field]);
    const newStr = fmt(value);
    if (oldStr === newStr) continue;
    effective[field] = value;
    changes.push({ field, oldValue: oldStr, newValue: newStr });
  }
  if (changes.length === 0) return { id, changes: [] };

  const protectedNow = changes.map((c) => c.field).filter((f) => PACKAGE_SOURCE_FIELDS.has(f));
  const label = `${before.packageDescription}`;
  const dateChanged = changes.find((c) => c.field === 'currentExpectedReleaseDate');
  const billingChanged = changes.find((c) => c.field === 'planBillingCr');
  const quantityChanged = changes.find((c) => c.field === 'plannedPackageQuantity');

  await db.transaction(async (tx) => {
    await tx
      .update(fy26Packages)
      .set({
        ...effective,
        userEditedFields: mergeEditedFields(before.userEditedFields, protectedNow),
        revisionCount: dateChanged ? sql`${fy26Packages.revisionCount} + 1` : fy26Packages.revisionCount,
        updatedAt: new Date(),
      } as never)
      .where(eq(fy26Packages.id, id));

    if (dateChanged || billingChanged || quantityChanged) {
      await tx.insert(fy26PackageRevisions).values({
        id: newId('fpr_'),
        fy26PackageId: id,
        previousExpectedDate: before.currentExpectedReleaseDate,
        newExpectedDate: (effective.currentExpectedReleaseDate as Date | null) ?? before.currentExpectedReleaseDate,
        previousPlanBillingCr: before.planBillingCr,
        newPlanBillingCr: (effective.planBillingCr as number | null) ?? before.planBillingCr,
        previousPlannedQuantity: before.plannedPackageQuantity,
        newPlannedQuantity: (effective.plannedPackageQuantity as number | null) ?? before.plannedPackageQuantity,
        reason: reason ?? null,
        changedById: actor.id,
      });
    }

    for (const c of changes) {
      const action =
        c.field === 'completionStatus'
          ? c.newValue === 'COMPLETED'
            ? 'COMPLETE'
            : 'UNCOMPLETE'
          : 'UPDATE';
      await recordAudit(
        {
          actor,
          entityType: 'FY26_PACKAGE',
          entityId: id,
          entityLabel: label,
          action,
          field: c.field,
          oldValue: c.oldValue,
          newValue: c.newValue,
          reason: reason ?? null,
        },
        tx,
      );
    }
  });

  return { id, changes };
}

export async function createFy26Dependency(
  input: Fy26DependencyCreate,
  actor: Actor,
): Promise<{ id: string }> {
  const { reason, fy26PackageId, ...fields } = input;

  const [pkg] = await db.select().from(fy26Packages).where(eq(fy26Packages.id, fy26PackageId)).limit(1);
  if (!pkg) throw new Error(`FY26 package ${fy26PackageId} not found`);

  const [{ maxSeq }] = await db
    .select({ maxSeq: sql<number>`coalesce(max(${fy26PackageDependencies.sequence}), 0)::int` })
    .from(fy26PackageDependencies)
    .where(eq(fy26PackageDependencies.fy26PackageId, fy26PackageId));

  const id = newId('fdp_');
  await db.transaction(async (tx) => {
    await tx.insert(fy26PackageDependencies).values({
      id,
      // Manual rows get a natural key that no source row can collide with, so a
      // re-import neither overwrites nor removes them.
      naturalKey: `MANUAL-${id}`,
      fy26PackageId,
      sequence: (maxSeq ?? 0) + 10,
      stepLabel: fields.stepLabel ?? null,
      description: fields.description,
      targetDate: (fields.targetDate as Date | null) ?? null,
      responsibleText: fields.responsibleText ?? null,
      remarks: fields.remarks ?? null,
      completionStatus: fields.completionStatus ?? 'NOT_COMPLETED',
      isManual: true,
    });
    await recordAudit(
      {
        actor,
        entityType: 'FY26_DEPENDENCY',
        entityId: id,
        entityLabel: fields.description,
        action: 'CREATE',
        newValue: fields.description,
        reason: reason ?? `Added to package "${pkg.packageDescription}"`,
      },
      tx,
    );
  });

  return { id };
}

/**
 * Update one dependency. The parent package row is never written here — a
 * dependency edit must not modify its package.
 */
export async function updateFy26Dependency(
  id: string,
  patch: Fy26DependencyUpdate,
  actor: Actor,
): Promise<UpdateResult> {
  const { reason, ...fields } = patch;

  const [before] = await db
    .select()
    .from(fy26PackageDependencies)
    .where(eq(fy26PackageDependencies.id, id))
    .limit(1);
  if (!before) throw new Error(`FY26 dependency ${id} not found`);

  const changes: FieldChange[] = [];
  const effective: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const oldStr = fmt((before as Record<string, unknown>)[field]);
    const newStr = fmt(value);
    if (oldStr === newStr) continue;
    effective[field] = value;
    changes.push({ field, oldValue: oldStr, newValue: newStr });
  }
  if (changes.length === 0) return { id, changes: [] };

  const protectedNow = changes.map((c) => c.field).filter((f) => DEPENDENCY_SOURCE_FIELDS.has(f));

  await db.transaction(async (tx) => {
    await tx
      .update(fy26PackageDependencies)
      .set({
        ...effective,
        userEditedFields: mergeEditedFields(before.userEditedFields, protectedNow),
        updatedAt: new Date(),
      } as never)
      .where(eq(fy26PackageDependencies.id, id));

    for (const c of changes) {
      const action =
        c.field === 'completionStatus'
          ? c.newValue === 'COMPLETED'
            ? 'COMPLETE'
            : 'UNCOMPLETE'
          : 'UPDATE';
      await recordAudit(
        {
          actor,
          entityType: 'FY26_DEPENDENCY',
          entityId: id,
          entityLabel: before.description,
          action,
          field: c.field,
          oldValue: c.oldValue,
          newValue: c.newValue,
          reason: reason ?? null,
        },
        tx,
      );
    }
  });

  return { id, changes };
}

export async function deleteFy26Dependency(id: string, actor: Actor, reason?: string): Promise<void> {
  const [before] = await db
    .select()
    .from(fy26PackageDependencies)
    .where(eq(fy26PackageDependencies.id, id))
    .limit(1);
  if (!before) throw new Error(`FY26 dependency ${id} not found`);

  await db.transaction(async (tx) => {
    await tx.delete(fy26PackageDependencies).where(eq(fy26PackageDependencies.id, id));
    await recordAudit(
      {
        actor,
        entityType: 'FY26_DEPENDENCY',
        entityId: id,
        entityLabel: before.description,
        action: 'DELETE',
        oldValue: before.description,
        newValue: null,
        reason: reason ?? null,
      },
      tx,
    );
  });
}

/** Reorder a package's dependencies. Does not touch the package row. */
export async function reorderFy26Dependencies(
  packageId: string,
  orderedIds: string[],
  actor: Actor,
): Promise<void> {
  await db.transaction(async (tx) => {
    let seq = 0;
    for (const id of orderedIds) {
      seq += 10;
      await tx
        .update(fy26PackageDependencies)
        .set({ sequence: seq, updatedAt: new Date() })
        .where(and(eq(fy26PackageDependencies.id, id), eq(fy26PackageDependencies.fy26PackageId, packageId)));
    }
    await recordAudit(
      {
        actor,
        entityType: 'FY26_PACKAGE',
        entityId: packageId,
        action: 'UPDATE',
        field: 'dependencyOrder',
        newValue: orderedIds.join(','),
      },
      tx,
    );
  });
}
