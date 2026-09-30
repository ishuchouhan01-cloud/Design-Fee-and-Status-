/**
 * Server-side filtered/paged queries for the three delivery registers and the
 * goals register. Filtering and paging happen in SQL, never in the browser
 * (spec §44).
 */
import { and, asc, desc, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db';
import { deliverables, disciplines, drawings, goals, packages, projectPhases, projects, users } from '@/db/schema';
import { assessSchedule } from '@/lib/schedule';
import { pageOf, type ListFilters, type Paged } from './filters';

/**
 * Case-insensitive contains-match across several columns.
 *
 * ILIKE, not LIKE: SQLite's LIKE ignored case for ASCII, PostgreSQL's does not.
 * Using LIKE here would have quietly turned every search box case-sensitive.
 */
function likeAll(term: string, cols: SQL[] | ReturnType<typeof sql>[]) {
  const s = `%${term}%`;
  return or(...cols.map((c) => ilike(c as never, s)));
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

export interface GoalRow {
  id: string;
  goalCode: string;
  goalDescription: string;
  projectId: string;
  projectName: string;
  projectDisplayName: string | null;
  phaseCode: string | null;
  disciplineName: string | null;
  disciplineId: string | null;
  designLeadName: string | null;
  designLeadId: string | null;
  fiscalYear: string;
  quarter: number;
  plannedQuantity: number;
  plannedValue: number;
  reportedActualQuantity: number;
  reportedActualValue: number;
  baselineTargetDate: Date;
  currentExpectedDate: Date;
  actualCompletionDate: Date | null;
  completionStatus: string;
  priority: string;
  remarks: string | null;
  rescheduleCount: number;
  isBaselineRevision: boolean;
}

const goalSelect = {
  id: goals.id,
  goalCode: goals.goalCode,
  goalDescription: goals.goalDescription,
  projectId: goals.projectId,
  projectName: projects.projectName,
  projectDisplayName: projects.displayName,
  phaseCode: projectPhases.code,
  disciplineName: disciplines.name,
  disciplineId: goals.disciplineId,
  designLeadName: users.name,
  designLeadId: goals.designLeadId,
  fiscalYear: goals.fiscalYear,
  quarter: goals.quarter,
  plannedQuantity: goals.plannedQuantity,
  plannedValue: goals.plannedValue,
  reportedActualQuantity: goals.reportedActualQuantity,
  reportedActualValue: goals.reportedActualValue,
  baselineTargetDate: goals.baselineTargetDate,
  currentExpectedDate: goals.currentExpectedDate,
  actualCompletionDate: goals.actualCompletionDate,
  completionStatus: goals.completionStatus,
  priority: goals.priority,
  remarks: goals.remarks,
  rescheduleCount: goals.rescheduleCount,
  isBaselineRevision: goals.isBaselineRevision,
};

function goalConditions(f: ListFilters) {
  const c: (SQL | undefined)[] = [];
  if (f.projectId) c.push(eq(goals.projectId, f.projectId));
  if (f.phaseId) c.push(eq(goals.phaseId, f.phaseId));
  if (f.disciplineId) c.push(eq(goals.disciplineId, f.disciplineId));
  if (f.designLeadId) c.push(eq(goals.designLeadId, f.designLeadId));
  if (f.fiscalYear) c.push(eq(goals.fiscalYear, f.fiscalYear));
  if (f.quarter) c.push(eq(goals.quarter, f.quarter));
  if (f.completion) c.push(eq(goals.completionStatus, f.completion));
  if (f.priority) c.push(eq(goals.priority, f.priority));
  if (f.portfolio) c.push(eq(projects.portfolio, f.portfolio));
  if (f.rescheduled === true) c.push(sql`${goals.rescheduleCount} > 0`);
  if (f.rescheduled === false) c.push(sql`${goals.rescheduleCount} = 0`);
  if (f.search) {
    c.push(
      likeAll(f.search, [
        goals.goalDescription as never,
        goals.goalCode as never,
        projects.projectName as never,
        goals.remarks as never,
      ]) as SQL,
    );
  }
  return and(...c.filter(Boolean));
}

const GOAL_SORTS: Record<string, unknown> = {
  code: goals.goalCode,
  project: projects.projectName,
  description: goals.goalDescription,
  quarter: goals.quarter,
  planned: goals.plannedQuantity,
  value: goals.plannedValue,
  expected: goals.currentExpectedDate,
  baseline: goals.baselineTargetDate,
  completion: goals.completionStatus,
};

export async function queryGoals(f: ListFilters): Promise<Paged<GoalRow & { schedule: ReturnType<typeof assessSchedule> }>> {
  const where = goalConditions(f);
  const page = f.page ?? 1;
  const pageSize = f.pageSize ?? 50;
  const sortCol = GOAL_SORTS[f.sort ?? 'expected'] ?? goals.currentExpectedDate;
  const order = f.dir === 'desc' ? desc(sortCol as never) : asc(sortCol as never);

  const base = db
    .select(goalSelect)
    .from(goals)
    .leftJoin(projects, eq(goals.projectId, projects.id))
    .leftJoin(projectPhases, eq(goals.phaseId, projectPhases.id))
    .leftJoin(disciplines, eq(goals.disciplineId, disciplines.id))
    .leftJoin(users, eq(goals.designLeadId, users.id))
    .where(where);

  const [rows, counted] = await Promise.all([
    base.orderBy(order).limit(pageSize).offset((page - 1) * pageSize),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(goals)
      .leftJoin(projects, eq(goals.projectId, projects.id))
      .where(where),
  ]);

  let enriched = rows.map((r) => ({
    ...r,
    schedule: assessSchedule({
      completionStatus: r.completionStatus,
      baselineDate: r.baselineTargetDate,
      expectedDate: r.currentExpectedDate,
      actualDate: r.actualCompletionDate,
      rescheduleCount: r.rescheduleCount,
    }),
  }));
  if (f.scheduleStatus) enriched = enriched.filter((r) => r.schedule.status === f.scheduleStatus);

  return pageOf(enriched as never, Number(counted[0]?.n ?? 0), page, pageSize);
}

export async function allGoalsForMetrics(f: ListFilters) {
  const where = goalConditions(f);
  return db
    .select({
      id: goals.id,
      projectId: goals.projectId,
      disciplineId: goals.disciplineId,
      designLeadId: goals.designLeadId,
      fiscalYear: goals.fiscalYear,
      quarter: goals.quarter,
      plannedQuantity: goals.plannedQuantity,
      plannedValue: goals.plannedValue,
      reportedActualQuantity: goals.reportedActualQuantity,
      reportedActualValue: goals.reportedActualValue,
      baselineTargetDate: goals.baselineTargetDate,
      currentExpectedDate: goals.currentExpectedDate,
      actualCompletionDate: goals.actualCompletionDate,
      completionStatus: goals.completionStatus,
      priority: goals.priority,
      rescheduleCount: goals.rescheduleCount,
    })
    .from(goals)
    .leftJoin(projects, eq(goals.projectId, projects.id))
    .where(where);
}

// ---------------------------------------------------------------------------
// Deliverables
// ---------------------------------------------------------------------------

const deliverableSelect = {
  id: deliverables.id,
  deliverableCode: deliverables.deliverableCode,
  deliverableDescription: deliverables.deliverableDescription,
  projectId: deliverables.projectId,
  projectName: projects.projectName,
  projectDisplayName: projects.displayName,
  packageId: deliverables.packageId,
  packageCode: packages.packageCode,
  packageName: packages.packageName,
  disciplineId: deliverables.disciplineId,
  disciplineName: disciplines.name,
  goalId: deliverables.goalId,
  ownerId: deliverables.ownerId,
  ownerName: users.name,
  baselineReleaseDate: deliverables.baselineReleaseDate,
  currentExpectedReleaseDate: deliverables.currentExpectedReleaseDate,
  actualReleaseDate: deliverables.actualReleaseDate,
  completionStatus: deliverables.completionStatus,
  revision: deliverables.revision,
  remarks: deliverables.remarks,
  rescheduleCount: deliverables.rescheduleCount,
  fiscalYear: deliverables.fiscalYear,
  quarter: deliverables.quarter,
};

function deliverableConditions(f: ListFilters) {
  const c: (SQL | undefined)[] = [];
  if (f.projectId) c.push(eq(deliverables.projectId, f.projectId));
  if (f.phaseId) c.push(eq(deliverables.phaseId, f.phaseId));
  if (f.disciplineId) c.push(eq(deliverables.disciplineId, f.disciplineId));
  if (f.packageId) c.push(eq(deliverables.packageId, f.packageId));
  if (f.goalId) c.push(eq(deliverables.goalId, f.goalId));
  if (f.ownerId) c.push(eq(deliverables.ownerId, f.ownerId));
  if (f.completion) c.push(eq(deliverables.completionStatus, f.completion));
  if (f.portfolio) c.push(eq(projects.portfolio, f.portfolio));
  if (f.rescheduled === true) c.push(sql`${deliverables.rescheduleCount} > 0`);
  if (f.rescheduled === false) c.push(sql`${deliverables.rescheduleCount} = 0`);
  if (f.quarter) {
    // Calendar quarter of the current expected release date.
    c.push(
      sql`extract(month from ${deliverables.currentExpectedReleaseDate}) between ${(f.quarter - 1) * 3 + 1} and ${(f.quarter - 1) * 3 + 3}`,
    );
  }
  if (f.search) {
    c.push(
      likeAll(f.search, [
        deliverables.deliverableDescription as never,
        deliverables.deliverableCode as never,
        projects.projectName as never,
        deliverables.remarks as never,
      ]) as SQL,
    );
  }
  return and(...c.filter(Boolean));
}

const DELIVERABLE_SORTS: Record<string, unknown> = {
  code: deliverables.deliverableCode,
  description: deliverables.deliverableDescription,
  project: projects.projectName,
  package: packages.packageCode,
  baseline: deliverables.baselineReleaseDate,
  expected: deliverables.currentExpectedReleaseDate,
  actual: deliverables.actualReleaseDate,
  completion: deliverables.completionStatus,
};

export async function queryDeliverables(f: ListFilters) {
  const where = deliverableConditions(f);
  const page = f.page ?? 1;
  const pageSize = f.pageSize ?? 50;
  const sortCol = DELIVERABLE_SORTS[f.sort ?? 'expected'] ?? deliverables.currentExpectedReleaseDate;
  const order = f.dir === 'desc' ? desc(sortCol as never) : asc(sortCol as never);

  const [rows, counted] = await Promise.all([
    db
      .select(deliverableSelect)
      .from(deliverables)
      .leftJoin(projects, eq(deliverables.projectId, projects.id))
      .leftJoin(packages, eq(deliverables.packageId, packages.id))
      .leftJoin(disciplines, eq(deliverables.disciplineId, disciplines.id))
      .leftJoin(users, eq(deliverables.ownerId, users.id))
      .where(where)
      .orderBy(order)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(deliverables)
      .leftJoin(projects, eq(deliverables.projectId, projects.id))
      .where(where),
  ]);

  let enriched = rows.map((r) => ({
    ...r,
    schedule: assessSchedule({
      completionStatus: r.completionStatus,
      baselineDate: r.baselineReleaseDate,
      expectedDate: r.currentExpectedReleaseDate,
      actualDate: r.actualReleaseDate,
      rescheduleCount: r.rescheduleCount,
    }),
  }));
  if (f.scheduleStatus) enriched = enriched.filter((r) => r.schedule.status === f.scheduleStatus);

  return pageOf(enriched, Number(counted[0]?.n ?? 0), page, pageSize);
}

export async function allDeliverablesForMetrics(f: ListFilters) {
  return db
    .select({
      id: deliverables.id,
      projectId: deliverables.projectId,
      disciplineId: deliverables.disciplineId,
      packageId: deliverables.packageId,
      goalId: deliverables.goalId,
      completionStatus: deliverables.completionStatus,
      baselineReleaseDate: deliverables.baselineReleaseDate,
      currentExpectedReleaseDate: deliverables.currentExpectedReleaseDate,
      actualReleaseDate: deliverables.actualReleaseDate,
      rescheduleCount: deliverables.rescheduleCount,
    })
    .from(deliverables)
    .leftJoin(projects, eq(deliverables.projectId, projects.id))
    .where(deliverableConditions(f));
}

// ---------------------------------------------------------------------------
// Drawings
// ---------------------------------------------------------------------------

const drawingSelect = {
  id: drawings.id,
  drawingCode: drawings.drawingCode,
  drawingNumber: drawings.drawingNumber,
  drawingName: drawings.drawingName,
  projectId: drawings.projectId,
  projectName: projects.projectName,
  projectDisplayName: projects.displayName,
  packageId: drawings.packageId,
  packageCode: packages.packageCode,
  packageName: packages.packageName,
  disciplineId: drawings.disciplineId,
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
  remarks: drawings.remarks,
  planPeriodLabel: drawings.planPeriodLabel,
  rescheduleCount: drawings.rescheduleCount,
};

function drawingConditions(f: ListFilters) {
  const c: (SQL | undefined)[] = [isNull(drawings.archivedAt)];
  if (f.projectId) c.push(eq(drawings.projectId, f.projectId));
  if (f.phaseId) c.push(eq(drawings.phaseId, f.phaseId));
  if (f.disciplineId) c.push(eq(drawings.disciplineId, f.disciplineId));
  if (f.packageId) c.push(eq(drawings.packageId, f.packageId));
  if (f.completion) c.push(eq(drawings.completionStatus, f.completion));
  if (f.portfolio) c.push(eq(projects.portfolio, f.portfolio));
  if (f.rescheduled === true) c.push(sql`${drawings.rescheduleCount} > 0`);
  if (f.rescheduled === false) c.push(sql`${drawings.rescheduleCount} = 0`);
  if (f.search) {
    c.push(
      likeAll(f.search, [
        drawings.drawingName as never,
        drawings.drawingCode as never,
        drawings.areaOfWorks as never,
        projects.projectName as never,
      ]) as SQL,
    );
  }
  return and(...c.filter(Boolean));
}

/**
 * Drawing list with the shared filter contract. Delegates to the Drawing
 * Register query, which applies the schedule-status filter in SQL — before
 * paging — so totals and pages agree.
 */
export async function queryDrawings(f: ListFilters) {
  const { listDrawings, drawingFiltersFromList } = await import('./drawing-register');
  const res = await listDrawings(drawingFiltersFromList(f));
  return {
    ...res,
    rows: res.rows.map((r) => ({
      ...r,
      // Legacy consumers expect a schedule object on every row.
      schedule:
        r.schedule ??
        assessSchedule({
          completionStatus: r.completionStatus,
          baselineDate: r.baselineReleaseDate,
          expectedDate: r.currentExpectedReleaseDate,
          actualDate: r.actualReleaseDate,
          rescheduleCount: r.rescheduleCount,
        }),
    })),
  };
}

export async function allDrawingsForMetrics(f: ListFilters) {
  return db
    .select({
      id: drawings.id,
      projectId: drawings.projectId,
      disciplineId: drawings.disciplineId,
      packageId: drawings.packageId,
      completionStatus: drawings.completionStatus,
      baselineReleaseDate: drawings.baselineReleaseDate,
      currentExpectedReleaseDate: drawings.currentExpectedReleaseDate,
      actualReleaseDate: drawings.actualReleaseDate,
      rescheduleCount: drawings.rescheduleCount,
    })
    .from(drawings)
    .leftJoin(projects, eq(drawings.projectId, projects.id))
    .where(drawingConditions(f));
}

export async function getGoal(id: string) {
  const [row] = await db
    .select(goalSelect)
    .from(goals)
    .leftJoin(projects, eq(goals.projectId, projects.id))
    .leftJoin(projectPhases, eq(goals.phaseId, projectPhases.id))
    .leftJoin(disciplines, eq(goals.disciplineId, disciplines.id))
    .leftJoin(users, eq(goals.designLeadId, users.id))
    .where(eq(goals.id, id))
    .limit(1);
  return row ?? null;
}

export async function getDeliverable(id: string) {
  const [row] = await db
    .select(deliverableSelect)
    .from(deliverables)
    .leftJoin(projects, eq(deliverables.projectId, projects.id))
    .leftJoin(packages, eq(deliverables.packageId, packages.id))
    .leftJoin(disciplines, eq(deliverables.disciplineId, disciplines.id))
    .leftJoin(users, eq(deliverables.ownerId, users.id))
    .where(eq(deliverables.id, id))
    .limit(1);
  return row ?? null;
}

export async function getDrawing(id: string) {
  const [row] = await db
    .select(drawingSelect)
    .from(drawings)
    .leftJoin(projects, eq(drawings.projectId, projects.id))
    .leftJoin(packages, eq(drawings.packageId, packages.id))
    .leftJoin(disciplines, eq(drawings.disciplineId, disciplines.id))
    .where(eq(drawings.id, id))
    .limit(1);
  return row ?? null;
}
