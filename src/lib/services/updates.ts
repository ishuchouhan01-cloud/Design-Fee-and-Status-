/**
 * Write paths for operational updates. Everything here:
 *   - validates through Zod first (so "IN PROGRESS" or a percentage cannot
 *     even be expressed),
 *   - never touches a baseline date,
 *   - writes an audit row for every field it changes.
 */
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { deliverables, drawings, goals } from '@/db/schema';
import { recordAudit } from '@/lib/audit';
import type { Actor } from '@/lib/audit';
import { newId } from '@/lib/ids';
import { startOfDay } from '@/lib/periods';
import { mergeEditedFields, type CompletionStatus, type EntityType } from '@/lib/domain';
import { DATE_FIELDS, TABLE_FOR } from '@/lib/repo/entities';

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

const LABEL_FIELD = {
  GOAL: 'goalDescription',
  DELIVERABLE: 'deliverableDescription',
  DRAWING: 'drawingName',
  PACKAGE: 'packageName',
} as const;

const CODE_FIELD = {
  GOAL: 'goalCode',
  DELIVERABLE: 'deliverableCode',
  DRAWING: 'drawingCode',
  PACKAGE: 'packageCode',
} as const;

async function loadRow(entityType: EntityType, id: string) {
  const table = TABLE_FOR[entityType] as typeof goals;
  const [row] = await db.select().from(table).where(eq(table.id, id)).limit(1);
  return row as Record<string, unknown> | undefined;
}

export interface UpdateResult {
  id: string;
  changes: FieldChange[];
}

/**
 * Apply a validated patch. `patch` keys must already be real column names.
 */
export async function updateEntity(
  entityType: EntityType,
  id: string,
  patch: Record<string, unknown>,
  actor: Actor,
  reason?: string,
): Promise<UpdateResult> {
  const before = await loadRow(entityType, id);
  if (!before) throw new Error(`${entityType} ${id} not found`);
  const table = TABLE_FOR[entityType] as typeof goals;

  // Structural guarantee: the baseline column is not writable through here.
  const baselineField = DATE_FIELDS[entityType].baseline;
  if (baselineField in patch) {
    throw new Error('Baseline dates are immutable. Use a reschedule to move the current expected date.');
  }

  const changes: FieldChange[] = [];
  const effective: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const oldValue = before[field];
    const oldStr = fmt(oldValue);
    const newStr = fmt(value);
    if (oldStr === newStr) continue;
    effective[field] = value;
    changes.push({ field, oldValue: oldStr, newValue: newStr });
  }
  if (changes.length === 0) return { id, changes: [] };

  const label = `${before[CODE_FIELD[entityType]] ?? id} — ${before[LABEL_FIELD[entityType]] ?? ''}`.trim();
  const projectId = (before.projectId as string) ?? null;

  await db.transaction(async (tx) => {
    const extra: Record<string, unknown> = {};
    if (entityType === 'DRAWING') {
      // A user edit is protected from being overwritten by a later import.
      extra.userEditedFields = mergeEditedFields(before.userEditedFields as string, changes.map((c) => c.field));
      // "Updated On" shows when a person last changed the drawing.
      extra.editedAt = new Date();
    }
    await tx
      .update(table)
      .set({ ...effective, ...extra, updatedAt: new Date() } as never)
      .where(eq(table.id, id));
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
          entityType,
          entityId: id,
          entityLabel: label,
          action,
          field: c.field,
          oldValue: c.oldValue,
          newValue: c.newValue,
          reason: reason ?? null,
          projectId,
        },
        tx,
      );
    }
  });

  return { id, changes };
}

/**
 * MARK COMPLETED / MARK NOT COMPLETED.
 *
 * Completing defaults the actual date to today unless one is supplied.
 * Un-completing clears the actual date, because an item that is not complete
 * has not been released. The baseline is untouched either way, which is what
 * keeps "completed late" measurable.
 */
