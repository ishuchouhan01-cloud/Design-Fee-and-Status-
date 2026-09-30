/**
 * DFS — Design Fee Schedule.
 *
 *   Project → [child project: Tower / Product] → [Phase] → Tower / Product /
 *   Block / Villa / Group (base-DFS headings) → Package → Discipline → Drawing
 *
 * Every level comes from a record: projects (and their parent project), the
 * base-DFS headings (dfs_wbs_nodes), packages, the discipline of each drawing
 * (grouped by disciplines.dfs_group) and the drawings. A level that has no
 * record is not shown.
 *
 * Status is binary and comes only from the drawings:
 *   package     Complete when it has at least one drawing and every one is
 *               released; otherwise Pending (also when it has none in the
 *               register). Not Applicable only when every fee line of the package
 *               is explicitly NA and it has no drawings.
 *   discipline  the same rule, over the package's drawings of that discipline.
 *
 * Counting:
 *   Packages Complete  package records only — never towers, disciplines or
 *                      drawings — each counted once, under exactly one parent.
 *   Drawings Released  drawings, each counted once.
 * So every parent row is the sum of its children.
 *
 * Billing (DFS Summary) is per package × discipline:
 *   Total = the fee of the line (package_fees.fee_value)
 *   Billed = Total of lines whose discipline status is Complete
 *   Unbilled = Total − Billed
 * Billing (Project Drawing Status, Admin): Total = the fee (scope), Billed =
 * the amount billed to date (package_fees.billed_to_date_value), Unbilled =
 * Total − Billed, summed package → discipline → tower → project with each
 * package once. Archived rows are left out everywhere.
 *
 * All counting is done in SQL (grouped by project, package and discipline
 * group); nothing is cached, so a Drawing Control edit shows on the next load.
 */
