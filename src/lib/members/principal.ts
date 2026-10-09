/**
 * The Principal of a session: who it is and what `can()` (policy.ts) allows,
 * read from the database on every request (a switch turned off applies at once).
 */
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { deliverables, drawingDependencies, drawingImportBatches, drawings, goals, packageDependencies, packageFees, packages, projectMembers, projects } from '@/db/schema';
import type { Permission } from '@/lib/rbac';
import { can, projectsFor, type Action, type Grant, type LegacyRole, type Principal } from './policy';

export async function projectParents(): Promise<Map<string, string | null>> {
  const rows = await db.select({ id: projects.id, parent: projects.parentProjectId }).from(projects);
  return new Map(rows.map((r) => [r.id, r.parent]));
}

export async function grantsOf(memberId: string): Promise<Grant[]> {
  const rows = await db.select().from(projectMembers).where(eq(projectMembers.memberId, memberId));
  return rows.map((r) => ({
    projectId: r.projectId,
    level: r.accessLevel === 'project_admin' ? 'project_admin' : 'member',
    billing: r.swBilling,
    edit: r.swEdit,
    importExport: r.swImportExport,
    planning: r.swPlanning,
  }));
}

export async function memberPrincipal(memberId: string, accountAdmin: boolean): Promise<Principal> {
  const [grants, parentOf] = await Promise.all([accountAdmin ? Promise.resolve([] as Grant[]) : grantsOf(memberId), projectParents()]);
  return { kind: 'member', memberId, accountAdmin, legacyRole: null, grants, parentOf };
}

export function legacyPrincipal(role: LegacyRole, emergency = false): Principal {
  return { kind: 'legacy', memberId: null, accountAdmin: role === 'SUPER_ADMIN' || emergency, legacyRole: role, grants: [], parentOf: new Map() };
}

/**
 * The existing permission checks (lib/rbac) stay in every handler. For a
 * member they follow the switches the member holds anywhere; the project of
 * each row is then checked with `can()`.
 */
export function memberPermissions(p: Principal): Permission[] {
  if (p.accountAdmin) return ['billing.read', 'billing.write'];
  const out = new Set<Permission>();
  if (can(p, 'billing')) ['billing.read', 'billing.write'].forEach((x) => out.add(x as Permission));
  if (can(p, 'edit'))
    (['drawing.write', 'drawing.complete', 'drawing.reschedule', 'drawing.admin', 'project.write', 'schedule.reschedule'] as Permission[]).forEach((x) => out.add(x));
  if (can(p, 'importExport')) (['import.centre', 'export.run'] as Permission[]).forEach((x) => out.add(x));
  if (can(p, 'planning'))
    (
      ['goal.write', 'goal.reschedule', 'deliverable.write', 'deliverable.complete', 'drawing.write', 'drawing.complete', 'drawing.reschedule', 'bulk.update', 'rag.override', 'fy26.write', 'schedule.reschedule', 'export.run'] as Permission[]
    ).forEach((x) => out.add(x));
  return [...out];
}

// ---------------------------------------------------------------------------
// The project a row belongs to (for "A cannot read or write B, even by id")
// ---------------------------------------------------------------------------

export type EntityKind = 'PROJECT' | 'PACKAGE' | 'DRAWING' | 'FEE_LINE' | 'PACKAGE_DEPENDENCY' | 'DRAWING_DEPENDENCY' | 'IMPORT_RUN' | 'GOAL' | 'DELIVERABLE';

export async function projectOf(kind: EntityKind, id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  switch (kind) {
    case 'PROJECT':
      return (await db.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).limit(1))[0]?.id ?? null;
    case 'PACKAGE':
      return (await db.select({ p: packages.projectId }).from(packages).where(eq(packages.id, id)).limit(1))[0]?.p ?? null;
    case 'DRAWING':
      return (await db.select({ p: drawings.projectId }).from(drawings).where(eq(drawings.id, id)).limit(1))[0]?.p ?? null;
    case 'FEE_LINE':
      return (
        (await db.select({ p: packages.projectId }).from(packageFees).innerJoin(packages, eq(packageFees.packageId, packages.id)).where(eq(packageFees.id, id)).limit(1))[0]?.p ?? null
      );
    case 'PACKAGE_DEPENDENCY':
      return (await db.select({ p: packageDependencies.projectId }).from(packageDependencies).where(eq(packageDependencies.id, id)).limit(1))[0]?.p ?? null;
    case 'DRAWING_DEPENDENCY':
      return (await db.select({ p: drawingDependencies.projectId }).from(drawingDependencies).where(eq(drawingDependencies.id, id)).limit(1))[0]?.p ?? null;
    case 'GOAL':
      return (await db.select({ p: goals.projectId }).from(goals).where(eq(goals.id, id)).limit(1))[0]?.p ?? null;
    case 'DELIVERABLE':
      return (await db.select({ p: deliverables.projectId }).from(deliverables).where(eq(deliverables.id, id)).limit(1))[0]?.p ?? null;
    case 'IMPORT_RUN':
      return (await db.select({ p: drawingImportBatches.projectId }).from(drawingImportBatches).where(eq(drawingImportBatches.id, id)).limit(1))[0]?.p ?? null;
  }
}

/** Projects of many records at once (reschedule, bulk). */
export async function projectsOf(kind: string, ids: string[]): Promise<(string | null)[]> {
  if (!ids.length) return [];
  const t = kind === 'DRAWING' ? drawings : kind === 'PACKAGE' ? packages : kind === 'GOAL' ? goals : kind === 'DELIVERABLE' ? deliverables : null;
  if (!t) return ids.map(() => null);
  const rows = await db.select({ id: t.id, p: t.projectId }).from(t).where(inArray(t.id, ids));
  const by = new Map(rows.map((r) => [r.id, r.p]));
  return ids.map((i) => by.get(i) ?? null);
}

/** The projects a person may see for `action`, as a list for SQL (null = all). */
export function scopeList(p: Principal, action: Action): string[] | null {
  const s = projectsFor(p, action);
  return s ? [...s] : null;
}

