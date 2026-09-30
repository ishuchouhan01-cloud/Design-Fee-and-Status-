/**
 * Read paths for Design Goals FY 26.
 *
 * Filtering, sorting and paging happen in SQL. Every KPI here is derived at
 * read time — nothing stores a percentage or a roll-up.
 */
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db';
import {
  disciplines,
  fy26ImportBatches,
  fy26ImportIssues,
  fy26PackageDependencies,
  fy26PackageRevisions,
  fy26Packages,
  fy26Phases,
  fy26Projects,
  projects,
  users,
} from '@/db/schema';
import type { Fy26ListFilters } from '@/lib/validation';

export interface Fy26PackageRow {
  id: string;
  projectId: string;
  projectName: string;
  legacyProjectId: string | null;
  phaseId: string | null;
  phaseName: string | null;
  phaseSourceLabel: string | null;
  disciplineId: string | null;
  disciplineName: string | null;
  packageDescription: string;
  sourceScopeLabel: string | null;
  responsibleUserId: string | null;
  responsibleName: string | null;
  responsibleSourceText: string | null;
  baselineReleaseDate: Date | null;
  currentExpectedReleaseDate: Date | null;
  actualReleaseDate: Date | null;
  planBillingCr: number | null;
  actualBillingCr: number | null;
  plannedPackageQuantity: number | null;
  actualPackageQuantity: number | null;
  remarks: string | null;
  completionStatus: string;
  revisionCount: number;
  dependencyCount: number;
  sourceWorkbook: string;
  sourceSheet: string;
  sourceRow: number;
}

const dependencyCount = sql<number>`(
  select count(*)::int from ${fy26PackageDependencies}
  where ${fy26PackageDependencies.fy26PackageId} = ${fy26Packages.id}
)`;

const packageSelect = {
  id: fy26Packages.id,
  projectId: fy26Packages.fy26ProjectId,
  projectName: fy26Projects.projectName,
  legacyProjectId: fy26Projects.legacyProjectId,
  phaseId: fy26Packages.fy26PhaseId,
  phaseName: fy26Phases.phaseName,
  phaseSourceLabel: fy26Phases.sourceLabel,
  disciplineId: fy26Packages.disciplineId,
  disciplineName: disciplines.name,
  packageDescription: fy26Packages.packageDescription,
  sourceScopeLabel: fy26Packages.sourceScopeLabel,
  responsibleUserId: fy26Packages.responsibleUserId,
  responsibleName: users.name,
  responsibleSourceText: fy26Packages.responsibleSourceText,
  baselineReleaseDate: fy26Packages.baselineReleaseDate,
  currentExpectedReleaseDate: fy26Packages.currentExpectedReleaseDate,
  actualReleaseDate: fy26Packages.actualReleaseDate,
  planBillingCr: fy26Packages.planBillingCr,
  actualBillingCr: fy26Packages.actualBillingCr,
  plannedPackageQuantity: fy26Packages.plannedPackageQuantity,
  actualPackageQuantity: fy26Packages.actualPackageQuantity,
  remarks: fy26Packages.remarks,
  completionStatus: fy26Packages.completionStatus,
  revisionCount: fy26Packages.revisionCount,
  dependencyCount,
  sourceWorkbook: fy26Packages.sourceWorkbook,
  sourceSheet: fy26Packages.sourceSheet,
  sourceRow: fy26Packages.sourceRow,
};

function baseQuery() {
  return db
    .select(packageSelect)
    .from(fy26Packages)
    .innerJoin(fy26Projects, eq(fy26Packages.fy26ProjectId, fy26Projects.id))
    .leftJoin(fy26Phases, eq(fy26Packages.fy26PhaseId, fy26Phases.id))
    .leftJoin(disciplines, eq(fy26Packages.disciplineId, disciplines.id))
    .leftJoin(users, eq(fy26Packages.responsibleUserId, users.id));
}

/** ILIKE, not LIKE — PostgreSQL's LIKE is case-sensitive. */
function searchCondition(term: string): SQL | undefined {
  const s = `%${term}%`;
  return or(
    ilike(fy26Packages.packageDescription, s),
    ilike(fy26Packages.remarks, s),
    ilike(fy26Packages.sourceScopeLabel, s),
    ilike(fy26Packages.responsibleSourceText, s),
    ilike(fy26Projects.projectName, s),
    ilike(fy26Phases.phaseName, s),
    ilike(users.name, s),
    sql`exists (
      select 1 from ${fy26PackageDependencies} d
      where d.fy26_package_id = ${fy26Packages.id}
        and (d.description ilike ${s} or d.responsible_text ilike ${s} or d.remarks ilike ${s})
    )`,
  );
}

