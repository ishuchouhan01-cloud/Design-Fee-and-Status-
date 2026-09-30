/**
 * Project List import — full display names and the project → child hierarchy.
 *
 * Any sheet whose header row names a project code / short name and a full name
 * works; the columns are found by their header labels:
 *
 *   Project code | Short name | Full name | Parent project (code or name) | Order
 *
 * A row is matched to an existing project by code, else by short name; a row
 * that matches nothing creates the project (so a group such as "Pursuit of a
 * Radical Rhapsody" can hold its towers). Nothing is renamed by code: the code
 * stays the internal key; screens show the full name. A row without a full
 * name is logged (PROJECT_FULL_NAME_MISSING) and the source name is shown —
 * no name is invented.
 */
import { eq } from 'drizzle-orm';
import { db, type DbLike } from '@/db';
import { importRunChanges, projects } from '@/db/schema';
import { recordAudit, type Actor } from '@/lib/audit';
import { newId } from '@/lib/ids';
import { at, type TextSheet } from './drawing-register/read';
import type { PlanIssue } from './drawing-register/plan';

export interface ProjectListRow {
  row: number;
  code: string | null;
  shortName: string | null;
  fullName: string | null;
  parent: string | null;
  order: number | null;
}

export interface ProjectListParse {
  sheet: string;
  headerRow: number;
  columns: Partial<Record<'code' | 'shortName' | 'fullName' | 'parent' | 'order', number>>;
  rows: ProjectListRow[];
}

const HEADERS: Record<keyof ProjectListParse['columns'], RegExp> = {
  code: /^(project\s*)?code$/i,
  shortName: /^(short\s*name|project|project\s*short\s*name|prj)$/i,
  fullName: /^(full\s*name|project\s*full\s*name|display\s*name|project\s*name\s*\(full\))$/i,
  parent: /^parent(\s*project)?(\s*(code|name))?$/i,
  order: /^(order|sequence|display\s*order)$/i,
};

/** Find the header row (rows 1–10) that names a full-name column; null if the sheet is not a Project List. */
export function detectProjectList(s: TextSheet, overrides: ProjectListParse['columns'] = {}): ProjectListParse | null {
  for (let r = 0; r < Math.min(10, s.rows.length); r++) {
    const row = s.rows[r] ?? [];
    const cols: ProjectListParse['columns'] = {};
    row.forEach((v, c) => {
      if (!v) return;
      for (const [k, re] of Object.entries(HEADERS) as [keyof ProjectListParse['columns'], RegExp][]) if (cols[k] == null && re.test(v.trim())) cols[k] = c;
    });
    Object.assign(cols, overrides);
    if (cols.fullName == null || (cols.code == null && cols.shortName == null)) continue;
    const rows: ProjectListRow[] = [];
    for (let i = r + 1; i < s.rows.length; i++) {
      const x = s.rows[i] ?? [];
      const code = cols.code != null ? at(x, cols.code) : null;
      const shortName = cols.shortName != null ? at(x, cols.shortName) : null;
      if (!code && !shortName) continue;
      const ord = cols.order != null ? Number(at(x, cols.order)) : NaN;
      rows.push({
        row: i + 1,
        code,
        shortName,
        fullName: cols.fullName != null ? at(x, cols.fullName) : null,
        parent: cols.parent != null ? at(x, cols.parent) : null,
        order: Number.isFinite(ord) ? ord : null,
      });
    }
    return { sheet: s.name, headerRow: r + 1, columns: cols, rows };
  }
  return null;
}

export interface ProjectListPlanItem {
  row: ProjectListRow;
  action: 'CREATE' | 'UPDATE' | 'UNCHANGED';
  projectId: string | null;
  code: string;
  displayName: string | null;
  parentCode: string | null;
  changes: string[];
}

