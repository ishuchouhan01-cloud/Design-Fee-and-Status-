/**
 * Drawing Register — read side. Everything here is read-only and needs only
 * `drawing.read`. Filtering, schedule status and paging all happen in SQL, so
 * totals are right for every filter (the old register filtered schedule status
 * after paging).
 */
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { projectLabel } from '@/lib/labels';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '@/db';
import {
  dependencies,
  disciplines,
  drawingConflicts,
  drawingDependencies,
  drawingImportBatches,
  drawingImportIssues,
  drawingLocationPhaseMap,
  drawingRevisions,
  drawingSnapshots,
  drawings,
  packages,
  dfsWbsNodes,
  projectPhases,
  projects,
  rescheduleHistory,
  users,
} from '@/db/schema';
import { auditForEntity } from '@/lib/audit';
import { config } from '@/lib/config';
import { SCHEDULE_STATUSES, type ScheduleStatus } from '@/lib/domain';
import { assessSchedule, type ScheduleAssessment } from '@/lib/schedule';
import { pageOf, type Paged } from './filters';

// ---------------------------------------------------------------------------
// Schedule status — one definition in SQL, mirroring assessSchedule()
// ---------------------------------------------------------------------------

const day = (col: SQL | typeof drawings.currentExpectedReleaseDate) => sql`((${col}) at time zone 'UTC')::date`;
const TODAY = sql`(now() at time zone 'UTC')::date`;

/**
 * The drawing's schedule status, computed in SQL exactly as `assessSchedule`
 * computes it in TypeScript (a test holds the two together), with one
 * drawing-specific rule: a RELEASED drawing without an actual release date is
 * not assessable, so its schedule status is NULL. That is a data-quality fact
 * shown as "Release date: Not recorded", never a schedule status.
 */
export function drawingScheduleStatusSql(): SQL<ScheduleStatus | null> {
  const expected = drawings.currentExpectedReleaseDate;
  const baseline = drawings.baselineReleaseDate;
  const actual = drawings.actualReleaseDate;
  return sql<ScheduleStatus | null>`(case
    when ${drawings.completionStatus} = 'COMPLETED' then (case
      when ${actual} is null then null
      when coalesce(${baseline}, ${expected}) is null then 'COMPLETED_ON_TIME'
      when ${day(actual)} - ${day(sql`coalesce(${baseline}, ${expected})`)} > 0 then 'COMPLETED_LATE'
      else 'COMPLETED_ON_TIME' end)
    when ${expected} is null then 'NOT_SCHEDULED'
    when ${day(expected)} - ${TODAY} < 0 then 'DELAYED'
    when ${drawings.rescheduleCount} > 0 or (${baseline} is not null and ${day(expected)} - ${day(baseline)} <> 0) then 'RESCHEDULED'
    when ${day(expected)} - ${TODAY} <= ${config.dueSoonDays} then 'DUE_SOON'
    else 'ON_TRACK' end)`;
}