function conditions(filters: Fy26ListFilters): SQL[] {
  const conds: SQL[] = [];
  if (filters.search?.trim()) {
    const c = searchCondition(filters.search.trim());
    if (c) conds.push(c);
  }
  if (filters.projectId) conds.push(eq(fy26Packages.fy26ProjectId, filters.projectId));
  if (filters.phaseId) conds.push(eq(fy26Packages.fy26PhaseId, filters.phaseId));
  if (filters.disciplineId) conds.push(eq(fy26Packages.disciplineId, filters.disciplineId));
  if (filters.responsibleId) conds.push(eq(fy26Packages.responsibleUserId, filters.responsibleId));
  if (filters.completionStatus) conds.push(eq(fy26Packages.completionStatus, filters.completionStatus));
  if (filters.releaseFrom) conds.push(gte(fy26Packages.currentExpectedReleaseDate, filters.releaseFrom));
  if (filters.releaseTo) conds.push(lte(fy26Packages.currentExpectedReleaseDate, filters.releaseTo));
  if (filters.hasDependencies === 'YES') conds.push(sql`${dependencyCount} > 0`);
  if (filters.hasDependencies === 'NO') conds.push(sql`${dependencyCount} = 0`);
  return conds;
}

const SORTS = {
  project: fy26Projects.projectName,
  phase: fy26Phases.phaseName,
  discipline: disciplines.name,
  description: fy26Packages.packageDescription,
  release: fy26Packages.currentExpectedReleaseDate,
  baseline: fy26Packages.baselineReleaseDate,
  billing: fy26Packages.planBillingCr,
  quantity: fy26Packages.plannedPackageQuantity,
  status: fy26Packages.completionStatus,
} as const;

export interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listFy26Packages(filters: Fy26ListFilters): Promise<Paged<Fy26PackageRow>> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(200, Math.max(5, filters.pageSize ?? 50));
  const conds = conditions(filters);
  const where = conds.length ? and(...conds) : undefined;

  const sortCol = SORTS[(filters.sort as keyof typeof SORTS) ?? 'release'] ?? SORTS.release;
  const direction = filters.dir === 'desc' ? desc : asc;

  const rows = await baseQuery()
    .where(where)
    .orderBy(
      direction(sortCol),
      asc(fy26Projects.projectName),
      asc(fy26Phases.sequence),
      asc(fy26Packages.sourceWorkbook),
      asc(fy26Packages.sourceRow),
      asc(fy26Packages.id),
    )
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(fy26Packages)
    .innerJoin(fy26Projects, eq(fy26Packages.fy26ProjectId, fy26Projects.id))
    .leftJoin(fy26Phases, eq(fy26Packages.fy26PhaseId, fy26Phases.id))
    .leftJoin(disciplines, eq(fy26Packages.disciplineId, disciplines.id))
    .leftJoin(users, eq(fy26Packages.responsibleUserId, users.id))
    .where(where);

  return { rows: rows as Fy26PackageRow[], total, page, pageSize };
}

export async function getFy26Package(id: string): Promise<Fy26PackageRow | null> {
  const [row] = await baseQuery().where(eq(fy26Packages.id, id)).limit(1);
  return (row as Fy26PackageRow) ?? null;
}

export interface Fy26DependencyRow {
  id: string;
  fy26PackageId: string;
  sequence: number;
  stepLabel: string | null;
  description: string;
  targetDate: Date | null;
  responsibleText: string | null;
  remarks: string | null;
  completionStatus: string;
  isManual: boolean;
  sourceWorkbook: string | null;
  sourceSheet: string | null;
  sourceRow: number | null;
}

export async function listDependencies(packageId: string): Promise<Fy26DependencyRow[]> {
  const rows = await db
    .select()
    .from(fy26PackageDependencies)
    .where(eq(fy26PackageDependencies.fy26PackageId, packageId))
    .orderBy(asc(fy26PackageDependencies.sequence), asc(fy26PackageDependencies.id));
  return rows as Fy26DependencyRow[];
}