export interface ProjectListPlan {
  items: ProjectListPlanItem[];
  issues: PlanIssue[];
  counts: { create: number; update: number; unchanged: number };
}

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export async function planProjectList(parse: ProjectListParse, workbook: string, tx: DbLike = db): Promise<ProjectListPlan> {
  const all = await tx.select().from(projects);
  const byCode = new Map(all.map((p) => [norm(p.projectCode), p]));
  const byName = new Map(all.map((p) => [norm(p.projectName), p]));
  const issues: PlanIssue[] = [];
  const items: ProjectListPlanItem[] = [];
  const planned = new Map<string, ProjectListPlanItem>(); // normalised code / short name → item
  for (const row of parse.rows) {
    const existing = (row.code && byCode.get(norm(row.code))) || (row.shortName && byName.get(norm(row.shortName))) || null;
    const code = existing?.projectCode ?? row.code ?? row.shortName!;
    if (!row.fullName) {
      issues.push({
        severity: 'WARNING',
        code: 'PROJECT_FULL_NAME_MISSING',
        projectCode: code,
        workbook,
        sheet: parse.sheet,
        rowNumber: row.row,
        message: `No full name for ${row.shortName ?? code} in the Project List — the source name "${existing?.projectName ?? row.shortName ?? code}" is shown until one is given.`,
      });
    }
    const item: ProjectListPlanItem = { row, action: existing ? 'UNCHANGED' : 'CREATE', projectId: existing?.id ?? null, code, displayName: row.fullName, parentCode: null, changes: [] };
    items.push(item);
    for (const k of [row.code, row.shortName]) if (k) planned.set(norm(k), item);
  }
  // Parents: another row of this list, or an existing project, by code or name.
  for (const item of items) {
    const p = item.row.parent;
    if (!p) continue;
    const target = planned.get(norm(p)) ?? null;
    const existing = byCode.get(norm(p)) ?? byName.get(norm(p)) ?? null;
    const parentCode = target?.code ?? existing?.projectCode ?? null;
    if (!parentCode) {
      issues.push({
        severity: 'WARNING',
        code: 'PROJECT_PARENT_NOT_FOUND',
        projectCode: item.code,
        workbook,
        sheet: parse.sheet,
        rowNumber: item.row.row,
        message: `Parent "${p}" of ${item.code} is neither in the Project List nor an existing project — no parent set.`,
      });
      continue;
    }
    if (parentCode === item.code) continue;
    item.parentCode = parentCode;
  }
  // Projects the list does not name keep showing their source name; say so, once each.
  const listed = new Set(items.map((i) => i.projectId).filter(Boolean));
  for (const p of all) {
    if (listed.has(p.id) || p.displayName) continue;
    issues.push({
      severity: 'INFO',
      code: 'PROJECT_FULL_NAME_MISSING',
      projectCode: p.projectCode,
      workbook,
      sheet: parse.sheet,
      message: `${p.projectCode} is not in the Project List, so it has no full name; its source name "${p.projectName}" is shown.`,
    });
  }
  for (const item of items) {
    const cur = item.projectId ? all.find((x) => x.id === item.projectId)! : null;
    if (!cur) continue;
    const parent = item.parentCode ? all.find((x) => x.projectCode === item.parentCode) ?? null : null;
    if (item.displayName && item.displayName !== cur.displayName) item.changes.push('displayName');
    if (item.parentCode && (parent?.id ?? `new:${item.parentCode}`) !== cur.parentProjectId) item.changes.push('parentProjectId');
    if (item.row.order != null && item.row.order !== cur.displayOrder) item.changes.push('displayOrder');
    item.action = item.changes.length ? 'UPDATE' : 'UNCHANGED';
  }
  return {
    items,
    issues,
    counts: {
      create: items.filter((i) => i.action === 'CREATE').length,
      update: items.filter((i) => i.action === 'UPDATE').length,
      unchanged: items.filter((i) => i.action === 'UNCHANGED').length,
    },
  };
}

/** Write the plan (inside the caller's transaction). Existing projects keep their id and code. */
export async function applyProjectList(tx: DbLike, plan: ProjectListPlan, batchId: string, actor: Actor) {
  const stamp = new Date();
  const idOf = new Map<string, string>();
  for (const p of await tx.select({ id: projects.id, code: projects.projectCode }).from(projects)) idOf.set(p.code, p.id);
  for (const item of plan.items.filter((i) => i.action === 'CREATE')) {
    const id = newId('pr_');
    await tx.insert(projects).values({
      id,
      projectCode: item.code,
      projectName: item.row.shortName ?? item.displayName ?? item.code,
      displayName: item.displayName,
      displayOrder: item.row.order,
      createdImportBatchId: batchId,
      updatedAt: stamp,
    });
    idOf.set(item.code, id);
    await recordAudit({ actor, entityType: 'PROJECT', entityId: id, entityLabel: item.displayName ?? item.code, action: 'CREATE', reason: 'Project List import' }, tx);
  }
  for (const item of plan.items) {
    const id = idOf.get(item.code)!;
    const set: Partial<typeof projects.$inferInsert> = {};
    if (item.displayName) set.displayName = item.displayName;
    if (item.parentCode) set.parentProjectId = idOf.get(item.parentCode) ?? null;
    if (item.row.order != null) set.displayOrder = item.row.order;
    if (item.action === 'UPDATE') {
      const [before] = await tx.select().from(projects).where(eq(projects.id, id)).limit(1);
      await tx.update(projects).set({ ...set, updatedAt: stamp }).where(eq(projects.id, id));
      for (const f of item.changes) {
        await tx.insert(importRunChanges).values({
          id: newId('irc_'),
          batchId,
          entityType: 'PROJECT',
          entityId: id,
          field: f,
          oldValue: (before as Record<string, unknown>)[f] == null ? null : String((before as Record<string, unknown>)[f]),
          newValue: (set as Record<string, unknown>)[f] == null ? null : String((set as Record<string, unknown>)[f]),
        });
        await recordAudit(
          {
            actor,
            entityType: 'PROJECT',
            entityId: id,
            entityLabel: item.displayName ?? item.code,
            action: 'UPDATE',
            field: f,
            oldValue: String((before as Record<string, unknown>)[f] ?? ''),
            newValue: String((set as Record<string, unknown>)[f] ?? ''),
            reason: 'Project List import',
          },
          tx,
        );
      }
    } else if (item.action === 'CREATE' && item.parentCode) {
      await tx.update(projects).set({ parentProjectId: idOf.get(item.parentCode) ?? null }).where(eq(projects.id, id));
    }
  }
}