export async function setCompletion(
  entityType: Exclude<EntityType, 'PACKAGE'>,
  id: string,
  status: CompletionStatus,
  actor: Actor,
  opts: { actualDate?: Date | null; reason?: string } = {},
): Promise<UpdateResult> {
  const fields = DATE_FIELDS[entityType];
  const patch: Record<string, unknown> = { completionStatus: status };
  if (status === 'COMPLETED') {
    patch[fields.actual] = startOfDay(opts.actualDate ?? new Date());
  } else {
    patch[fields.actual] = null;
  }
  return updateEntity(entityType, id, patch, actor, opts.reason);
}

export interface BulkRequest {
  entityType: EntityType;
  ids: string[];
  action:
    | 'MARK_COMPLETED'
    | 'MARK_NOT_COMPLETED'
    | 'CHANGE_EXPECTED_DATE'
    | 'CHANGE_OWNER'
    | 'ADD_REMARK'
    | 'CHANGE_REVISION';
  actualReleaseDate?: Date | null;
  expectedDate?: Date | null;
  ownerId?: string | null;
  remark?: string;
  revision?: string;
  reason?: string;
}

export interface BulkResult {
  batchId: string;
  requested: number;
  applied: number;
  unchanged: number;
  rejected: { id: string; reason: string }[];
  validation: string[];
}

/**
 * Bulk update. Validated as a whole before anything is written: if the request
 * makes no sense for the selection, nothing is applied (spec §23).
 */