/** Dependencies for many packages in one round-trip, grouped by package. */
export async function dependenciesFor(packageIds: string[]): Promise<Map<string, Fy26DependencyRow[]>> {
  const out = new Map<string, Fy26DependencyRow[]>();
  if (packageIds.length === 0) return out;
  const rows = await db
    .select()
    .from(fy26PackageDependencies)
    .where(inArray(fy26PackageDependencies.fy26PackageId, packageIds))
    .orderBy(asc(fy26PackageDependencies.sequence), asc(fy26PackageDependencies.id));
  for (const r of rows as Fy26DependencyRow[]) {
    const list = out.get(r.fy26PackageId) ?? [];
    list.push(r);
    out.set(r.fy26PackageId, list);
  }
  return out;
}

export async function listImportBatches(limit = 20) {
  return db.select().from(fy26ImportBatches).orderBy(desc(fy26ImportBatches.startedAt)).limit(limit);
}

export async function getDependency(id: string): Promise<Fy26DependencyRow | null> {
  const [row] = await db
    .select()
    .from(fy26PackageDependencies)
    .where(eq(fy26PackageDependencies.id, id))
    .limit(1);
  return (row as Fy26DependencyRow) ?? null;
}

export async function listRevisions(packageId: string) {
  return db
    .select()
    .from(fy26PackageRevisions)
    .where(eq(fy26PackageRevisions.fy26PackageId, packageId))
    .orderBy(desc(fy26PackageRevisions.changedAt));
}

// ---------------------------------------------------------------------------
// Reference data for the filter bar
// ---------------------------------------------------------------------------

export async function fy26Reference() {
  const [projectRows, phaseRows, disciplineRows, responsibleRows] = await Promise.all([
    db
      .select({
        id: fy26Projects.id,
        name: fy26Projects.projectName,
        code: fy26Projects.projectCode,
        legacyProjectId: fy26Projects.legacyProjectId,
        legacyProjectName: projects.projectName,
      })
      .from(fy26Projects)
      .leftJoin(projects, eq(fy26Projects.legacyProjectId, projects.id))
      .orderBy(asc(fy26Projects.projectName)),
    db
      .select({
        id: fy26Phases.id,
        projectId: fy26Phases.fy26ProjectId,
        name: fy26Phases.phaseName,
        sourceLabel: fy26Phases.sourceLabel,
      })
      .from(fy26Phases)
      .orderBy(asc(fy26Phases.sequence), asc(fy26Phases.phaseName)),
    db
      .select({ id: disciplines.id, name: disciplines.name, code: disciplines.code })
      .from(disciplines)
      .orderBy(asc(disciplines.sortOrder)),
    db
      .selectDistinct({ id: users.id, name: users.name })
      .from(fy26Packages)
      .innerJoin(users, eq(fy26Packages.responsibleUserId, users.id))
      .orderBy(asc(users.name)),
  ]);
  return { projects: projectRows, phases: phaseRows, disciplines: disciplineRows, responsibles: responsibleRows };
}

// ---------------------------------------------------------------------------
// KPIs — all derived, none stored
// ---------------------------------------------------------------------------

export interface Fy26Kpis {
  packages: number;
  completed: number;
  notCompleted: number;
  completionPercent: number;
  dependencies: number;
  dependenciesCompleted: number;
  planBillingCr: number;
  actualBillingCr: number;
  plannedQuantity: number;
  actualQuantity: number;
  overdue: number;
  noReleaseDate: number;
}