import { and, asc, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db';
import { dfsWbsNodes, disciplines, drawings, packageFees, packages, projects, users } from '@/db/schema';
import { disciplineLabel, NODE_TYPE_LABEL, projectLabel, quarterLabel } from '@/lib/labels';
import { formatDate } from '@/lib/format';
import { calendarQuarter, calendarQuarterOf, fiscalQuarterOf } from '@/lib/periods';
import { drawingScheduleStatusSql, drawingWhere, parseDrawingFilters, type DrawingFilters } from './drawing-register';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** COMPLETE | NOT_COMPLETE (shown as "Pending") | NA. */
export type UnitStatus = 'COMPLETE' | 'NOT_COMPLETE' | 'NA';

/** The package slot of drawings that no package holds. Never counted as a package. */
export const NO_PACKAGE = 'none';

/** The main discipline groups, in display order; any other group follows. */
const GROUP_ORDER = ['AR', 'ST', 'MEP', 'LS'];
const byGroup = (a: string, b: string) => {
  const ia = GROUP_ORDER.indexOf(a);
  const ib = GROUP_ORDER.indexOf(b);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
};

export interface DrawingCounts {
  drawings: number;
  released: number;
  notYetNumbered: number;
  delayed: number;
  dueSoon: number;
  /** Released drawings with no actual release date. */
  releasedNoDate: number;
  lastRelease: Date | null;
  latestExpected: Date | null;
}

export interface DfsUnit {
  key: string;
  projectId: string;
  packageKey: string;
  packageId: string | null;
  group: string;
  groupName: string;
  status: UnitStatus;
  /** NO_DRAWINGS · BILLED_BEFORE_COMPLETION · COMPLETE_NOT_FULLY_BILLED */
  flags: string[];
  /** Every drawing of the unit (status is computed from these). */
  all: DrawingCounts;
  /** The drawings matching the drawing filters (equals `all` without filters). */
  shown: DrawingCounts;
  scope: number | null;
  actual: number;
  billedSource: number | null;
  releaseDate: Date | null;
}

export interface DfsPackage {
  key: string;
  projectId: string;
  packageId: string | null;
  code: string;
  name: string;
  responsible: string | null;
  expectedDate: Date | null;
  wbsNodeId: string | null;
  sequence: number;
  status: UnitStatus;
  noDrawings: boolean;
  releaseDate: Date | null;
  units: DfsUnit[];
  /** Matches the filters (package status, discipline, search). */
  visible: boolean;
}

export interface DfsFilters extends DrawingFilters {
  /** Package Status: COMPLETE | NOT_COMPLETE | NA */
  unitStatus?: string;
  /** A base-DFS heading: only packages under it (DFS Summary). */
  nodeId?: string;
}

export type DfsRowKind = 'PROJECT' | 'NODE' | 'PACKAGE' | 'NO_PACKAGE' | 'DISCIPLINE';

/** One row of the DFS table. */
export interface DfsRow {
  key: string;
  parentKey: string | null;
  kind: DfsRowKind;
  depth: number;
  name: string;
  /** "Tower", "Product", "Block" … for headings and child projects. */
  typeLabel: string | null;
  code: string | null;
  hasChildren: boolean;
  /** Package and discipline rows. */
  status: UnitStatus | null;
  noDrawings: boolean;
  releaseDate: string | null;
  /** Aggregate rows (project, heading) — package records under the row. */
  packagesComplete: number;
  packagesPending: number;
  packagesNa: number;
  packagesTotal: number;
  drawingsReleased: number;
  drawingsTotal: number;
  /** Discipline rows: the key for its drawings. */
  unitKey: string | null;
  /** The records behind the row (Edit Mode). */
  projectId: string | null;
  packageId: string | null;
  group: string | null;
  /** Responsible Person (package rows; other rows only when set). */
  responsible: string | null;
  /** The package's expected release date (package rows). */
  expectedDate: string | null;
  /** Total (scope), Billed (to date), Unbilled — Admin and Super Admin only; removed for other roles. */
  billing: { total: number; billed: number; unbilled: number } | null;
  /** ELIGIBLE_AFTER_COMPLETION · BILLED_BEFORE_COMPLETION */
  billingFlags: string[];
}

export interface DfsModel {
  rows: Map<string, DfsRow>;
  children: Map<string, string[]>;
  roots: string[];
  units: DfsUnit[];
  packages: DfsPackage[];
  filtered: boolean;
}

// ---------------------------------------------------------------------------
// Discipline groups (disciplines.dfs_group)
// ---------------------------------------------------------------------------

async function disciplineGroups() {
  const rows = await db.select({ id: disciplines.id, code: disciplines.code, name: disciplines.name, group: disciplines.dfsGroup }).from(disciplines);
  const groupOf = new Map<string, string>(rows.map((r) => [r.code, r.group ?? r.code]));
  const nameOfCode = new Map(rows.map((r) => [r.code, r.name]));
  const nameOf = (g: string) => (g === 'NONE' ? disciplineLabel(null) : disciplineLabel(g, nameOfCode.get(g)));
  const membersOf = (g: string) => rows.filter((r) => (r.group ?? r.code) === g).map((r) => r.id);
  return { rows, groupOf, nameOf, membersOf };
}

/** The SQL group of a drawing's discipline. */
const GROUP_SQL = sql<string>`coalesce(${disciplines.dfsGroup}, ${disciplines.code}, 'NONE')`;

export function unitKey(projectId: string, packageKey: string, group: string) {
  return `${projectId}|${packageKey}|${group}`;
}

export function parseUnitKey(key: string): { projectId: string; packageKey: string; group: string } | null {
  const i = key.indexOf('|');
  const j = key.lastIndexOf('|');
  if (i < 0 || j <= i) return null;
  return { projectId: key.slice(0, i), packageKey: key.slice(i + 1, j), group: key.slice(j + 1) };
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

const DRAWING_FILTER_KEYS: (keyof DrawingFilters)[] = ['search', 'release', 'scheduleStatus', 'numberStatus', 'releaseDate', 'responsibleId', 'responsible', 'batchCode', 'dateFrom', 'dateTo', 'rescheduled'];

export function hasDrawingFilter(f: DfsFilters) {
  return DRAWING_FILTER_KEYS.some((k) => f[k] !== undefined && f[k] !== '');
}

/** Drawing-level WHERE of the DFS filters. Search also matches the drawing's package and project. */
function dfsDrawingWhere(f: DfsFilters, projectIds: string[] | null): SQL | undefined {
  const { search, ...rest } = f;
  const c: (SQL | undefined)[] = [drawingWhere({ ...rest, projectId: undefined, disciplineId: undefined, packageId: undefined, phaseId: undefined })];
  if (projectIds) c.push(inArray(drawings.projectId, projectIds));
  if (search) {
    const s = `%${search}%`;
    c.push(
      or(
        drawingWhere({ search }),
        inArray(
          drawings.packageId,
          db
            .select({ id: packages.id })
            .from(packages)
            .where(or(ilike(packages.packageCode, s), ilike(packages.packageName, s), ilike(packages.responsibleText, s), sql`exists (select 1 from users ru where ru.id = ${packages.responsibleUserId} and ru.name ilike ${s})`)),
        ),
        inArray(
          drawings.projectId,
          db.select({ id: projects.id }).from(projects).where(or(ilike(projects.displayName, s), ilike(projects.projectName, s), ilike(projects.projectCode, s))),
        ),
      ),
    );
  }
  const list = c.filter(Boolean) as SQL[];
  return list.length ? and(...list) : undefined;
}

// ---------------------------------------------------------------------------
// Load (SQL aggregates)
// ---------------------------------------------------------------------------

async function unitCounts(where: SQL | undefined) {
  const status = drawingScheduleStatusSql();
  const released = sql`${drawings.completionStatus} = 'COMPLETED'`;
  return db
    .select({
      projectId: drawings.projectId,
      packageId: drawings.packageId,
      group: GROUP_SQL,
      drawings: sql<number>`count(*)::int`,
      released: sql<number>`(count(*) filter (where ${released}))::int`,
      notYetNumbered: sql<number>`(count(*) filter (where ${drawings.numberStatus} = 'NOT_YET_NUMBERED'))::int`,
      delayed: sql<number>`(count(*) filter (where ${status} = 'DELAYED'))::int`,
      dueSoon: sql<number>`(count(*) filter (where ${status} = 'DUE_SOON'))::int`,
      releasedNoDate: sql<number>`(count(*) filter (where ${released} and ${drawings.actualReleaseDate} is null))::int`,
      lastRelease: sql<Date | null>`max(${drawings.actualReleaseDate}) filter (where ${released})`.mapWith(drawings.actualReleaseDate),
      latestExpected: sql<Date | null>`max(${drawings.currentExpectedReleaseDate})`.mapWith(drawings.currentExpectedReleaseDate),
    })
    .from(drawings)
    .leftJoin(disciplines, eq(drawings.disciplineId, disciplines.id))
    .where(where)
    .groupBy(drawings.projectId, drawings.packageId, GROUP_SQL);
}

const zero = (): DrawingCounts => ({ drawings: 0, released: 0, notYetNumbered: 0, delayed: 0, dueSoon: 0, releasedNoDate: 0, lastRelease: null, latestExpected: null });

function addCounts(a: DrawingCounts, b: DrawingCounts): DrawingCounts {
  const max = (x: Date | null, y: Date | null) => (x && y ? (x > y ? x : y) : x ?? y);
  return {
    drawings: a.drawings + b.drawings,
    released: a.released + b.released,
    notYetNumbered: a.notYetNumbered + b.notYetNumbered,
    delayed: a.delayed + b.delayed,
    dueSoon: a.dueSoon + b.dueSoon,
    releasedNoDate: a.releasedNoDate + b.releasedNoDate,
    lastRelease: max(a.lastRelease, b.lastRelease),
    latestExpected: max(a.latestExpected, b.latestExpected),
  };
}

/** Complete when there is at least one drawing and all are released. */
function statusOf(c: DrawingCounts, explicitNa: boolean): UnitStatus {
  if (c.drawings === 0) return explicitNa ? 'NA' : 'NOT_COMPLETE';
  return c.released === c.drawings ? 'COMPLETE' : 'NOT_COMPLETE';
}

/** The last release date, only when every release is dated. */
function releaseDateOf(status: UnitStatus, c: DrawingCounts): Date | null {
  return status === 'COMPLETE' && c.releasedNoDate === 0 ? c.lastRelease : null;
}

/** A project and every project below it. */
export async function projectScope(projectId?: string | null) {
  // Archived towers / products (and what is below them) are left out.
  const every = await db.select().from(projects);
  const archived = new Set(every.filter((p) => p.archivedAt).map((p) => p.id));
  for (let grew = archived.size > 0; grew; ) {
    grew = false;
    for (const p of every) {
      if (p.parentProjectId && archived.has(p.parentProjectId) && !archived.has(p.id)) {
        archived.add(p.id);
        grew = true;
      }
    }
  }
  const all = archived.size ? every.filter((p) => !archived.has(p.id)) : every;
  if (!projectId && archived.size) return { all, ids: all.map((p) => p.id) as string[] | null };
  if (!projectId) return { all, ids: null as string[] | null };
  const ids = new Set([projectId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of all) {
      if (p.parentProjectId && ids.has(p.parentProjectId) && !ids.has(p.id)) {
        ids.add(p.id);
        grew = true;
      }
    }
  }
  return { all, ids: [...ids] };
}

/**
 * Every package and package × discipline unit in scope. Status is computed
 * over all of a unit's drawings; the drawing filters decide what is counted
 * and listed.
 */
export async function loadDfs(f: DfsFilters = {}) {
  const { all: allProjects, ids } = await projectScope(f.projectId);
  const groups = await disciplineGroups();
  const drawingFilter = hasDrawingFilter(f);
  const live = and(isNull(drawings.archivedAt), sql`not exists (select 1 from ${packages} ap where ap.id = ${drawings.packageId} and ap.archived_at is not null)`);
  const [full, filtered, pkgs, fees, nodes, people] = await Promise.all([
    unitCounts(and(live, ids ? inArray(drawings.projectId, ids) : undefined)),
    drawingFilter ? unitCounts(and(live, dfsDrawingWhere(f, ids))) : Promise.resolve(null),
    db.select().from(packages).where(and(isNull(packages.archivedAt), ids ? inArray(packages.projectId, ids) : undefined)),
    db
      .select({
        packageId: packageFees.packageId,
        group: GROUP_SQL,
        fee: sql<number | null>`sum(${packageFees.feeValue})`.mapWith(Number),
        billed: sql<number | null>`sum(${packageFees.billedToDateValue})`.mapWith(Number),
        lines: sql<number>`count(*)::int`,
        na: sql<number>`(count(*) filter (where ${packageFees.applicability} = 'NA'))::int`,
        manual: sql<number>`(count(*) filter (where position('added' in ${packageFees.userEditedFields}) > 0))::int`,
      })
      .from(packageFees)
      .innerJoin(packages, eq(packageFees.packageId, packages.id))
      .innerJoin(disciplines, eq(packageFees.disciplineId, disciplines.id))
      .where(and(isNull(packages.archivedAt), ids ? inArray(packages.projectId, ids) : undefined))
      .groupBy(packageFees.packageId, GROUP_SQL),
    db
      .select()
      .from(dfsWbsNodes)
      .where(ids ? inArray(dfsWbsNodes.projectId, ids) : undefined)
      .orderBy(asc(dfsWbsNodes.sequence)),
    db.select({ id: users.id, name: users.name }).from(users).where(sql`exists (select 1 from ${packages} rp where rp.responsible_user_id = ${users.id})`),
  ]);
  const personName = new Map(people.map((u) => [u.id, u.name]));
  const responsibleOf = (p: (typeof pkgs)[number] | null) => (p ? (p.responsibleUserId ? personName.get(p.responsibleUserId) ?? p.responsibleText : p.responsibleText) ?? null : null);
  const responsibleFilter = f.responsible?.toLowerCase() ?? null;

  const pkgById = new Map(pkgs.map((p) => [p.id, p]));
  interface Acc {
    projectId: string;
    packageKey: string;
    group: string;
    all: DrawingCounts;
    shown: DrawingCounts;
    fee: (typeof fees)[number] | null;
  }
  const acc = new Map<string, Acc>();
  const get = (projectId: string, packageKey: string, group: string) => {
    const k = unitKey(projectId, packageKey, group);
    let a = acc.get(k);
    if (!a) acc.set(k, (a = { projectId, packageKey, group, all: zero(), shown: zero(), fee: null }));
    return a;
  };
  const pk = (id: string | null) => (id && pkgById.has(id) ? id : NO_PACKAGE);
  for (const r of full) {
    const a = get(r.projectId, pk(r.packageId), r.group);
    a.all = addCounts(a.all, r);
  }
  for (const r of filtered ?? full) {
    const a = get(r.projectId, pk(r.packageId), r.group);
    a.shown = addCounts(a.shown, r);
  }
  for (const fee of fees) {
    const p = pkgById.get(fee.packageId)!;
    const k = unitKey(p.projectId, p.id, fee.group);
    // A fee line with nothing to bill and no drawings is not a unit — unless explicitly NA.
    // A discipline added in Edit Mode shows even before it has a fee or drawings.
    if (!acc.has(k) && !(fee.fee ?? 0) && !fee.na && !fee.manual) continue;
    get(p.projectId, p.id, fee.group).fee = fee;
  }

  const units: DfsUnit[] = [];
  for (const [key, a] of acc) {
    const explicitNa = !!a.fee && a.fee.na === a.fee.lines;
    const status = statusOf(a.all, explicitNa);
    const flags: string[] = [];
    if (a.all.drawings === 0 && status !== 'NA') flags.push('NO_DRAWINGS');
    const noPackage = a.packageKey === NO_PACKAGE;
    const scope = noPackage || status === 'NA' ? null : (a.fee?.fee ?? null);
    const billedSource = noPackage ? null : (a.fee?.billed ?? null);
    if ((billedSource ?? 0) > 1e-6 && status === 'NOT_COMPLETE') flags.push('BILLED_BEFORE_COMPLETION');
    if (status === 'COMPLETE' && (scope ?? 0) > 1e-6 && (billedSource ?? 0) + 1e-6 < (scope ?? 0)) flags.push('COMPLETE_NOT_FULLY_BILLED');
    units.push({
      key,
      projectId: a.projectId,
      packageKey: a.packageKey,
      packageId: noPackage ? null : a.packageKey,
      group: a.group,
      groupName: groups.nameOf(a.group),
      status,
      flags,
      all: a.all,
      shown: a.shown,
      scope,
      actual: status === 'COMPLETE' ? (scope ?? 0) : 0,
      billedSource,
      releaseDate: releaseDateOf(status, a.all),
    });
  }
  units.sort((a, b) => byGroup(a.group, b.group));

  // Packages: a package record of the base DFS, or one that holds drawings or fees.
  const unitsByPackage = new Map<string, DfsUnit[]>();
  for (const u of units) unitsByPackage.set(`${u.projectId}|${u.packageKey}`, [...(unitsByPackage.get(`${u.projectId}|${u.packageKey}`) ?? []), u]);
  const groupFilter = f.disciplineId ? groups.groupOf.get(groups.rows.find((d) => d.id === f.disciplineId)?.code ?? '') ?? null : null;
  const search = f.search?.toLowerCase();
  const projectMatches = new Set(
    search ? allProjects.filter((p) => [p.displayName, p.projectName, p.projectCode].some((v) => v?.toLowerCase().includes(search))).map((p) => p.id) : [],
  );
  const nodeScope = f.nodeId ? descendantsOf(nodes, f.nodeId) : null;
  const out: DfsPackage[] = [];
  const consider = (projectId: string, packageKey: string, p: (typeof pkgs)[number] | null) => {
    const list = unitsByPackage.get(`${projectId}|${packageKey}`) ?? [];
    if (!p && list.length === 0) return;
    if (p && !p.wbsNodeId && list.length === 0) return; // a package record with no heading, drawings or fees
    const allCounts = list.reduce((m, u) => addCounts(m, u.all), zero());
    const explicitNa = list.length > 0 && list.every((u) => u.status === 'NA');
    const status: UnitStatus = p ? statusOf(allCounts, explicitNa) : allCounts.released === allCounts.drawings ? 'COMPLETE' : 'NOT_COMPLETE';
    const shownUnits = groupFilter ? list.filter((u) => u.group === groupFilter) : list;
    const who = responsibleOf(p);
    const textMatch =
      (!!search && ((!!p && [p.packageCode, p.packageName, who ?? ''].some((v) => v.toLowerCase().includes(search))) || projectMatches.has(projectId))) ||
      (!!responsibleFilter && who?.toLowerCase() === responsibleFilter);
    let visible = true;
    if (groupFilter && shownUnits.length === 0) visible = false;
    if (f.unitStatus && (!p || status !== f.unitStatus)) visible = false;
    if (nodeScope && !(p?.wbsNodeId && nodeScope.has(p.wbsNodeId))) visible = false;
    if (drawingFilter && !shownUnits.some((u) => u.shown.drawings > 0) && !(textMatch && !(f.release || f.scheduleStatus))) visible = false;
    out.push({
      key: `${projectId}|${packageKey}`,
      projectId,
      packageId: p?.id ?? null,
      code: p?.packageCode ?? '',
      name: p?.packageName ?? '',
      responsible: who,
      expectedDate: p?.currentExpectedReleaseDate ?? null,
      wbsNodeId: p?.wbsNodeId ?? null,
      sequence: p?.sequence ?? 1_000_000,
      status,
      noDrawings: allCounts.drawings === 0 && status !== 'NA',
      releaseDate: p ? releaseDateOf(status, allCounts) : null,
      units: shownUnits,
      visible,
    });
  };
  for (const p of pkgs) consider(p.projectId, p.id, p);
  for (const p of new Set(units.filter((u) => u.packageKey === NO_PACKAGE).map((u) => u.projectId))) consider(p, NO_PACKAGE, null);
  out.sort((a, b) => a.sequence - b.sequence || a.code.localeCompare(b.code, undefined, { numeric: true }));

  return { projects: allProjects, scopeIds: ids, nodes, packages: out, units, groups, filtered: drawingFilter || Boolean(f.unitStatus || f.disciplineId || f.nodeId) };
}

function descendantsOf(nodes: { id: string; parentId: string | null }[], id: string) {
  const kids = new Map<string, string[]>();
  for (const n of nodes) if (n.parentId) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n.id]);
  const out = new Set<string>([id]);
  const stack = [id];
  while (stack.length) {
    for (const k of kids.get(stack.pop()!) ?? []) {
      if (out.has(k)) continue;
      out.add(k);
      stack.push(k);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The DFS table (rows and their children)
// ---------------------------------------------------------------------------

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function emptyRow(key: string, parentKey: string | null, kind: DfsRowKind, depth: number, name: string): DfsRow {
  return {
    key,
    parentKey,
    kind,
    depth,
    name,
    typeLabel: null,
    code: null,
    hasChildren: false,
    status: null,
    noDrawings: false,
    releaseDate: null,
    packagesComplete: 0,
    packagesPending: 0,
    packagesNa: 0,
    packagesTotal: 0,
    drawingsReleased: 0,
    drawingsTotal: 0,
    unitKey: null,
    projectId: null,
    packageId: null,
    group: null,
    responsible: null,
    expectedDate: null,
    billing: null,
    billingFlags: [],
  };
}

const addBilling = (a: DfsRow['billing'], b: DfsRow['billing']): DfsRow['billing'] =>
  !a ? b : !b ? a : { total: a.total + b.total, billed: a.billed + b.billed, unbilled: a.unbilled + b.unbilled };

/** A discipline line's billing: Total = scope, Billed = billed to date; nothing for Not Applicable or no package. */
function unitBilling(u: DfsUnit): DfsRow['billing'] {
  if (u.packageKey === NO_PACKAGE || u.status === 'NA') return null;
  // Rounded here, at the line, so every parent shows exactly the sum of what its children show.
  const total = round4(u.scope ?? 0);
  const billed = round4(u.billedSource ?? 0);
  return { total, billed, unbilled: round4(total - billed) };
}

function billingFlagsOf(status: UnitStatus | null, b: DfsRow['billing']): string[] {
  if (!b || status !== 'NOT_COMPLETE') return [];
  const out: string[] = [];
  if (b.total > 1e-9 || b.billed > 1e-9) out.push('ELIGIBLE_AFTER_COMPLETION');
  if (b.billed > 1e-9) out.push('BILLED_BEFORE_COMPLETION');
  return out;
}

/** Sums of 4-decimal amounts, cleaned of floating-point noise (4 decimals of a crore). */
const roundBilling = (b: DfsRow['billing']) => (b ? { total: round4(b.total), billed: round4(b.billed), unbilled: round4(b.unbilled) } : null);

/** Build the whole table model: every row with its roll-up and its child keys. */
export async function buildDfsModel(f: DfsFilters = {}): Promise<DfsModel> {
  const d = await loadDfs(f);
  const rows = new Map<string, DfsRow>();
  const children = new Map<string, string[]>();
  const link = (parent: string, child: string) => children.set(parent, [...(children.get(parent) ?? []), child]);

  const inScope = d.projects.filter((p) => !d.scopeIds || d.scopeIds.includes(p.id));
  const byParent = new Map<string | null, typeof inScope>();
  const scopeSet = new Set(inScope.map((p) => p.id));
  for (const p of inScope) {
    const parent = p.parentProjectId && scopeSet.has(p.parentProjectId) ? p.parentProjectId : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), p]);
  }
  const order = (a: (typeof inScope)[number], b: (typeof inScope)[number]) =>
    (a.displayOrder ?? 1e6) - (b.displayOrder ?? 1e6) || projectLabel(a).localeCompare(projectLabel(b));

  const visiblePkgs = d.packages.filter((p) => p.visible);
  const pkgsOf = (projectId: string) => visiblePkgs.filter((p) => p.projectId === projectId);

  // Add a package-or-no-package row with its discipline rows; returns the package row.
  const addPackage = (pk: DfsPackage, parentKey: string, depth: number) => {
    const key = `K:${pk.key}`;
    const noPackage = !pk.packageId;
    const r = emptyRow(key, parentKey, noPackage ? 'NO_PACKAGE' : 'PACKAGE', depth, noPackage ? 'Drawings not assigned to a package' : pk.name || pk.code);
    r.code = noPackage ? null : pk.code;
    r.status = noPackage ? null : pk.status;
    r.noDrawings = pk.noDrawings;
    r.releaseDate = iso(pk.releaseDate);
    r.projectId = pk.projectId;
    r.packageId = pk.packageId;
    r.responsible = pk.responsible;
    r.expectedDate = iso(pk.expectedDate);
    for (const u of pk.units) {
      if (hasDrawingFilter(f) && u.shown.drawings === 0 && !(f.responsible && pk.responsible?.toLowerCase() === f.responsible.toLowerCase())) continue;
      const uk = `U:${u.key}`;
      const ur = emptyRow(uk, key, 'DISCIPLINE', depth + 1, u.groupName);
      ur.status = u.status;
      ur.noDrawings = u.flags.includes('NO_DRAWINGS');
      ur.releaseDate = iso(u.releaseDate);
      ur.drawingsReleased = u.shown.released;
      ur.drawingsTotal = u.shown.drawings;
      ur.hasChildren = u.shown.drawings > 0;
      ur.unitKey = u.key;
      ur.projectId = u.projectId;
      ur.packageId = u.packageId;
      ur.group = u.group;
      ur.billing = unitBilling(u);
      ur.billingFlags = billingFlagsOf(u.status, ur.billing);
      rows.set(uk, ur);
      link(key, uk);
      r.drawingsReleased += ur.drawingsReleased;
      r.drawingsTotal += ur.drawingsTotal;
      if (!noPackage) r.billing = addBilling(r.billing, ur.billing);
    }
    r.billingFlags = billingFlagsOf(r.status, r.billing);
    if (!noPackage) {
      r.packagesTotal = pk.status === 'NA' ? 0 : 1;
      r.packagesComplete = pk.status === 'COMPLETE' ? 1 : 0;
      r.packagesPending = pk.status === 'NOT_COMPLETE' ? 1 : 0;
      r.packagesNa = pk.status === 'NA' ? 1 : 0;
    }
    r.hasChildren = (children.get(key) ?? []).length > 0;
    rows.set(key, r);
    link(parentKey, key);
    return r;
  };

  const sumInto = (r: DfsRow) => {
    for (const c of children.get(r.key) ?? []) {
      const x = rows.get(c)!;
      if (x.kind === 'DISCIPLINE' && r.kind !== 'PACKAGE' && r.kind !== 'NO_PACKAGE') {
        r.drawingsReleased += x.drawingsReleased;
        r.drawingsTotal += x.drawingsTotal;
        continue;
      }
      if (x.kind === 'DISCIPLINE') continue;
      r.billing = addBilling(r.billing, x.billing);
      r.packagesComplete += x.packagesComplete;
      r.packagesPending += x.packagesPending;
      r.packagesNa += x.packagesNa;
      r.packagesTotal += x.packagesTotal;
      r.drawingsReleased += x.drawingsReleased;
      r.drawingsTotal += x.drawingsTotal;
    }
  };

  const addProject = (p: (typeof inScope)[number], parentKey: string | null, depth: number): boolean => {
    const key = `P:${p.id}`;
    const r = emptyRow(key, parentKey, 'PROJECT', depth, projectLabel(p));
    r.projectId = p.id;
    if (parentKey) r.typeLabel = 'Tower / Product';
    rows.set(key, r);
    // Child projects (towers / products held as their own records).
    for (const c of [...(byParent.get(p.id) ?? [])].sort(order)) addProject(c, key, depth + 1);
    const own = pkgsOf(p.id);
    const real = own.filter((x) => x.packageId);
    const loose = own.find((x) => !x.packageId);
    const projectHasPackages = d.packages.some((x) => x.projectId === p.id && x.packageId);
    // Base-DFS headings, nested; a heading with nothing under it is not shown.
    const nodes = d.nodes.filter((n) => n.projectId === p.id);
    const addNode = (n: (typeof nodes)[number], parent: string, dep: number): boolean => {
      const nk = `W:${n.id}`;
      const nr = emptyRow(nk, parent, 'NODE', dep, n.name);
      nr.projectId = p.id;
      nr.typeLabel = NODE_TYPE_LABEL[n.nodeType] ?? null;
      nr.code = n.code;
      rows.set(nk, nr);
      for (const c of nodes.filter((x) => x.parentId === n.id)) addNode(c, nk, dep + 1);
      for (const pk of real.filter((x) => x.wbsNodeId === n.id)) addPackage(pk, nk, dep + 1);
      if (!(children.get(nk) ?? []).length) {
        rows.delete(nk);
        return false;
      }
      sumInto(nr);
      nr.hasChildren = true;
      link(parent, nk);
      return true;
    };
    for (const n of nodes.filter((x) => !x.parentId)) addNode(n, key, depth + 1);
    const nodeIds = new Set(nodes.map((n) => n.id));
    for (const pk of real.filter((x) => !x.wbsNodeId || !nodeIds.has(x.wbsNodeId))) addPackage(pk, key, depth + 1);
    if (loose) {
      if (projectHasPackages) addPackage(loose, key, depth + 1);
      else {
        // No package definition anywhere: Discipline → Drawings directly under the project.
        for (const u of loose.units) {
          if (hasDrawingFilter(f) && u.shown.drawings === 0) continue;
          const uk = `U:${u.key}`;
          const ur = emptyRow(uk, key, 'DISCIPLINE', depth + 1, u.groupName);
          ur.status = u.status;
          ur.releaseDate = iso(u.releaseDate);
          ur.drawingsReleased = u.shown.released;
          ur.drawingsTotal = u.shown.drawings;
          ur.hasChildren = u.shown.drawings > 0;
          ur.unitKey = u.key;
          ur.projectId = u.projectId;
          ur.group = u.group;
          rows.set(uk, ur);
          link(key, uk);
        }
      }
    }
    const kids = children.get(key) ?? [];
    if (!kids.length) {
      rows.delete(key);
      return false;
    }
    sumInto(r);
    r.hasChildren = true;
    if (parentKey) link(parentKey, key);
    return true;
  };

  const roots: string[] = [];
  for (const p of [...(byParent.get(null) ?? [])].sort(order)) if (addProject(p, null, 0)) roots.push(`P:${p.id}`);
  // Child projects were linked to their parent inside addProject; drop duplicates.
  for (const [k, v] of children) children.set(k, [...new Set(v)]);
  // Filtered to a tower / product: keep the project above it as the heading
  // (PoRR → Tower 08), with the same totals as what is shown under it.
  const byId = new Map(d.projects.map((p) => [p.id, p]));
  const ancestors: (typeof d.projects)[number][] = [];
  for (let p = f.projectId ? byId.get(f.projectId) : undefined, g = 0; p?.parentProjectId && byId.has(p.parentProjectId) && g < 20; g++) {
    p = byId.get(p.parentProjectId)!;
    ancestors.unshift(p);
  }
  if (ancestors.length && roots.length) {
    for (const r of rows.values()) r.depth += ancestors.length;
    let parentKey: string | null = null;
    const top: string[] = [];
    ancestors.forEach((p, i) => {
      const key = `P:${p.id}`;
      const r = emptyRow(key, parentKey, 'PROJECT', i, projectLabel(p));
      r.projectId = p.id;
      if (parentKey) r.typeLabel = 'Tower / Product';
      r.hasChildren = true;
      rows.set(key, r);
      if (parentKey) children.set(parentKey, [key]);
      else top.push(key);
      parentKey = key;
    });
    children.set(parentKey!, [...roots]);
    for (const k of roots) {
      const r = rows.get(k)!;
      r.parentKey = parentKey;
      r.typeLabel = r.typeLabel ?? 'Tower / Product';
    }
    for (const p of [...ancestors].reverse()) sumInto(rows.get(`P:${p.id}`)!);
    for (const r of rows.values()) r.billing = roundBilling(r.billing);
    return { rows, children, roots: top, units: d.units, packages: d.packages, filtered: d.filtered };
  }
  for (const r of rows.values()) r.billing = roundBilling(r.billing);
  return { rows, children, roots, units: d.units, packages: d.packages, filtered: d.filtered };
}