export async function applyBulk(req: BulkRequest, actor: Actor): Promise<BulkResult> {
  const batchId = newId('bk_');
  const validation: string[] = [];
  const rejected: { id: string; reason: string }[] = [];

  if (req.entityType === 'PACKAGE' && req.action !== 'CHANGE_EXPECTED_DATE') {
    validation.push('Packages support date changes only; completion follows from their contents.');
  }
  if (req.action === 'CHANGE_EXPECTED_DATE' && !req.expectedDate) {
    validation.push('A new expected date is required.');
  }
  if (req.action === 'CHANGE_EXPECTED_DATE' && (req.reason?.trim().length ?? 0) < 3) {
    validation.push('A reason is required: every expected-date change is recorded in the reschedule history.');
  }
  if (req.action === 'ADD_REMARK' && !req.remark?.trim()) {
    validation.push('A remark is required.');
  }
  if (req.action === 'CHANGE_REVISION' && !req.revision?.trim()) {
    validation.push('A revision is required.');
  }
  if (req.action === 'CHANGE_OWNER' && req.entityType !== 'DELIVERABLE') {
    validation.push('Owner is only held on design deliverables.');
  }
  if (validation.length) {
    return { batchId, requested: req.ids.length, applied: 0, unchanged: 0, rejected, validation };
  }

  const table = TABLE_FOR[req.entityType] as typeof goals;
  const rows = (await db.select().from(table).where(inArray(table.id, req.ids))) as Record<string, unknown>[];
  const found = new Set(rows.map((r) => r.id as string));
  for (const id of req.ids) if (!found.has(id)) rejected.push({ id, reason: 'Record not found' });

  // Expected dates move ONLY through the reschedule engine, so a bulk change
  // leaves the same history, audit and dependency cascade as a single one.
  if (req.action === 'CHANGE_EXPECTED_DATE') {
    const { applyReschedule } = await import('@/lib/reschedule');
    const open = rows.filter((r) => r.completionStatus !== 'COMPLETED' || req.entityType === 'PACKAGE');
    for (const r of rows) {
      if (!open.includes(r)) rejected.push({ id: r.id as string, reason: 'Completed — actual date preserved, not moved' });
    }
    if (open.length === 0) return { batchId, requested: req.ids.length, applied: 0, unchanged: 0, rejected, validation };
    const result = await applyReschedule(
      {
        entityType: req.entityType,
        entityIds: open.map((r) => r.id as string),
        newExpectedDate: req.expectedDate!,
        reason: req.reason!.trim(),
        scope: 'SELECTION',
      },
      actor,
    );
    const unchanged = result.impact.skipped.filter((s) => s.reason === 'Already on that date').length;
    for (const s of result.impact.skipped) {
      if (s.reason !== 'Already on that date' && !rejected.some((x) => x.id === s.entityId)) rejected.push({ id: s.entityId, reason: s.reason });
    }
    return { batchId: result.batchId, requested: req.ids.length, applied: result.applied, unchanged, rejected, validation };
  }

  // Drawings are released / revised through the Drawing Control service, so
  // bulk actions record the same release history and revision rows.
  if (req.entityType === 'DRAWING' && ['MARK_COMPLETED', 'MARK_NOT_COMPLETED', 'CHANGE_REVISION'].includes(req.action)) {
    const svc = await import('@/lib/services/drawing-control');
    let applied = 0;
    let unchanged = 0;
    for (const row of rows) {
      const id = row.id as string;
      try {
        if (req.action === 'MARK_COMPLETED') {
          if (row.completionStatus === 'COMPLETED') {
            unchanged += 1;
            continue;
          }
          await svc.releaseDrawing(id, { actualReleaseDate: req.actualReleaseDate ?? new Date(), remarks: req.reason }, actor);
        } else if (req.action === 'MARK_NOT_COMPLETED') {
          if (row.completionStatus === 'NOT_COMPLETED') {
            unchanged += 1;
            continue;
          }
          await svc.unreleaseDrawing(id, req.reason?.trim() || `Bulk withdraw (${batchId})`, actor);
        } else {
          if (row.revision === req.revision) {
            unchanged += 1;
            continue;
          }
          await svc.addRevision(id, { revision: req.revision!, remarks: req.reason }, actor);
        }
        applied += 1;
      } catch (err) {
        rejected.push({ id, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return { batchId, requested: req.ids.length, applied, unchanged, rejected, validation };
  }

  let applied = 0;
  let unchanged = 0;
  for (const row of rows) {
    const id = row.id as string;
    const patch: Record<string, unknown> = {};
    switch (req.action) {
      case 'MARK_COMPLETED':
        if (row.completionStatus === 'COMPLETED') {
          unchanged += 1;
          continue;
        }
        patch.completionStatus = 'COMPLETED';
        patch[DATE_FIELDS[req.entityType].actual] = startOfDay(req.actualReleaseDate ?? new Date());
        break;
      case 'MARK_NOT_COMPLETED':
        if (row.completionStatus === 'NOT_COMPLETED') {
          unchanged += 1;
          continue;
        }
        patch.completionStatus = 'NOT_COMPLETED';
        patch[DATE_FIELDS[req.entityType].actual] = null;
        break;
      case 'CHANGE_OWNER':
        patch.ownerId = req.ownerId ?? null;
        break;
      case 'ADD_REMARK': {
        const existing = (row.remarks as string | null) ?? '';
        patch.remarks = existing ? `${existing}\n${req.remark}` : req.remark;
        break;
      }
      case 'CHANGE_REVISION':
        patch.revision = req.revision;
        break;
    }
    try {
      const res = await updateEntity(req.entityType, id, patch, actor, req.reason ?? `Bulk ${req.action} (${batchId})`);
      if (res.changes.length) applied += 1;
      else unchanged += 1;
    } catch (err) {
      rejected.push({ id, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { batchId, requested: req.ids.length, applied, unchanged, rejected, validation };
}

export async function createGoal(
  input: {
    projectId: string;
    phaseId?: string | null;
    disciplineId?: string | null;
    designLeadId?: string | null;
    goalDescription: string;
    fiscalYear: string;
    quarter: number;
    plannedQuantity: number;
    plannedValue: number;
    priority: string;
    remarks?: string;
  },
  actor: Actor,
) {
  const { resolvePeriod } = await import('@/lib/periods');
  const { hash6 } = await import('@/lib/import/upsert');
  const { projects } = await import('@/db/schema');
  const [project] = await db.select().from(projects).where(eq(projects.id, input.projectId)).limit(1);
  if (!project) throw new Error('Project not found');
  const period = resolvePeriod(input.fiscalYear, input.quarter);
  const id = newId('gl_');
  const goalCode = `G-${project.projectCode}-${input.fiscalYear.replace(/[^A-Z0-9]/gi, '')}Q${input.quarter}-${hash6(
    input.phaseId,
    input.disciplineId,
    input.designLeadId,
    input.goalDescription,
    Date.now(),
  )}`;
  await db.transaction(async (tx) => {
    await tx.insert(goals).values({
        id,
        goalCode,
        projectId: input.projectId,
        phaseId: input.phaseId ?? null,
        disciplineId: input.disciplineId ?? null,
        designLeadId: input.designLeadId ?? null,
        goalDescription: input.goalDescription,
        fiscalYear: input.fiscalYear,
        quarter: input.quarter,
        periodStart: period.start,
        periodEnd: period.end,
        plannedQuantity: input.plannedQuantity,
        plannedValue: input.plannedValue,
        baselineTargetDate: period.end,
        currentExpectedDate: period.end,
        completionStatus: 'NOT_COMPLETED',
        priority: input.priority,
      remarks: input.remarks ?? null,
      sourceSheet: null,
      updatedAt: new Date(),
    });
    await recordAudit(
      {
        actor,
        entityType: 'GOAL',
        entityId: id,
        entityLabel: `${goalCode} — ${input.goalDescription}`,
        action: 'CREATE',
        newValue: JSON.stringify(input),
        projectId: input.projectId,
      },
      tx,
    );
  });
  return { id, goalCode };
}

export async function setRagOverride(
  input: { entityType: 'PROJECT' | 'GOAL'; entityId: string; overrideRag: string; reason: string; calculatedRag: string },
  actor: Actor,
) {
  const { ragOverrides } = await import('@/db/schema');
  const existing = await db
    .select()
    .from(ragOverrides)
    .where(eq(ragOverrides.entityId, input.entityId));
  await db.transaction(async (tx) => {
    for (const e of existing) {
      if (e.active) {
        await tx.update(ragOverrides).set({ active: false }).where(eq(ragOverrides.id, e.id));
      }
    }
    await tx.insert(ragOverrides).values({
      id: newId('ro_'),
      entityType: input.entityType,
      entityId: input.entityId,
      projectId: input.entityType === 'PROJECT' ? input.entityId : null,
      calculatedRag: input.calculatedRag,
      overrideRag: input.overrideRag,
      reason: input.reason,
      userId: actor.id,
      userLabel: actor.label,
      active: true,
      createdAt: new Date(),
    });
    await recordAudit(
      {
        actor,
        entityType: input.entityType,
        entityId: input.entityId,
        action: 'RAG_OVERRIDE',
        field: 'rag',
        oldValue: input.calculatedRag,
        newValue: input.overrideRag,
        reason: input.reason,
        projectId: input.entityType === 'PROJECT' ? input.entityId : null,
      },
      tx,
    );
  });
}

export async function clearRagOverride(entityId: string, actor: Actor) {
  const { ragOverrides } = await import('@/db/schema');
  const existing = await db.select().from(ragOverrides).where(eq(ragOverrides.entityId, entityId));
  await db.transaction(async (tx) => {
    for (const e of existing) {
      if (e.active) {
        await tx.update(ragOverrides).set({ active: false }).where(eq(ragOverrides.id, e.id));
      }
    }
    await recordAudit(
      {
        actor,
        entityType: 'RAG_OVERRIDE',
        entityId,
        action: 'RAG_OVERRIDE',
        field: 'rag',
        newValue: 'cleared',
        reason: 'Override removed; calculated RAG applies',
      },
      tx,
    );
  });
}

export { deliverables, drawings, goals };