export async function fy26Kpis(filters: Fy26ListFilters = {}): Promise<Fy26Kpis> {
  const conds = conditions(filters);
  const where = conds.length ? and(...conds) : undefined;

  const [agg] = await db
    .select({
      packages: sql<number>`count(*)::int`,
      completed: sql<number>`count(*) filter (where ${fy26Packages.completionStatus} = 'COMPLETED')::int`,
      planBillingCr: sql<number>`coalesce(sum(${fy26Packages.planBillingCr}), 0)::double precision`,
      actualBillingCr: sql<number>`coalesce(sum(${fy26Packages.actualBillingCr}), 0)::double precision`,
      plannedQuantity: sql<number>`coalesce(sum(${fy26Packages.plannedPackageQuantity}), 0)::int`,
      actualQuantity: sql<number>`coalesce(sum(${fy26Packages.actualPackageQuantity}), 0)::int`,
      overdue: sql<number>`count(*) filter (
        where ${fy26Packages.completionStatus} = 'NOT_COMPLETED'
          and ${fy26Packages.currentExpectedReleaseDate} < now()
      )::int`,
      noReleaseDate: sql<number>`count(*) filter (where ${fy26Packages.currentExpectedReleaseDate} is null)::int`,
    })
    .from(fy26Packages)
    .innerJoin(fy26Projects, eq(fy26Packages.fy26ProjectId, fy26Projects.id))
    .leftJoin(fy26Phases, eq(fy26Packages.fy26PhaseId, fy26Phases.id))
    .leftJoin(disciplines, eq(fy26Packages.disciplineId, disciplines.id))
    .leftJoin(users, eq(fy26Packages.responsibleUserId, users.id))
    .where(where);

  const [dep] = await db
    .select({
      total: sql<number>`count(*)::int`,
      completed: sql<number>`count(*) filter (where ${fy26PackageDependencies.completionStatus} = 'COMPLETED')::int`,
    })
    .from(fy26PackageDependencies);

  const packages = agg?.packages ?? 0;
  const completed = agg?.completed ?? 0;

  return {
    packages,
    completed,
    notCompleted: packages - completed,
    // Derived here, at read time. No percentage is ever stored.
    completionPercent: packages === 0 ? 0 : Math.round((completed / packages) * 1000) / 10,
    dependencies: dep?.total ?? 0,
    dependenciesCompleted: dep?.completed ?? 0,
    planBillingCr: agg?.planBillingCr ?? 0,
    actualBillingCr: agg?.actualBillingCr ?? 0,
    plannedQuantity: agg?.plannedQuantity ?? 0,
    actualQuantity: agg?.actualQuantity ?? 0,
    overdue: agg?.overdue ?? 0,
    noReleaseDate: agg?.noReleaseDate ?? 0,
  };
}

/** Project → phase → package counts, for the hierarchy panel. */
export async function fy26Tree() {
  const rows = await db
    .select({
      projectId: fy26Projects.id,
      projectName: fy26Projects.projectName,
      legacyProjectId: fy26Projects.legacyProjectId,
      phaseId: fy26Phases.id,
      phaseName: fy26Phases.phaseName,
      packages: sql<number>`count(${fy26Packages.id})::int`,
      completed: sql<number>`count(*) filter (where ${fy26Packages.completionStatus} = 'COMPLETED')::int`,
      planBillingCr: sql<number>`coalesce(sum(${fy26Packages.planBillingCr}), 0)::double precision`,
    })
    .from(fy26Packages)
    .innerJoin(fy26Projects, eq(fy26Packages.fy26ProjectId, fy26Projects.id))
    .leftJoin(fy26Phases, eq(fy26Packages.fy26PhaseId, fy26Phases.id))
    .groupBy(fy26Projects.id, fy26Projects.projectName, fy26Projects.legacyProjectId, fy26Phases.id, fy26Phases.phaseName)
    .orderBy(asc(fy26Projects.projectName), asc(fy26Phases.phaseName));
  return rows;
}

// ---------------------------------------------------------------------------
// Import batches and issues
// ---------------------------------------------------------------------------

export async function latestImportBatch() {
  const [row] = await db.select().from(fy26ImportBatches).orderBy(desc(fy26ImportBatches.startedAt)).limit(1);
  return row ?? null;
}

export async function listImportIssues(batchId: string, severity?: string, code?: string, limit = 500) {
  const conds: SQL[] = [eq(fy26ImportIssues.batchId, batchId)];
  if (severity) conds.push(eq(fy26ImportIssues.severity, severity));
  if (code) conds.push(eq(fy26ImportIssues.code, code));
  return db
    .select()
    .from(fy26ImportIssues)
    .where(and(...conds))
    .orderBy(asc(fy26ImportIssues.severity), asc(fy26ImportIssues.workbook), asc(fy26ImportIssues.rowNumber))
    .limit(limit);
}

export async function importIssueSummary(batchId: string) {
  return db
    .select({
      code: fy26ImportIssues.code,
      severity: fy26ImportIssues.severity,
      total: sql<number>`count(*)::int`,
    })
    .from(fy26ImportIssues)
    .where(eq(fy26ImportIssues.batchId, batchId))
    .groupBy(fy26ImportIssues.code, fy26ImportIssues.severity)
    .orderBy(desc(sql`count(*)`));
}