/** A row as a role may receive it: no billing without billing permission. */
export function forRole(r: DfsRow, billing: boolean): DfsRow {
  if (billing) return r;
  // No billing keys at all for a role without billing.
  const { billing: _b, billingFlags: _f, ...rest } = r;
  void _b;
  void _f;
  return rest as DfsRow;
}

/** Total / Billed / Unbilled of the whole view (the root rows). */
export function modelBilling(model: DfsModel) {
  let b: DfsRow['billing'] = null;
  for (const k of model.roots) b = addBilling(b, model.rows.get(k)!.billing);
  return roundBilling(b);
}

/** Rows to show: the children of `parent` (roots when null); with `expandTo` every row down to that kind. */
export function rowsOf(model: DfsModel, parent: string | null, expandTo?: 'PACKAGE') {
  const out: DfsRow[] = [];
  const walk = (keys: string[]) => {
    for (const k of keys) {
      const r = model.rows.get(k);
      if (!r) continue;
      out.push(r);
      if (expandTo && r.kind !== 'PACKAGE' && r.kind !== 'NO_PACKAGE' && r.kind !== 'DISCIPLINE') walk(model.children.get(k) ?? []);
    }
  };
  walk(parent ? (model.children.get(parent) ?? []) : model.roots);
  return out;
}