/** TypeScript twin of the SQL rule, for single records. */
export function assessDrawing(d: {
  completionStatus: string;
  baselineReleaseDate: Date | null;
  currentExpectedReleaseDate: Date | null;
  actualReleaseDate: Date | null;
  rescheduleCount: number;
}): ScheduleAssessment | null {
  if (d.completionStatus === 'COMPLETED' && !d.actualReleaseDate) return null;
  return assessSchedule({
    completionStatus: d.completionStatus,
    baselineDate: d.baselineReleaseDate,
    expectedDate: d.currentExpectedReleaseDate,
    actualDate: d.actualReleaseDate,
    rescheduleCount: d.rescheduleCount,
  });
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export interface DrawingFilters {
  projectId?: string;
  phaseId?: string;
  disciplineId?: string;
  packageId?: string;
  batchCode?: string;
  release?: 'COMPLETED' | 'NOT_COMPLETED';
  scheduleStatus?: string;
  /** RECORDED | NOT_RECORDED — whether a released drawing has an actual date. */
  releaseDate?: string;
  responsibleId?: string; // a user id, or NONE
  /** Responsible Person by name (a user's name or the name as given). */
  responsible?: string;
  /** Include archived drawings (never on a screen). */
  includeArchived?: boolean;
  numberStatus?: string;
  dateField?: 'expected' | 'actual' | 'baseline' | 'updated';
  dateFrom?: Date;
  dateTo?: Date;
  rescheduled?: boolean;
  search?: string;
  sort?: string;
  dir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

function parseDay(v: string | undefined): Date | undefined {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const [y, m, d] = v.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function parseDrawingFilters(sp: URLSearchParams | Record<string, string | string[] | undefined>): DrawingFilters {
  const get = (k: string) => {
    if (sp instanceof URLSearchParams) return sp.get(k) ?? undefined;
    const v = sp[k];
    return (Array.isArray(v) ? v[0] : v) || undefined;
  };
  // `completion` is the legacy name of the release filter; both work.
  const release = get('release') ?? get('completion');
  const n = (k: string) => {
    const v = Number(get(k));
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };
  const df = get('dateField');
  const resched = get('rescheduled');
  return {
    projectId: get('projectId'),
    phaseId: get('phaseId'),
    disciplineId: get('disciplineId'),
    packageId: get('packageId'),
    batchCode: get('batchCode'),
    release: release === 'COMPLETED' || release === 'NOT_COMPLETED' ? release : undefined,
    scheduleStatus: get('scheduleStatus'),
    releaseDate: get('releaseDate'),
    responsibleId: get('responsibleId'),
    responsible: get('responsible')?.trim() || undefined,
    numberStatus: get('numberStatus'),
    dateField: df === 'actual' || df === 'baseline' || df === 'expected' || df === 'updated' ? df : undefined,
    dateFrom: parseDay(get('dateFrom')),
    dateTo: parseDay(get('dateTo')),
    rescheduled: resched == null ? undefined : resched === 'true',
    search: get('search')?.trim() || undefined,
    sort: get('sort'),
    dir: get('dir') === 'desc' ? 'desc' : get('dir') === 'asc' ? 'asc' : undefined,
    page: n('page') ?? 1,
    pageSize: Math.min(500, n('pageSize') ?? 50),
  };
}

/** Map the shared list-filter contract onto drawing filters. */
export function drawingFiltersFromList(f: import('./filters').ListFilters): DrawingFilters {
  return {
    projectId: f.projectId,
    phaseId: f.phaseId,
    disciplineId: f.disciplineId,
    packageId: f.packageId,
    release: f.completion,
    scheduleStatus: f.scheduleStatus,
    rescheduled: f.rescheduled,
    search: f.search,
    sort: f.sort,
    dir: f.dir,
    page: f.page,
    pageSize: f.pageSize,
  };
}

/** A project and every project below it (towers / products held as child projects), as a subquery of ids. */
export function projectAndBelow(projectId: string): SQL {
  return sql`(with recursive t(id) as (select ${projectId}::text union select p.id from ${projects} p join t on p.parent_project_id = t.id) select id from t)`;
}

/** A drawing whose Responsible Person is this name (a linked user's name, or the name as given). */
export function responsibleIs(name: string): SQL {
  return sql`(lower(${drawings.responsibleText}) = lower(${name}) or exists (select 1 from ${users} ru where ru.id = ${drawings.responsibleUserId} and lower(ru.name) = lower(${name})))`;
}

export function drawingWhere(f: DrawingFilters): SQL | undefined {
  const c: (SQL | undefined)[] = [];
  // Archived drawings (soft delete) are never listed or counted.
  if (!f.includeArchived) c.push(isNull(drawings.archivedAt));
  // Choosing a project includes the towers / products below it.
  if (f.projectId) c.push(sql`${drawings.projectId} in ${projectAndBelow(f.projectId)}`);
  if (f.phaseId === 'NONE') c.push(isNull(drawings.phaseId));
  else if (f.phaseId) c.push(eq(drawings.phaseId, f.phaseId));
  if (f.disciplineId) c.push(eq(drawings.disciplineId, f.disciplineId));
  if (f.packageId) c.push(eq(drawings.packageId, f.packageId));
  if (f.batchCode) c.push(eq(drawings.batchCode, f.batchCode));
  if (f.release) c.push(eq(drawings.completionStatus, f.release));
  if (f.numberStatus === 'NUMBERED' || f.numberStatus === 'NOT_YET_NUMBERED') c.push(eq(drawings.numberStatus, f.numberStatus));
  if (f.responsibleId === 'NONE') c.push(and(isNull(drawings.responsibleUserId), isNull(drawings.responsibleText)));
  else if (f.responsibleId) c.push(eq(drawings.responsibleUserId, f.responsibleId));
  if (f.responsible) c.push(responsibleIs(f.responsible));
  if (f.releaseDate === 'NOT_RECORDED') c.push(and(eq(drawings.completionStatus, 'COMPLETED'), isNull(drawings.actualReleaseDate)));
  if (f.releaseDate === 'RECORDED') c.push(isNotNull(drawings.actualReleaseDate));
  if (f.scheduleStatus && (SCHEDULE_STATUSES as readonly string[]).includes(f.scheduleStatus)) {
    c.push(sql`${drawingScheduleStatusSql()} = ${f.scheduleStatus}`);
  }
  if (f.rescheduled === true) c.push(sql`${drawings.rescheduleCount} > 0`);
  if (f.rescheduled === false) c.push(sql`${drawings.rescheduleCount} = 0`);
  if ((f.dateFrom || f.dateTo) && f.dateField === 'updated') {
    // "Updated On": the edit, the source date, or — for a source period — its span overlapping the range.
    const lo = sql`coalesce(${drawings.editedAt}, ${drawings.sourceDate}, ${drawings.sourcePeriodStart}, ${drawings.sourcePeriodEnd})`;
    const hi = sql`coalesce(${drawings.editedAt}, ${drawings.sourceDate}, ${drawings.sourcePeriodEnd})`;
    if (f.dateFrom) c.push(sql`${hi} >= ${f.dateFrom}`);
    if (f.dateTo) c.push(sql`${lo} < ${new Date(f.dateTo.getTime() + 86_400_000)}`);
  } else if (f.dateFrom || f.dateTo) {
    const col =
      f.dateField === 'actual'
        ? drawings.actualReleaseDate
        : f.dateField === 'baseline'
          ? drawings.baselineReleaseDate
          : drawings.currentExpectedReleaseDate;
    if (f.dateFrom) c.push(gte(col, f.dateFrom));
    if (f.dateTo) c.push(lt(col, new Date(f.dateTo.getTime() + 86_400_000)));
  }
  if (f.search) {
    const s = `%${f.search}%`;
    c.push(
      or(
        ilike(drawings.drawingCode, s),
        ilike(drawings.drawingNumber, s),
        ilike(drawings.partialNumber, s),
        ilike(drawings.drawingName, s),
        ilike(drawings.batchCode, s),
        ilike(drawings.location, s),
        ilike(drawings.areaOfWorks, s),
        ilike(drawings.responsibleText, s),
        sql`exists (select 1 from ${users} ru where ru.id = ${drawings.responsibleUserId} and ru.name ilike ${s})`,
      ),
    );
  }
  const list = c.filter(Boolean) as SQL[];
  return list.length ? and(...list) : undefined;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

const responsible = alias(users, 'responsible');

export const drawingRowSelect = {
  id: drawings.id,
  drawingCode: drawings.drawingCode,
  drawingNumber: drawings.drawingNumber,
  numberStatus: drawings.numberStatus,
  partialNumber: drawings.partialNumber,
  drawingName: drawings.drawingName,
  projectId: drawings.projectId,
  projectCode: projects.projectCode,
  projectName: projects.projectName,
  projectDisplayName: projects.displayName,
  phaseId: drawings.phaseId,
  phaseCode: projectPhases.code,
  packageId: drawings.packageId,
  packageCode: packages.packageCode,
  packageName: packages.packageName,
  disciplineId: drawings.disciplineId,
  disciplineCode: disciplines.code,
  disciplineName: disciplines.name,
  areaOfWorks: drawings.areaOfWorks,
  location: drawings.location,
  batch: drawings.batch,
  batchCode: drawings.batchCode,
  issueType: drawings.issueType,
  revision: drawings.revision,
  baselineReleaseDate: drawings.baselineReleaseDate,
  currentExpectedReleaseDate: drawings.currentExpectedReleaseDate,
  actualReleaseDate: drawings.actualReleaseDate,
  completionStatus: drawings.completionStatus,
  releaseEvidence: drawings.releaseEvidence,
  remarks: drawings.remarks,
  planPeriodLabel: drawings.planPeriodLabel,
  rescheduleCount: drawings.rescheduleCount,
  responsibleUserId: drawings.responsibleUserId,
  responsibleName: responsible.name,
  responsibleText: drawings.responsibleText,
  isManual: drawings.isManual,
  /** "Updated On" (see lib/updated-on): the Drawing Control edit, else the
   *  source date, else the source period. Never the time an import ran. */
  editedAt: drawings.editedAt,
  sourceDate: drawings.sourceDate,
  sourcePeriodLabel: drawings.sourcePeriodLabel,
  sourcePeriodEnd: drawings.sourcePeriodEnd,
  /** Sortable instant of "Updated On" (null when the source gives neither a date nor a period). */
  updatedOn: sql<Date | null>`coalesce(${drawings.editedAt}, ${drawings.sourceDate}, ${drawings.sourcePeriodEnd})`.mapWith(drawings.createdAt),
  scheduleStatus: drawingScheduleStatusSql(),
};

export type DrawingRegisterRow = Awaited<ReturnType<typeof listDrawings>>['rows'][number];

const SORTS: Record<string, unknown> = {
  code: drawings.drawingCode,
  name: drawings.drawingName,
  project: projects.projectName,
  phase: projectPhases.code,
  discipline: disciplines.code,
  batch: drawings.batchCode,
  package: packages.packageCode,
  revision: drawings.revision,
  release: drawings.completionStatus,
  completion: drawings.completionStatus,
  baseline: drawings.baselineReleaseDate,
  expected: drawings.currentExpectedReleaseDate,
  actual: drawings.actualReleaseDate,
  updated: sql`coalesce(${drawings.editedAt}, ${drawings.sourceDate}, ${drawings.sourcePeriodEnd})`,
};

/** Sort order; drawings with no date sort last either way. */
function orderOf(f: DrawingFilters): SQL {
  const col = (SORTS[f.sort ?? 'code'] ?? drawings.drawingCode) as SQL;
  return f.dir === 'desc' ? sql`${col} desc nulls last` : sql`${col} asc nulls last`;
}

function baseQuery() {
  return db
    .select(drawingRowSelect)
    .from(drawings)
    .leftJoin(projects, eq(drawings.projectId, projects.id))
    .leftJoin(projectPhases, eq(drawings.phaseId, projectPhases.id))
    .leftJoin(packages, eq(drawings.packageId, packages.id))
    .leftJoin(disciplines, eq(drawings.disciplineId, disciplines.id))
    .leftJoin(responsible, eq(drawings.responsibleUserId, responsible.id));
}

export async function listDrawings(f: DrawingFilters, extra?: SQL) {
  const base = drawingWhere(f);
  const where = extra ? (base ? and(base, extra) : extra) : base;
  const page = f.page ?? 1;
  const pageSize = f.pageSize ?? 50;
  const order = orderOf(f);
  const [rows, counted] = await Promise.all([
    baseQuery()
      .where(where)
      .orderBy(order, asc(drawings.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(drawings).where(where),
  ]);
  const enriched = rows.map((r) => ({ ...r, schedule: assessDrawing(r) }));
  return pageOf(enriched, Number(counted[0]?.n ?? 0), page, pageSize);
}

/** Every row matching the filters (for export), capped — in the list's sort order when one is chosen. */
export async function allDrawings(f: DrawingFilters, cap = 50_000) {
  return baseQuery()
    .where(drawingWhere(f))
    .orderBy(...(f.sort ? [orderOf(f), asc(drawings.drawingCode)] : [asc(projects.projectCode), asc(drawings.drawingCode)]))
    .limit(cap);
}

// ---------------------------------------------------------------------------
// KPIs and look-ahead
// ---------------------------------------------------------------------------

export interface DrawingKpis {
  total: number;
  released: number;
  notReleased: number;
  dueSoon: number;
  delayed: number;
  releasedThisWeek: number;
  releasedThisMonth: number;
  notYetNumbered: number;
  releaseDateNotRecorded: number;
  rescheduled: number;
}

/**
 * "Released this week / month" count ONLY real actual release dates. Release
 * evidence ("Issued before 01-Jan-2026", "Issued 2025 Q3") is never turned
 * into a date.
 */
export async function drawingKpis(f: DrawingFilters): Promise<DrawingKpis> {
  const status = drawingScheduleStatusSql();
  const weekStart = sql`date_trunc('week', now() at time zone 'UTC')`;
  const monthStart = sql`date_trunc('month', now() at time zone 'UTC')`;
  const actual = sql`(${drawings.actualReleaseDate} at time zone 'UTC')`;
  const [r] = await db
    .select({
      total: sql<number>`count(*)::int`,
      released: sql<number>`count(*) filter (where ${drawings.completionStatus} = 'COMPLETED')::int`,
      notReleased: sql<number>`count(*) filter (where ${drawings.completionStatus} = 'NOT_COMPLETED')::int`,
      dueSoon: sql<number>`count(*) filter (where ${status} = 'DUE_SOON')::int`,
      delayed: sql<number>`count(*) filter (where ${status} = 'DELAYED')::int`,
      releasedThisWeek: sql<number>`count(*) filter (where ${drawings.completionStatus} = 'COMPLETED' and ${drawings.actualReleaseDate} is not null and ${actual} >= ${weekStart} and ${actual} < ${weekStart} + interval '7 days')::int`,
      releasedThisMonth: sql<number>`count(*) filter (where ${drawings.completionStatus} = 'COMPLETED' and ${drawings.actualReleaseDate} is not null and ${actual} >= ${monthStart} and ${actual} < ${monthStart} + interval '1 month')::int`,
      notYetNumbered: sql<number>`count(*) filter (where ${drawings.numberStatus} = 'NOT_YET_NUMBERED')::int`,
      releaseDateNotRecorded: sql<number>`count(*) filter (where ${drawings.completionStatus} = 'COMPLETED' and ${drawings.actualReleaseDate} is null)::int`,
      rescheduled: sql<number>`count(*) filter (where ${drawings.rescheduleCount} > 0)::int`,
    })
    .from(drawings)
    .where(drawingWhere(f));
  return {
    total: r?.total ?? 0,
    released: r?.released ?? 0,
    notReleased: r?.notReleased ?? 0,
    dueSoon: r?.dueSoon ?? 0,
    delayed: r?.delayed ?? 0,
    releasedThisWeek: r?.releasedThisWeek ?? 0,
    releasedThisMonth: r?.releasedThisMonth ?? 0,
    notYetNumbered: r?.notYetNumbered ?? 0,
    releaseDateNotRecorded: r?.releaseDateNotRecorded ?? 0,
    rescheduled: r?.rescheduled ?? 0,
  };
}

export type LookAheadBucket = 'OVERDUE' | 'THIS_WEEK' | 'NEXT_WEEK';

/**
 * Two-week look-ahead from `current_expected_release_date`, NOT RELEASED
 * drawings only. Weeks run Monday–Sunday (UTC).
 */
export async function drawingLookAhead(f: DrawingFilters, limit = 200) {
  const exp = sql`(${drawings.currentExpectedReleaseDate} at time zone 'UTC')`;
  const weekStart = sql`date_trunc('week', now() at time zone 'UTC')`;
  const today = sql`date_trunc('day', now() at time zone 'UTC')`;
  const bucket = sql<LookAheadBucket | null>`(case
    when ${exp} < ${today} then 'OVERDUE'
    when ${exp} < ${weekStart} + interval '7 days' then 'THIS_WEEK'
    when ${exp} < ${weekStart} + interval '14 days' then 'NEXT_WEEK'
    else null end)`;
  const base = and(
    drawingWhere({ ...f, release: undefined }),
    eq(drawings.completionStatus, 'NOT_COMPLETED'),
    isNotNull(drawings.currentExpectedReleaseDate),
    sql`${exp} < ${weekStart} + interval '14 days'`,
  );
  const [counts, rows] = await Promise.all([
    db
      .select({ bucket, n: sql<number>`count(*)::int` })
      .from(drawings)
      .where(base)
      .groupBy(sql`1`),
    db
      .select({ ...drawingRowSelect, bucket })
      .from(drawings)
      .leftJoin(projects, eq(drawings.projectId, projects.id))
      .leftJoin(projectPhases, eq(drawings.phaseId, projectPhases.id))
      .leftJoin(packages, eq(drawings.packageId, packages.id))
      .leftJoin(disciplines, eq(drawings.disciplineId, disciplines.id))
      .leftJoin(responsible, eq(drawings.responsibleUserId, responsible.id))
      .where(base)
      .orderBy(asc(drawings.currentExpectedReleaseDate), asc(drawings.drawingCode))
      .limit(limit * 3),
  ]);
  const total: Record<LookAheadBucket, number> = { OVERDUE: 0, THIS_WEEK: 0, NEXT_WEEK: 0 };
  for (const c of counts) if (c.bucket) total[c.bucket] = c.n;
  const by: Record<LookAheadBucket, typeof rows> = { OVERDUE: [], THIS_WEEK: [], NEXT_WEEK: [] };
  for (const r of rows) if (r.bucket && by[r.bucket].length < limit) by[r.bucket].push(r);
  return { counts: total, rows: by };
}

// ---------------------------------------------------------------------------
// Reference lists for the filters
// ---------------------------------------------------------------------------

export async function drawingReference(projectId?: string) {
  const [prj, phases, discs, pkgs, batches, resp, grouped] = await Promise.all([
    db
      .selectDistinct({ id: projects.id, code: projects.projectCode, name: projects.projectName, displayName: projects.displayName })
      .from(drawings)
      .innerJoin(projects, eq(drawings.projectId, projects.id))
      .orderBy(asc(projects.projectCode)),
    db
      .select({ id: projectPhases.id, code: projectPhases.code, projectId: projectPhases.projectId })
      .from(projectPhases)
      .where(projectId ? sql`${projectPhases.projectId} in ${projectAndBelow(projectId)}` : sql`exists (select 1 from ${drawings} where ${drawings.phaseId} = ${projectPhases.id})`)
      .orderBy(asc(projectPhases.code)),
    db.select({ id: disciplines.id, code: disciplines.code, name: disciplines.name }).from(disciplines).orderBy(asc(disciplines.sortOrder)),
    db
      .selectDistinct({ id: packages.id, code: packages.packageCode, name: packages.packageName })
      .from(drawings)
      .innerJoin(packages, eq(drawings.packageId, packages.id))
      .where(projectId ? sql`${drawings.projectId} in ${projectAndBelow(projectId)}` : undefined)
      .orderBy(asc(packages.packageCode)),
    projectId
      ? db
          .selectDistinct({ code: drawings.batchCode })
          .from(drawings)
          .where(and(sql`${drawings.projectId} in ${projectAndBelow(projectId)}`, isNotNull(drawings.batchCode), sql`${drawings.batchCode} <> ''`))
          .orderBy(asc(drawings.batchCode))
      : Promise.resolve([] as { code: string | null }[]),
    db
      .selectDistinct({ id: users.id, name: users.name })
      .from(drawings)
      .innerJoin(users, eq(drawings.responsibleUserId, users.id))
      .orderBy(asc(users.name)),
    projectOptions(),
  ]);
  return { projectOptions: grouped, projects: prj, phases, disciplines: discs, packages: pkgs, batches: batches.map((b) => b.code!).filter(Boolean), responsibles: resp };
}

export interface ProjectOption {
  value: string;
  /** Indented under its parent ("Pursuit of a Radical Rhapsody", then "  Tower 08"). */
  label: string;
  /** Full path, for places that list leaf projects only ("Pursuit of a Radical Rhapsody › Tower 08"). */
  path: string;
  depth: number;
  /** A project that holds drawings or packages itself (the create form offers these). */
  leaf: boolean;
}

/**
 * Projects with drawings or packages, grouped: each real (top-level) project,
 * then the towers / products below it, in display order. Driven by the data —
 * any number of levels and children.
 */
export async function projectOptions(opts: { drawingsOnly?: boolean } = {}): Promise<ProjectOption[]> {
  const all = await db.select().from(projects);
  const has = new Set(
    (
      await db
        .select({ id: projects.id })
        .from(projects)
        .where(
          // drawingsOnly (Project Drawing Status): a project with no drawings is an empty row, not an option.
          opts.drawingsOnly
            ? sql`${projects.archivedAt} is null and exists (select 1 from ${drawings} where ${drawings.projectId} = ${projects.id} and ${drawings.archivedAt} is null)`
            : or(
                sql`exists (select 1 from ${drawings} where ${drawings.projectId} = ${projects.id})`,
                sql`exists (select 1 from ${packages} where ${packages.projectId} = ${projects.id})`,
              ),
        )
    ).map((r) => r.id),
  );
  const byId = new Map(all.map((p) => [p.id, p]));
  const keep = new Set<string>();
  for (const id of has) for (let p = byId.get(id), g = 0; p && g < 20; p = p.parentProjectId ? byId.get(p.parentProjectId) : undefined, g++) keep.add(p.id);
  const kids = new Map<string | null, typeof all>();
  for (const p of all) {
    if (!keep.has(p.id)) continue;
    const parent = p.parentProjectId && keep.has(p.parentProjectId) ? p.parentProjectId : null;
    kids.set(parent, [...(kids.get(parent) ?? []), p]);
  }
  const order = (a: (typeof all)[number], b: (typeof all)[number]) =>
    (a.displayOrder ?? 1e6) - (b.displayOrder ?? 1e6) || projectLabel(a).localeCompare(projectLabel(b));
  const out: ProjectOption[] = [];
  const add = (p: (typeof all)[number], depth: number, path: string[]) => {
    const name = projectLabel(p);
    out.push({ value: p.id, label: `${'\u2003'.repeat(depth)}${name}`, path: [...path, name].join(' › '), depth, leaf: has.has(p.id) });
    for (const c of [...(kids.get(p.id) ?? [])].sort(order)) add(c, depth + 1, [...path, name]);
  };
  for (const p of [...(kids.get(null) ?? [])].sort(order)) add(p, 0, []);
  return out;
}

export async function activeUsers() {
  return db.select({ id: users.id, name: users.name, role: users.role }).from(users).where(eq(users.active, true)).orderBy(asc(users.name));
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export async function getDrawingDetail(id: string) {
  const [row] = await baseQuery().where(eq(drawings.id, id)).limit(1);
  if (!row) return null;
  const [full] = await db.select().from(drawings).where(eq(drawings.id, id)).limit(1);
  const releasedBy = full.releasedById
    ? (await db.select({ name: users.name }).from(users).where(eq(users.id, full.releasedById)).limit(1))[0]?.name ?? null
    : null;
  const [revisions, deps, reschedules, audit, snapshots, links, phaseMap] = await Promise.all([
    db.select().from(drawingRevisions).where(eq(drawingRevisions.drawingId, id)).orderBy(asc(drawingRevisions.sequence), asc(drawingRevisions.createdAt)),
    db.select().from(drawingDependencies).where(eq(drawingDependencies.drawingId, id)).orderBy(asc(drawingDependencies.createdAt)),
    db
      .select()
      .from(rescheduleHistory)
      .where(and(eq(rescheduleHistory.entityType, 'DRAWING'), eq(rescheduleHistory.entityId, id)))
      .orderBy(desc(rescheduleHistory.changedAt)),
    auditForEntity('DRAWING', id, 200),
    db
      .select()
      .from(drawingSnapshots)
      .where(eq(drawingSnapshots.drawingId, id))
      .orderBy(asc(drawingSnapshots.snapshotDate), asc(drawingSnapshots.sourceWorkbook), asc(drawingSnapshots.sourceRow)),
    db
      .select()
      .from(dependencies)
      .where(
        or(
          and(eq(dependencies.predecessorType, 'DRAWING'), eq(dependencies.predecessorId, id)),
          and(eq(dependencies.successorType, 'DRAWING'), eq(dependencies.successorId, id)),
        ),
      ),
    full.location
      ? db
          .select()
          .from(drawingLocationPhaseMap)
          .where(and(eq(drawingLocationPhaseMap.projectId, full.projectId), inArray(drawingLocationPhaseMap.locationCode, [full.location, '*'])))
      : Promise.resolve([]),
  ]);
  // The drawing's place in the base DFS: the headings above its package.
  const dfsPath: { type: string; name: string }[] = [];
  if (full.packageId) {
    const [pk] = await db.select({ wbsNodeId: packages.wbsNodeId }).from(packages).where(eq(packages.id, full.packageId)).limit(1);
    let nodeId = pk?.wbsNodeId ?? null;
    for (let guard = 0; nodeId && guard < 20; guard++) {
      const [n] = await db.select().from(dfsWbsNodes).where(eq(dfsWbsNodes.id, nodeId)).limit(1);
      if (!n) break;
      dfsPath.unshift({ type: n.nodeType, name: n.name });
      nodeId = n.parentId;
    }
  }
  // The project as the DFS shows it: "Pursuit of a Radical Rhapsody › Residential".
  const allProjects = await db.select().from(projects);
  const byId = new Map(allProjects.map((p) => [p.id, p]));
  const chain: string[] = [];
  for (let p = byId.get(row.projectId), g = 0; p && g < 20; p = p.parentProjectId ? byId.get(p.parentProjectId) : undefined, g++) chain.unshift(projectLabel(p));
  return {
    drawing: { ...row, schedule: assessDrawing(row) },
    full: { ...full, releasedByName: releasedBy },
    projectPath: chain.join(' › '),
    dfsPath,
    revisions,
    dependencies: deps,
    reschedules,
    audit,
    snapshots,
    scheduleLinks: links,
    phaseMap,
  };
}

// ---------------------------------------------------------------------------
// Admin views
// ---------------------------------------------------------------------------

export async function listConflicts(status?: string, projectId?: string) {
  const conds = [];
  if (status) conds.push(eq(drawingConflicts.status, status));
  if (projectId) conds.push(eq(drawingConflicts.projectId, projectId));
  return db
    .select({
      id: drawingConflicts.id,
      projectId: drawingConflicts.projectId,
      projectCode: projects.projectCode,
      conflictType: drawingConflicts.conflictType,
      drawingNumber: drawingConflicts.drawingNumber,
      status: drawingConflicts.status,
      candidateCount: drawingConflicts.candidateCount,
      candidates: drawingConflicts.candidates,
      message: drawingConflicts.message,
      resolutionNote: drawingConflicts.resolutionNote,
      resolvedDrawingId: drawingConflicts.resolvedDrawingId,
      resolvedByLabel: drawingConflicts.resolvedByLabel,
      resolvedAt: drawingConflicts.resolvedAt,
    })
    .from(drawingConflicts)
    .leftJoin(projects, eq(drawingConflicts.projectId, projects.id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(projects.projectCode), asc(drawingConflicts.conflictType), asc(drawingConflicts.drawingNumber));
}

export async function listImportBatches(limit = 10) {
  return db.select().from(drawingImportBatches).orderBy(desc(drawingImportBatches.startedAt)).limit(limit);
}

export async function listImportIssues(batchId: string, code?: string, limit = 500) {
  return db
    .select()
    .from(drawingImportIssues)
    .where(code ? and(eq(drawingImportIssues.batchId, batchId), eq(drawingImportIssues.code, code)) : eq(drawingImportIssues.batchId, batchId))
    .limit(limit);
}

export async function listPhaseMap(projectId?: string) {
  return db
    .select({
      id: drawingLocationPhaseMap.id,
      projectCode: projects.projectCode,
      locationCode: drawingLocationPhaseMap.locationCode,
      zoneCode: drawingLocationPhaseMap.zoneCode,
      phaseCode: projectPhases.code,
      rule: drawingLocationPhaseMap.rule,
      note: drawingLocationPhaseMap.note,
    })
    .from(drawingLocationPhaseMap)
    .leftJoin(projects, eq(drawingLocationPhaseMap.projectId, projects.id))
    .leftJoin(projectPhases, eq(drawingLocationPhaseMap.phaseId, projectPhases.id))
    .where(projectId ? eq(drawingLocationPhaseMap.projectId, projectId) : undefined)
    .orderBy(asc(projects.projectCode), asc(drawingLocationPhaseMap.locationCode), asc(drawingLocationPhaseMap.zoneCode));
}

export { lte };
export type { Paged };
