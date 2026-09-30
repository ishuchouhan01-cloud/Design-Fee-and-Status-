/**
 * Editing, auditing and import-protection for Design Goals FY 26.
 *
 * Populates the module itself rather than relying on `fy26-import.test.ts`:
 * vitest orders files alphabetically, so `fy26-crud` runs BEFORE `fy26-import`.
 * The import is idempotent, so running it here costs nothing when the other
 * file has already run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { fy26PackageDependencies, fy26PackageRevisions, fy26Packages } from '@/db/schema';
import { auditForEntity } from '@/lib/audit';
import { runFy26Import } from '@/lib/import/design-goals-fy26';
import { getFy26Package, listDependencies, listFy26Packages } from '@/lib/services/fy26';
import {
  createFy26Dependency,
  deleteFy26Dependency,
  updateFy26Dependency,
  updateFy26Package,
} from '@/lib/services/fy26-updates';
import { can } from '@/lib/rbac';
import {
  fy26DependencyUpdateSchema,
  fy26PackageUpdateSchema,
  rejectForbiddenFields,
} from '@/lib/validation';

const SOURCE_DIR = path.resolve(process.cwd(), process.env.FY26_SOURCE_DIR ?? 'data/fy26');
const available = fs.existsSync(SOURCE_DIR) && fs.readdirSync(SOURCE_DIR).some((f) => f.endsWith('.xlsx'));

const actor = { id: null, label: 'Test user (ADMIN)' };

beforeAll(async () => {
  if (!available) return;
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(fy26Packages);
  if (n === 0) await runFy26Import({ sourceDir: SOURCE_DIR, apply: true, actor });
}, 300_000);

async function aPackage() {
  const [row] = await db
    .select()
    .from(fy26Packages)
    .where(sql`${fy26Packages.currentExpectedReleaseDate} is not null`)
    .limit(1);
  return row;
}

describe.skipIf(!available)('FY26 validation boundary', () => {
  it('refuses percentages and baseline dates before Zod sees them', () => {
    expect(() => rejectForbiddenFields({ completionPercent: 65 })).toThrow(/percentages do not exist/);
    expect(() => rejectForbiddenFields({ baselineReleaseDate: '2026-01-01' })).toThrow(/immutable/);
  });

  it('refuses any completion value other than the two', () => {
    expect(() => fy26PackageUpdateSchema.parse({ completionStatus: 'IN_PROGRESS' })).toThrow();
    expect(() => fy26PackageUpdateSchema.parse({ completionStatus: '50%' })).toThrow();
    expect(fy26PackageUpdateSchema.parse({ completionStatus: 'COMPLETED' }).completionStatus).toBe('COMPLETED');
  });

  it('has no billing-date field anywhere in the package schema', () => {
    expect(() => fy26PackageUpdateSchema.parse({ billingDate: '2026-01-01' })).toThrow();
    const columns = Object.keys(fy26Packages);
    expect(columns.filter((c) => /billingdate/i.test(c))).toHaveLength(0);
  });

  it('accepts a dependency with no step label', () => {
    const parsed = fy26DependencyUpdateSchema.parse({ stepLabel: null, description: 'x' });
    expect(parsed.stepLabel).toBeNull();
  });

  it('gives Viewer read but not write, and reserves import for Admin', () => {
    expect(can('VIEWER', 'fy26.read')).toBe(true);
    expect(can('VIEWER', 'fy26.write')).toBe(false);
    expect(can('EDITOR', 'fy26.write')).toBe(true);
    expect(can('MANAGER', 'fy26.import')).toBe(false);
    expect(can('ADMIN', 'fy26.import')).toBe(true);
  });
});

describe.skipIf(!available)('FY26 package editing', () => {
  it('moves the expected date, leaves the baseline alone and audits the change', async () => {
    const before = await aPackage();
    const original = before.baselineReleaseDate;
    const newDate = new Date(Date.UTC(2027, 5, 30));

    const result = await updateFy26Package(
      before.id,
      { currentExpectedReleaseDate: newDate, reason: 'Client pushed the release' },
      actor,
    );
    expect(result.changes.map((c) => c.field)).toContain('currentExpectedReleaseDate');

    const after = await getFy26Package(before.id);
    expect(after!.currentExpectedReleaseDate?.toISOString()).toBe(newDate.toISOString());
    expect(after!.baselineReleaseDate?.toISOString()).toBe(original?.toISOString());

    const audit = await auditForEntity('FY26_PACKAGE', before.id);
    const entry = audit.find((a) => a.field === 'currentExpectedReleaseDate');
    expect(entry).toBeDefined();
    expect(entry!.reason).toBe('Client pushed the release');
    expect(entry!.oldValue).not.toBe(entry!.newValue);

    const revisions = await db
      .select()
      .from(fy26PackageRevisions)
      .where(eq(fy26PackageRevisions.fy26PackageId, before.id));
    expect(revisions.length).toBeGreaterThan(0);
  });

  it('refuses to write the baseline through the update path', async () => {
    const pkg = await aPackage();
    await expect(
      updateFy26Package(pkg.id, { baselineReleaseDate: new Date() } as never, actor),
    ).rejects.toThrow(/immutable/i);
  });

  it('edits a billing amount and audits it', async () => {
    const pkg = await aPackage();
    const result = await updateFy26Package(pkg.id, { planBillingCr: 1.2345, reason: 'Fee revision' }, actor);
    expect(result.changes.find((c) => c.field === 'planBillingCr')?.newValue).toBe('1.2345');

    const after = await getFy26Package(pkg.id);
    expect(after!.planBillingCr).toBeCloseTo(1.2345, 6);

    const audit = await auditForEntity('FY26_PACKAGE', pkg.id);
    expect(audit.some((a) => a.field === 'planBillingCr' && a.reason === 'Fee revision')).toBe(true);
  });

  it('records completion as COMPLETE, not as a percentage', async () => {
    const pkg = await aPackage();
    await updateFy26Package(pkg.id, { completionStatus: 'COMPLETED' }, actor);
    const audit = await auditForEntity('FY26_PACKAGE', pkg.id);
    expect(audit.some((a) => a.action === 'COMPLETE')).toBe(true);
    await updateFy26Package(pkg.id, { completionStatus: 'NOT_COMPLETED' }, actor);
  });

  it('protects an edited field from the next import', async () => {
    const pkg = await aPackage();
    await updateFy26Package(pkg.id, { remarks: 'Edited in the application', reason: 'manual note' }, actor);

    const [marked] = await db.select().from(fy26Packages).where(eq(fy26Packages.id, pkg.id)).limit(1);
    expect(marked.userEditedFields.split(',')).toContain('remarks');

    const rerun = await runFy26Import({ sourceDir: SOURCE_DIR, apply: true, actor });
    expect(rerun.protectedFields).toBeGreaterThan(0);
    expect(rerun.issues.some((i) => i.code === 'FIELD_PROTECTED_USER_EDIT')).toBe(true);

    const [after] = await db.select().from(fy26Packages).where(eq(fy26Packages.id, pkg.id)).limit(1);
    expect(after.remarks).toBe('Edited in the application');
  }, 300_000);
});

describe.skipIf(!available)('FY26 dependencies', () => {
  it('adds a dependency without touching the parent package', async () => {
    const pkg = await aPackage();
    const [pkgBefore] = await db.select().from(fy26Packages).where(eq(fy26Packages.id, pkg.id)).limit(1);

    const { id } = await createFy26Dependency(
      {
        fy26PackageId: pkg.id,
        description: 'Receive structural details',
        targetDate: new Date(Date.UTC(2026, 9, 12)),
        responsibleText: 'Gagan',
        remarks: 'Blocked on AR',
      },
      actor,
    );

    const deps = await listDependencies(pkg.id);
    const added = deps.find((d) => d.id === id)!;
    expect(added.description).toBe('Receive structural details');
    expect(added.isManual).toBe(true);
    expect(added.stepLabel).toBeNull();

    const [pkgAfter] = await db.select().from(fy26Packages).where(eq(fy26Packages.id, pkg.id)).limit(1);
    expect(pkgAfter.packageDescription).toBe(pkgBefore.packageDescription);
    expect(pkgAfter.currentExpectedReleaseDate?.toISOString()).toBe(
      pkgBefore.currentExpectedReleaseDate?.toISOString(),
    );
    expect(pkgAfter.planBillingCr).toBe(pkgBefore.planBillingCr);

    const audit = await auditForEntity('FY26_DEPENDENCY', id);
    expect(audit.some((a) => a.action === 'CREATE')).toBe(true);
  });

  it('edits a dependency without modifying its package', async () => {
    const pkg = await aPackage();
    const deps = await listDependencies(pkg.id);
    const target = deps[0];
    const [pkgBefore] = await db.select().from(fy26Packages).where(eq(fy26Packages.id, pkg.id)).limit(1);

    await updateFy26Dependency(target.id, { description: 'Revised task text', reason: 'clarity' }, actor);

    const [pkgAfter] = await db.select().from(fy26Packages).where(eq(fy26Packages.id, pkg.id)).limit(1);
    expect(pkgAfter.updatedAt?.toISOString()).toBe(pkgBefore.updatedAt?.toISOString());

    const audit = await auditForEntity('FY26_DEPENDENCY', target.id);
    expect(audit.some((a) => a.field === 'description' && a.newValue === 'Revised task text')).toBe(true);
  });

  it('deletes a dependency and audits it', async () => {
    const pkg = await aPackage();
    const { id } = await createFy26Dependency(
      { fy26PackageId: pkg.id, description: 'Temporary task' },
      actor,
    );
    await deleteFy26Dependency(id, actor, 'no longer needed');

    const [row] = await db
      .select()
      .from(fy26PackageDependencies)
      .where(eq(fy26PackageDependencies.id, id))
      .limit(1);
    expect(row).toBeUndefined();

    const audit = await auditForEntity('FY26_DEPENDENCY', id);
    expect(audit.some((a) => a.action === 'DELETE' && a.reason === 'no longer needed')).toBe(true);
  });

  it('keeps a manually added dependency through a re-import', async () => {
    const pkg = await aPackage();
    const { id } = await createFy26Dependency(
      { fy26PackageId: pkg.id, description: 'Survives re-import' },
      actor,
    );
    await runFy26Import({ sourceDir: SOURCE_DIR, apply: true, actor });

    const [row] = await db
      .select()
      .from(fy26PackageDependencies)
      .where(eq(fy26PackageDependencies.id, id))
      .limit(1);
    expect(row?.description).toBe('Survives re-import');
    expect(row?.isManual).toBe(true);
  }, 300_000);
});

describe.skipIf(!available)('FY26 queries', () => {
  it('searches case-insensitively', async () => {
    const [sample] = await db
      .select({ d: fy26Packages.packageDescription })
      .from(fy26Packages)
      .where(sql`${fy26Packages.packageDescription} ~ '[A-Za-z]{6}'`)
      .limit(1);
    const term = sample.d.slice(0, 6);

    const lower = await listFy26Packages({ search: term.toLowerCase() });
    const upper = await listFy26Packages({ search: term.toUpperCase() });
    expect(lower.total).toBeGreaterThan(0);
    expect(upper.total).toBe(lower.total);
  });

  it('filters by dependency presence', async () => {
    const withDeps = await listFy26Packages({ hasDependencies: 'YES' });
    const without = await listFy26Packages({ hasDependencies: 'NO' });
    const all = await listFy26Packages({});
    expect(withDeps.total + without.total).toBe(all.total);
    expect(withDeps.total).toBeGreaterThan(0);
  });

  it('filters by project and by phase', async () => {
    const [pkg] = await db
      .select()
      .from(fy26Packages)
      .where(sql`${fy26Packages.fy26PhaseId} is not null`)
      .limit(1);
    const byProject = await listFy26Packages({ projectId: pkg.fy26ProjectId });
    const byPhase = await listFy26Packages({ phaseId: pkg.fy26PhaseId! });
    expect(byProject.total).toBeGreaterThanOrEqual(byPhase.total);
    expect(byPhase.total).toBeGreaterThan(0);
    expect(byPhase.rows.every((r) => r.phaseId === pkg.fy26PhaseId)).toBe(true);
  });
});