/** Totals of the whole view (sum of the root rows). */
export function modelTotals(model: DfsModel) {
  const t = { packagesComplete: 0, packagesPending: 0, packagesNa: 0, packagesTotal: 0, drawingsReleased: 0, drawingsTotal: 0 };
  for (const k of model.roots) {
    const r = model.rows.get(k)!;
    t.packagesComplete += r.packagesComplete;
    t.packagesPending += r.packagesPending;
    t.packagesNa += r.packagesNa;
    t.packagesTotal += r.packagesTotal;
    t.drawingsReleased += r.drawingsReleased;
    t.drawingsTotal += r.drawingsTotal;
  }
  return t;
}

/** The path of a row, outermost first (for exports). */
export function rowPath(model: DfsModel, key: string): DfsRow[] {
  const out: DfsRow[] = [];
  for (let r = model.rows.get(key); r; r = r.parentKey ? model.rows.get(r.parentKey) : undefined) out.unshift(r);
  return out;
}

// ---------------------------------------------------------------------------
// Drawings of one discipline row
// ---------------------------------------------------------------------------

export async function unitDrawingWhere(key: string): Promise<SQL | undefined> {
  const u = parseUnitKey(key);
  if (!u) throw new Error('Invalid DFS row');
  const conds: (SQL | undefined)[] = [eq(drawings.projectId, u.projectId)];
  if (u.packageKey === NO_PACKAGE) {
    // Drawings with no package, or with a package id that is not a package of the project.
    conds.push(or(isNull(drawings.packageId), sql`not exists (select 1 from ${packages} where ${packages.id} = ${drawings.packageId})`));
  } else conds.push(eq(drawings.packageId, u.packageKey));
  if (u.group === 'NONE') conds.push(isNull(drawings.disciplineId));
  else {
    const g = await disciplineGroups();
    const ids = g.membersOf(u.group);
    conds.push(ids.length ? inArray(drawings.disciplineId, ids) : sql`false`);
  }
  return and(...conds);
}

