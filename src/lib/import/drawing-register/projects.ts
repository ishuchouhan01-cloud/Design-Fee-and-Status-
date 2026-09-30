/**
 * The project hierarchy a drawing import implies, from the manifest's
 * `projects` list (data, never code): a group project and the display names
 * and parent of the projects its registers belong to.
 *
 * The same planner and writer as the Project List import are used, so every
 * change is recorded (import_run_changes + audit) and undone with the import.
 * Only empty values are filled: a name or parent set by a Project List import
 * or by a user is never replaced.
 */
import { db, type DbLike } from '@/db';
import { projects } from '@/db/schema';
import type { Actor } from '@/lib/audit';
import { applyProjectList, planProjectList, type ProjectListPlan } from '../project-list';
import type { DrawingManifest } from './manifest';

export async function planManifestProjects(manifest: DrawingManifest, tx: DbLike = db): Promise<ProjectListPlan | null> {
  if (!manifest.projects.length) return null;
  const rows = manifest.projects.map((p, i) => ({ row: i + 1, code: p.code, shortName: null, fullName: p.name, parent: p.parent ?? null, order: p.order ?? null }));
  const plan = await planProjectList({ sheet: 'manifest', headerRow: 0, columns: {}, rows }, `manifest:${manifest.name}`, tx);
  const all = await tx.select().from(projects);
  for (const item of plan.items) {
    const cur = item.projectId ? all.find((x) => x.id === item.projectId) : null;
    if (!cur) continue;
    // Fill only what is empty.
    if (cur.displayName) item.displayName = null;
    if (cur.parentProjectId) item.parentCode = null;
    if (cur.displayOrder != null) item.row.order = null;
    item.changes = item.changes.filter((f) => (f === 'displayName' ? !cur.displayName : f === 'parentProjectId' ? !cur.parentProjectId : cur.displayOrder == null));
    item.action = item.changes.length ? 'UPDATE' : 'UNCHANGED';
  }
  plan.issues = plan.issues.filter((i) => i.code !== 'PROJECT_FULL_NAME_MISSING' || manifest.projects.some((p) => p.code === i.projectCode));
  plan.counts = {
    create: plan.items.filter((i) => i.action === 'CREATE').length,
    update: plan.items.filter((i) => i.action === 'UPDATE').length,
    unchanged: plan.items.filter((i) => i.action === 'UNCHANGED').length,
  };
  return plan;
}

/** Plan and write (inside the caller's transaction). Returns what changed. */
export async function applyManifestProjects(tx: DbLike, manifest: DrawingManifest, batchId: string, actor: Actor) {
  const plan = await planManifestProjects(manifest, tx);
  if (!plan) return { create: 0, update: 0, unchanged: 0 };
  if (plan.counts.create || plan.counts.update) await applyProjectList(tx, plan, batchId, actor);
  return plan.counts;
}