export async function unitDrawings(key: string, f: DfsFilters, page = 1, pageSize = 50) {
  const { listDrawings } = await import('./drawing-register');
  const extra = and(await unitDrawingWhere(key), hasDrawingFilter(f) ? dfsDrawingWhere(f, null) : undefined);
  return listDrawings({ page, pageSize, sort: f.sort ?? 'code', dir: f.dir }, extra);
}

// ---------------------------------------------------------------------------
// DFS Summary: packages and billing
// ---------------------------------------------------------------------------

export interface DfsSummaryRow {
  key: string;
  label: string;
  discipline: string | null;
  /** Project rows: package records. Discipline rows: package × discipline lines. */
  packages: number;
  complete: number;
  pending: number;
  /** complete ÷ packages, 0–1; null when there are none. */
  overall: number | null;
  total: number;
  billed: number;
  unbilled: number;
}
export interface DfsSummaryBlock {
  projectId: string | null;
  name: string;
  depth: number;
  row: DfsSummaryRow;
  disciplines: DfsSummaryRow[];
}
export interface DfsSummary {
  projects: DfsSummaryBlock[];
  total: DfsSummaryBlock;
}

export function round4(v: number) {
  return Math.round(v * 10000) / 10000;
}

function billing(units: DfsUnit[]) {
  let total = 0;
  let billed = 0;
  for (const u of units) {
    if (u.packageKey === NO_PACKAGE || u.status === 'NA') continue;
    total += u.scope ?? 0;
    billed += u.actual;
  }
  return { total: round4(total), billed: round4(billed), unbilled: round4(total - billed) };
}

function summaryBlock(projectId: string | null, name: string, depth: number, pkgs: DfsPackage[], units: DfsUnit[], nameOf: (g: string) => string): DfsSummaryBlock {
  const real = pkgs.filter((p) => p.packageId && p.status !== 'NA');
  const complete = real.filter((p) => p.status === 'COMPLETE').length;
  const row: DfsSummaryRow = {
    key: projectId ?? 'ALL',
    label: name,
    discipline: null,
    packages: real.length,
    complete,
    pending: real.length - complete,
    overall: real.length ? complete / real.length : null,
    ...billing(units),
  };
  const lines = units.filter((u) => u.packageKey !== NO_PACKAGE && u.status !== 'NA');
  const groups = [...new Set([...GROUP_ORDER, ...lines.map((u) => u.group)])].sort(byGroup);
  const disc = groups.map((g) => {
    const l = lines.filter((u) => u.group === g);
    const c = l.filter((u) => u.status === 'COMPLETE').length;
    return { key: `${projectId ?? 'ALL'}|${g}`, label: nameOf(g), discipline: g, packages: l.length, complete: c, pending: l.length - c, overall: l.length ? c / l.length : null, ...billing(l) };
  });
  return { projectId, name, depth, row, disciplines: disc };
}

/** DFS Summary — package status and billing per project (and its towers / products), then per discipline. */
export async function dfsSummary(f: DfsFilters = {}): Promise<DfsSummary> {
  const d = await loadDfs({ projectId: f.projectId, nodeId: f.nodeId });
  const pkgs = d.packages.filter((p) => p.visible);
  const inPkgs = new Set(pkgs.map((p) => p.key));
  const units = d.units.filter((u) => inPkgs.has(`${u.projectId}|${u.packageKey}`));
  const scope = d.projects.filter((p) => !d.scopeIds || d.scopeIds.includes(p.id));
  const ids = new Set(scope.map((p) => p.id));
  const below = (id: string): string[] => [id, ...scope.filter((p) => p.parentProjectId === id).flatMap((p) => below(p.id))];
  const order = (a: (typeof scope)[number], b: (typeof scope)[number]) => (a.displayOrder ?? 1e6) - (b.displayOrder ?? 1e6) || projectLabel(a).localeCompare(projectLabel(b));
  const blocks: DfsSummaryBlock[] = [];
  const add = (p: (typeof scope)[number], depth: number) => {
    const set = new Set(below(p.id));
    const bp = pkgs.filter((x) => set.has(x.projectId) && x.packageId);
    if (!bp.length) return;
    blocks.push(summaryBlock(p.id, projectLabel(p), depth, bp, units.filter((u) => set.has(u.projectId)), d.groups.nameOf));
    for (const c of scope.filter((x) => x.parentProjectId === p.id).sort(order)) add(c, depth + 1);
  };
  for (const p of scope.filter((x) => !x.parentProjectId || !ids.has(x.parentProjectId)).sort(order)) add(p, 0);
  const rootIds = new Set(blocks.filter((b) => b.depth === 0).flatMap((b) => below(b.projectId!)));
  return {
    projects: blocks,
    total: summaryBlock(null, 'All projects', 0, pkgs.filter((p) => p.packageId && rootIds.has(p.projectId)), units.filter((u) => rootIds.has(u.projectId)), d.groups.nameOf),
  };
}

// ---------------------------------------------------------------------------
// Year / Quarter
// ---------------------------------------------------------------------------

/** When a unit was completed, as precisely as the sources allow. */
export type CompletionPeriod =
  | { kind: 'DATE'; date: Date }
  | { kind: 'QUARTER'; year: number; quarter: number }
  | { kind: 'YEAR'; year: number }
  | { kind: 'BEFORE'; year: number }
  | { kind: 'UNKNOWN' };

const EV_BEFORE = /^Issued before 01-Jan-(\d{4})$/;
const EV_QUARTER = /^Issued (\d{4}) Q([1-4])$/;
const EV_YEAR = /^Issued in (\d{4})$/;

export function drawingReleasePeriod(actual: Date | null, evidence: string | null): CompletionPeriod {
  if (actual) return { kind: 'DATE', date: actual };
  if (!evidence) return { kind: 'UNKNOWN' };
  let m = EV_BEFORE.exec(evidence);
  if (m) return { kind: 'BEFORE', year: Number(m[1]) };
  m = EV_QUARTER.exec(evidence);
  if (m) return { kind: 'QUARTER', year: Number(m[1]), quarter: Number(m[2]) };
  m = EV_YEAR.exec(evidence);
  if (m) return { kind: 'YEAR', year: Number(m[1]) };
  return { kind: 'UNKNOWN' };
}

function periodEnd(p: CompletionPeriod): number {
  switch (p.kind) {
    case 'DATE':
      return p.date.getTime();
    case 'QUARTER':
      return calendarQuarter(p.year, p.quarter).end.getTime();
    case 'YEAR':
      return calendarQuarter(p.year, 4).end.getTime();
    case 'BEFORE':
      return Date.UTC(p.year, 0, 1) - 1;
    default:
      return Number.POSITIVE_INFINITY;
  }
}

/** A unit is complete when its LAST drawing is released; an unknown release makes the period unknown. */
export function latestPeriod(periods: CompletionPeriod[]): CompletionPeriod {
  if (periods.length === 0) return { kind: 'UNKNOWN' };
  let best = periods[0];
  for (const p of periods) {
    if (p.kind === 'UNKNOWN') return p;
    if (periodEnd(p) > periodEnd(best)) best = p;
  }
  return best;
}

export type PeriodBasis = 'CY' | 'FY';

export interface PeriodBucket {
  key: string;
  label: string;
  year: string | null;
  quarter: number | null;
  order: number;
}

function bucketOfDate(d: Date, basis: PeriodBasis): PeriodBucket {
  const q = basis === 'FY' ? fiscalQuarterOf(d) : calendarQuarterOf(d);
  const yearNum = Number(basis === 'FY' ? `20${q.label.slice(2, 4)}` : q.label.slice(2));
  const year = basis === 'FY' ? `Financial Year 20${q.label.slice(2, 4)}–${q.label.slice(5, 7)}` : `Calendar Year ${q.label.slice(2)}`;
  return { key: `${q.label}-Q${q.quarter}`, label: quarterLabel(q.quarter), year, quarter: q.quarter, order: yearNum * 10 + q.quarter };
}

export function bucketOfPeriod(p: CompletionPeriod | null, basis: PeriodBasis): PeriodBucket {
  if (!p || p.kind === 'UNKNOWN') return { key: 'UNKNOWN', label: 'Date not given in the source', year: null, quarter: null, order: 9_999_999 };
  switch (p.kind) {
    case 'DATE':
      return bucketOfDate(p.date, basis);
    case 'QUARTER':
      return bucketOfDate(new Date(Date.UTC(p.year, (p.quarter - 1) * 3 + 1, 15)), basis);
    case 'YEAR':
      return basis === 'CY'
        ? { key: `CY${p.year}-Q?`, label: 'Quarter not given', year: `Calendar Year ${p.year}`, quarter: null, order: p.year * 10 + 5 }
        : { key: `CY${p.year}`, label: `Calendar Year ${p.year}, quarter not given`, year: null, quarter: null, order: p.year * 10 + 5 };
    case 'BEFORE':
      return { key: `BEFORE-${p.year}`, label: `Before ${formatDate(new Date(Date.UTC(p.year, 0, 1)))}`, year: null, quarter: null, order: (p.year - 1) * 10 };
  }
}

export interface PeriodRow {
  discipline: string;
  disciplineName: string;
  cells: Record<string, { planned: number; completed: number; scopePlanned: number; actual: number }>;
  totals: { planned: number; completed: number; scopePlanned: number; actual: number };
}

/**
 * Package × discipline status and billing over years and quarters. Planned =
 * the quarter of the latest expected date; complete = the quarter the last
 * drawing was released (actual dates, or the quarter / year the source gives
 * — never an invented date).
 */
export async function dfsPeriods(f: DfsFilters, basis: PeriodBasis = 'CY') {
  const d = await loadDfs(f);
  const visible = new Set(d.packages.filter((p) => p.visible && p.packageId).map((p) => p.key));
  const units = d.units.filter((u) => visible.has(`${u.projectId}|${u.packageKey}`) && u.status !== 'NA');
  // Release evidence of the complete units' undated releases.
  const completeKeys = units.filter((u) => u.status === 'COMPLETE' && u.all.releasedNoDate > 0);
  const evidence = new Map<string, CompletionPeriod[]>();
  if (completeKeys.length) {
    const rows = await db
      .select({ projectId: drawings.projectId, packageId: drawings.packageId, group: GROUP_SQL, evidence: drawings.releaseEvidence })
      .from(drawings)
      .leftJoin(disciplines, eq(drawings.disciplineId, disciplines.id))
      .where(
        and(
          eq(drawings.completionStatus, 'COMPLETED'),
          isNull(drawings.actualReleaseDate),
          isNotNull(drawings.packageId),
          isNull(drawings.archivedAt),
          inArray(drawings.packageId, [...new Set(completeKeys.map((u) => u.packageKey))]),
        ),
      )
      .groupBy(drawings.projectId, drawings.packageId, GROUP_SQL, drawings.releaseEvidence);
    for (const r of rows) {
      const k = unitKey(r.projectId, r.packageId!, r.group);
      evidence.set(k, [...(evidence.get(k) ?? []), drawingReleasePeriod(null, r.evidence)]);
    }
  }
  const completion = (u: DfsUnit): CompletionPeriod => {
    const list: CompletionPeriod[] = [...(evidence.get(u.key) ?? [])];
    if (u.all.lastRelease) list.push({ kind: 'DATE', date: u.all.lastRelease });
    return latestPeriod(list);
  };

  const buckets = new Map<string, PeriodBucket>();
  const rows = new Map<string, PeriodRow>();
  const notScheduled: PeriodBucket = { key: 'NOT_SCHEDULED', label: 'Not scheduled', year: null, quarter: null, order: 9_999_998 };
  const add = (u: DfsUnit, b: PeriodBucket, field: 'planned' | 'completed', amount: number) => {
    buckets.set(b.key, b);
    const row = rows.get(u.group) ?? { discipline: u.group, disciplineName: u.groupName, cells: {}, totals: { planned: 0, completed: 0, scopePlanned: 0, actual: 0 } };
    rows.set(u.group, row);
    const cell = (row.cells[b.key] ??= { planned: 0, completed: 0, scopePlanned: 0, actual: 0 });
    if (field === 'planned') {
      cell.planned += 1;
      cell.scopePlanned += amount;
      row.totals.planned += 1;
      row.totals.scopePlanned += amount;
    } else {
      cell.completed += 1;
      cell.actual += amount;
      row.totals.completed += 1;
      row.totals.actual += amount;
    }
  };
  for (const u of units) {
    add(u, u.all.latestExpected ? bucketOfDate(u.all.latestExpected, basis) : notScheduled, 'planned', u.scope ?? 0);
    if (u.status === 'COMPLETE') add(u, bucketOfPeriod(completion(u), basis), 'completed', u.actual);
  }
  const cols = [...buckets.values()].sort((a, b) => a.order - b.order);
  const ordered = [...rows.values()].sort((a, b) => byGroup(a.discipline, b.discipline));
  const total: PeriodRow = { discipline: 'TOTAL', disciplineName: 'Total', cells: {}, totals: { planned: 0, completed: 0, scopePlanned: 0, actual: 0 } };
  for (const r of ordered) {
    for (const [k, c] of Object.entries(r.cells)) {
      const t = (total.cells[k] ??= { planned: 0, completed: 0, scopePlanned: 0, actual: 0 });
      t.planned += c.planned;
      t.completed += c.completed;
      t.scopePlanned += c.scopePlanned;
      t.actual += c.actual;
    }
    total.totals.planned += r.totals.planned;
    total.totals.completed += r.totals.completed;
    total.totals.scopePlanned += r.totals.scopePlanned;
    total.totals.actual += r.totals.actual;
  }
  for (const r of [...ordered, total]) {
    for (const c of [...Object.values(r.cells), r.totals]) {
      c.scopePlanned = round4(c.scopePlanned);
      c.actual = round4(c.actual);
    }
  }
  const years: { year: string; buckets: PeriodBucket[] }[] = [];
  for (const b of cols) {
    const y = b.year ?? b.label;
    const last = years[years.length - 1];
    if (last && last.year === y && b.year) last.buckets.push(b);
    else years.push({ year: y, buckets: [b] });
  }
  return { basis, columns: cols, years, rows: ordered, total };
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** Root projects that hold DFS data (themselves or below) — the Project filter. */
export async function dfsRootProjects() {
  const all = await db.select().from(projects);
  const withData = new Set(
    (
      await db
        .select({ id: projects.id })
        .from(projects)
        .where(
          or(
            sql`exists (select 1 from ${drawings} where ${drawings.projectId} = ${projects.id})`,
            sql`exists (select 1 from ${packages} where ${packages.projectId} = ${projects.id})`,
          ),
        )
    ).map((r) => r.id),
  );
  const byId = new Map(all.map((p) => [p.id, p]));
  const rootOf = (id: string) => {
    let p = byId.get(id)!;
    for (let g = 0; p.parentProjectId && byId.has(p.parentProjectId) && g < 20; g++) p = byId.get(p.parentProjectId)!;
    return p;
  };
  const roots = new Map<string, (typeof all)[number]>();
  for (const id of withData) {
    const r = rootOf(id);
    roots.set(r.id, r);
  }
  return [...roots.values()]
    .sort((a, b) => (a.displayOrder ?? 1e6) - (b.displayOrder ?? 1e6) || projectLabel(a).localeCompare(projectLabel(b)))
    .map((p) => ({ id: p.id, name: projectLabel(p) }));
}

export function parseDfsFilters(sp: URLSearchParams | Record<string, string | string[] | undefined>): DfsFilters {
  const f: DfsFilters = parseDrawingFilters(sp);
  const get = (k: string) => {
    if (sp instanceof URLSearchParams) return sp.get(k) ?? undefined;
    const v = sp[k];
    return (Array.isArray(v) ? v[0] : v) || undefined;
  };
  const us = get('unitStatus');
  if (us === 'COMPLETE' || us === 'NOT_COMPLETE' || us === 'NA') f.unitStatus = us;
  const node = get('nodeId');
  if (node) f.nodeId = node;
  delete f.phaseId;
  return f;
}

/** Every Responsible Person named on a package or drawing (for the filter). */
export async function responsibleNames(): Promise<string[]> {
  const rows = await db.execute(sql`
    select distinct name from (
      select coalesce(u.name, p.responsible_text) as name from packages p left join users u on u.id = p.responsible_user_id
        where p.archived_at is null and (p.responsible_user_id is not null or p.responsible_text is not null)
      union
      select coalesce(u.name, d.responsible_text) from drawings d left join users u on u.id = d.responsible_user_id
        where d.archived_at is null and (d.responsible_user_id is not null or d.responsible_text is not null)
    ) x where name is not null order by name`);
  return (rows.rows as { name: string }[]).map((r) => r.name);
}
