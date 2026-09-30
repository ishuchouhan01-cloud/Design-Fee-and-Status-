/**
 * Dashboard aggregation. Every figure is computed here from master rows —
 * nothing is read from a stored summary, and nothing came from Excel (spec §6).
 */
import { and, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  deliverables,
  disciplines,
  drawings,
  goals,
  packages,
  projects,
  ragOverrides,
  rescheduleHistory,
} from '@/db/schema';
import { addDays, resolvePeriod, startOfDay } from '@/lib/periods';
import { assessSchedule, calculateRag, RAG_ORDER } from '@/lib/schedule';
import { planVsActual, pct, round2, type MetricItem } from '@/lib/metrics';
import type { Rag } from '@/lib/domain';
import { projectLabel, quarterLabel } from '@/lib/labels';
import { allDeliverablesForMetrics, allDrawingsForMetrics, allGoalsForMetrics } from './queries';
import type { ListFilters } from './filters';

export interface GoalBlock {
  goalCount: number;
  plannedPackages: number;
  deliveredPackages: number;
  completionPercent: number;
  plannedValue: number;
  actualValue: number;
  completedGoals: number;
  openGoals: number;
  overdueGoals: number;
  rescheduledGoals: number;
}

export interface DeliveryBlock {
  planned: number;
  completed: number;
  remaining: number;
  completionPercent: number;
  expectedByToday: number;
  variance: number;
  forecast: number;
  overdue: number;
  dueSoon: number;
  rescheduled: number;
}

export interface ProjectPerformanceRow {
  projectId: string;
  projectCode: string;
  projectName: string;
  projectDisplayName: string | null;
  portfolio: string;
  phase: string | null;
  onHold: boolean;
  plannedPackages: number;
  deliveredPackages: number;
  remainingPackages: number;
  packageCompletionPercent: number;
  plannedValue: number;
  actualValue: number;
  items: number;
  itemsCompleted: number;
  itemCompletionPercent: number;
  overdueItems: number;
  expectedForecastDate: Date | null;
  baselineDate: Date | null;
  varianceDays: number;
  rag: Rag;
  ragReason: string;
  ragOverridden: boolean;
  calculatedRag: Rag;
}

export interface QuarterPerformanceRow {
  quarter: number;
  label: string;
  periodEnd: Date;
  plan: number;
  completed: number;
  variance: number;
  forecast: number;
  planValue: number;
  actualValue: number;
  completionPercent: number;
}

export interface AttentionItem {
  kind: 'OVERDUE_DELIVERABLE' | 'OVERDUE_DRAWING' | 'DELAYED_GOAL' | 'RECENT_RESCHEDULE' | 'UPCOMING_RELEASE';
  entityType: string;
  entityId: string;
  code: string;
  label: string;
  projectId: string;
  projectName: string;
  date: Date | null;
  days: number | null;
  detail: string;
}

export interface ExecutiveDashboard {
  fiscalYear: string;
  today: Date;
  goalBlock: GoalBlock;
  deliveryBlock: DeliveryBlock;
  projectCount: number;
  atRiskProjects: number;
  projectRows: ProjectPerformanceRow[];
  quarters: QuarterPerformanceRow[];
  attention: {
    overdueDeliverables: AttentionItem[];
    overdueDrawings: AttentionItem[];
    delayedGoals: AttentionItem[];
    recentReschedules: AttentionItem[];
    upcomingReleases: AttentionItem[];
    projectsBehindPlan: ProjectPerformanceRow[];
    majorMovements: AttentionItem[];
  };
  disciplineRows: {
    disciplineId: string | null;
    disciplineName: string;
    planned: number;
    completed: number;
    completionPercent: number;
    overdue: number;
  }[];
}

function toMetricItems(
  rows: { id: string; completionStatus: string; baselineReleaseDate: Date | null; currentExpectedReleaseDate: Date | null; actualReleaseDate: Date | null; rescheduleCount: number }[],
): MetricItem[] {
  return rows.map((r) => ({
    id: r.id,
    completionStatus: r.completionStatus,
    baselineDate: r.baselineReleaseDate,
    expectedDate: r.currentExpectedReleaseDate,
    actualDate: r.actualReleaseDate,
    rescheduleCount: r.rescheduleCount,
  }));
}

export async function buildExecutiveDashboard(opts: {
  fiscalYear: string;
  portfolio?: string;
  today?: Date;
}): Promise<ExecutiveDashboard> {
  const today = startOfDay(opts.today ?? new Date());
  const filters: ListFilters = { fiscalYear: opts.fiscalYear, portfolio: opts.portfolio };

  const [goalRows, deliverableRows, drawingRows, projectRowsRaw, overrides] = await Promise.all([
    allGoalsForMetrics(filters),
    allDeliverablesForMetrics({ portfolio: opts.portfolio }),
    allDrawingsForMetrics({ portfolio: opts.portfolio }),
    opts.portfolio
      ? db.select().from(projects).where(eq(projects.portfolio, opts.portfolio))
      : db.select().from(projects),
    db.select().from(ragOverrides).where(eq(ragOverrides.active, true)),
  ]);

  // --- goals ------------------------------------------------------------
  const plannedPackages = goalRows.reduce((s, g) => s + g.plannedQuantity, 0);
  const deliveredPackages = goalRows.reduce((s, g) => s + g.reportedActualQuantity, 0);
  const goalMetrics = planVsActual(
    goalRows.map((g) => ({
      id: g.id,
      completionStatus: g.completionStatus,
      baselineDate: g.baselineTargetDate,
      expectedDate: g.currentExpectedDate,
      actualDate: g.actualCompletionDate,
      rescheduleCount: g.rescheduleCount,
      priority: g.priority,
      value: g.plannedValue,
    })),
    { today },
  );
  const goalBlock: GoalBlock = {
    goalCount: goalRows.length,
    plannedPackages,
    deliveredPackages,
    completionPercent: pct(deliveredPackages, plannedPackages),
    plannedValue: round2(goalRows.reduce((s, g) => s + g.plannedValue, 0)),
    actualValue: round2(goalRows.reduce((s, g) => s + g.reportedActualValue, 0)),
    completedGoals: goalMetrics.actual,
    openGoals: goalMetrics.remaining,
    overdueGoals: goalMetrics.overdue,
    rescheduledGoals: goalMetrics.rescheduled,
  };

  // --- enumerated delivery items ---------------------------------------
  const items = [...toMetricItems(deliverableRows), ...toMetricItems(drawingRows)];
  const delivery = planVsActual(items, { today });
  const deliveryBlock: DeliveryBlock = {
    planned: delivery.plan,
    completed: delivery.actual,
    remaining: delivery.remaining,
    completionPercent: delivery.completionPercent,
    expectedByToday: delivery.expectedByToday,
    variance: delivery.variance,
    forecast: delivery.forecast,
    overdue: delivery.overdue,
    dueSoon: delivery.dueSoon,
    rescheduled: delivery.rescheduled,
  };

  // --- per project -------------------------------------------------------
  const overrideByEntity = new Map(overrides.filter((o) => o.entityType === 'PROJECT').map((o) => [o.entityId, o]));
  const goalsByProject = new Map<string, typeof goalRows>();
  for (const g of goalRows) {
    const list = goalsByProject.get(g.projectId) ?? [];
    list.push(g);
    goalsByProject.set(g.projectId, list);
  }
  const itemsByProject = new Map<string, MetricItem[]>();
  for (const r of [...deliverableRows, ...drawingRows]) {
    const list = itemsByProject.get(r.projectId) ?? [];
    list.push({
      id: r.id,
      completionStatus: r.completionStatus,
      baselineDate: r.baselineReleaseDate,
      expectedDate: r.currentExpectedReleaseDate,
      actualDate: r.actualReleaseDate,
      rescheduleCount: r.rescheduleCount,
    });
    itemsByProject.set(r.projectId, list);
  }

  const projectRows: ProjectPerformanceRow[] = projectRowsRaw.map((p) => {
    const pg = goalsByProject.get(p.id) ?? [];
    const pi = itemsByProject.get(p.id) ?? [];
    const planned = pg.reduce((s, g) => s + g.plannedQuantity, 0);
    const delivered = pg.reduce((s, g) => s + g.reportedActualQuantity, 0);
    const goalPos = planVsActual(
      pg.map((g) => ({
        id: g.id,
        completionStatus: g.completionStatus,
        baselineDate: g.baselineTargetDate,
        expectedDate: g.currentExpectedDate,
        actualDate: g.actualCompletionDate,
        rescheduleCount: g.rescheduleCount,
        priority: g.priority,
        value: g.plannedValue,
      })),
      { today },
    );
    const itemPos = planVsActual(pi, { today });
    const openDates = [
      ...pg.filter((g) => g.completionStatus === 'NOT_COMPLETED').map((g) => g.currentExpectedDate),
      ...pi.filter((i) => i.completionStatus === 'NOT_COMPLETED').map((i) => i.expectedDate),
    ].filter((d): d is Date => Boolean(d));
    const baselineDates = [
      ...pg.filter((g) => g.completionStatus === 'NOT_COMPLETED').map((g) => g.baselineTargetDate),
      ...pi.filter((i) => i.completionStatus === 'NOT_COMPLETED').map((i) => i.baselineDate),
    ].filter((d): d is Date => Boolean(d));
    const forecastDate = openDates.length ? new Date(Math.max(...openDates.map((d) => d.getTime()))) : null;
    const baselineDate = baselineDates.length ? new Date(Math.max(...baselineDates.map((d) => d.getTime()))) : null;
    const varianceDays =
      forecastDate && baselineDate ? Math.round((forecastDate.getTime() - baselineDate.getTime()) / 86_400_000) : 0;

    // RAG counts RECORDS on both sides (goal records + delivery items), never
    // package quantities mixed with record counts.
    const combined = calculateRag({
      plannedCount: goalPos.plan + itemPos.plan,
      completedCount: goalPos.actual + itemPos.actual,
      overdueCount: goalPos.overdue + itemPos.overdue,
      criticalOverdueCount: 0,
      expectedByTodayCount: goalPos.expectedByToday + itemPos.expectedByToday,
      maxSlipDays: Math.max(goalPos.maxSlipDays, itemPos.maxSlipDays),
    });
    const ov = overrideByEntity.get(p.id);
    return {
      projectId: p.id,
      projectCode: p.projectCode,
      projectName: p.projectName,
      projectDisplayName: p.displayName,
      portfolio: p.portfolio,
      phase: p.phase,
      onHold: p.onHold,
      plannedPackages: planned,
      deliveredPackages: delivered,
      remainingPackages: Math.max(0, planned - delivered),
      packageCompletionPercent: pct(delivered, planned),
      plannedValue: round2(pg.reduce((s, g) => s + g.plannedValue, 0)),
      actualValue: round2(pg.reduce((s, g) => s + g.reportedActualValue, 0)),
      items: itemPos.plan,
      itemsCompleted: itemPos.actual,
      itemCompletionPercent: itemPos.completionPercent,
      overdueItems: itemPos.overdue,
      expectedForecastDate: forecastDate,
      baselineDate,
      varianceDays,
      rag: (ov?.overrideRag as Rag) ?? combined.rag,
      ragReason: ov ? `Management override: ${ov.reason ?? 'no reason recorded'}` : combined.reason,
      ragOverridden: Boolean(ov),
      calculatedRag: combined.rag,
    };
  });
  projectRows.sort(
    (a, b) => RAG_ORDER[a.rag] - RAG_ORDER[b.rag] || b.plannedPackages - a.plannedPackages || a.projectName.localeCompare(b.projectName),
  );

  // --- quarters ----------------------------------------------------------
  const quarters: QuarterPerformanceRow[] = [1, 2, 3, 4].map((q) => {
    const period = resolvePeriod(opts.fiscalYear, q);
    const qg = goalRows.filter((g) => g.quarter === q);
    const plan = qg.reduce((s, g) => s + g.plannedQuantity, 0);
    const completed = qg.reduce((s, g) => s + g.reportedActualQuantity, 0);
    const forecast = qg
      .filter((g) => g.completionStatus === 'COMPLETED' || g.currentExpectedDate.getTime() <= period.end.getTime())
      .reduce((s, g) => s + g.plannedQuantity, 0);
    return {
      quarter: q,
      label: quarterLabel(q),
      periodEnd: period.end,
      plan,
      completed,
      variance: completed - plan,
      forecast,
      planValue: round2(qg.reduce((s, g) => s + g.plannedValue, 0)),
      actualValue: round2(qg.reduce((s, g) => s + g.reportedActualValue, 0)),
      completionPercent: pct(completed, plan),
    };
  });

  // --- management attention ---------------------------------------------
  const projectNameById = new Map(projectRowsRaw.map((p) => [p.id, projectLabel(p)]));
  const soon = addDays(today, 21);

  const [overdueDl, overdueDw, delayedGoals, recent, upcomingDl, upcomingDw] = await Promise.all([
    db
      .select({
        id: deliverables.id,
        code: deliverables.deliverableCode,
        label: deliverables.deliverableDescription,
        projectId: deliverables.projectId,
        date: deliverables.currentExpectedReleaseDate,
      })
      .from(deliverables)
      .where(
        and(
          eq(deliverables.completionStatus, 'NOT_COMPLETED'),
          lte(deliverables.currentExpectedReleaseDate, today),
        ),
      )
      .orderBy(deliverables.currentExpectedReleaseDate)
      .limit(25),
    db
      .select({
        id: drawings.id,
        code: drawings.drawingCode,
        label: drawings.drawingName,
        projectId: drawings.projectId,
        date: drawings.currentExpectedReleaseDate,
      })
      .from(drawings)
      .where(and(eq(drawings.completionStatus, 'NOT_COMPLETED'), lte(drawings.currentExpectedReleaseDate, today), isNull(drawings.archivedAt)))
      .orderBy(drawings.currentExpectedReleaseDate)
      .limit(25),
    db
      .select({
        id: goals.id,
        code: goals.goalCode,
        label: goals.goalDescription,
        projectId: goals.projectId,
        date: goals.currentExpectedDate,
        baseline: goals.baselineTargetDate,
        planned: goals.plannedQuantity,
        delivered: goals.reportedActualQuantity,
      })
      .from(goals)
      .where(
        and(
          eq(goals.fiscalYear, opts.fiscalYear),
          eq(goals.completionStatus, 'NOT_COMPLETED'),
          lte(goals.currentExpectedDate, today),
        ),
      )
      .orderBy(goals.currentExpectedDate)
      .limit(25),
    db.select().from(rescheduleHistory).orderBy(desc(rescheduleHistory.changedAt)).limit(25),
    db
      .select({
        id: deliverables.id,
        code: deliverables.deliverableCode,
        label: deliverables.deliverableDescription,
        projectId: deliverables.projectId,
        date: deliverables.currentExpectedReleaseDate,
      })
      .from(deliverables)
      .where(
        and(
          eq(deliverables.completionStatus, 'NOT_COMPLETED'),
          gte(deliverables.currentExpectedReleaseDate, today),
          lte(deliverables.currentExpectedReleaseDate, soon),
        ),
      )
      .orderBy(deliverables.currentExpectedReleaseDate)
      .limit(15),
    db
      .select({
        id: drawings.id,
        code: drawings.drawingCode,
        label: drawings.drawingName,
        projectId: drawings.projectId,
        date: drawings.currentExpectedReleaseDate,
      })
      .from(drawings)
      .where(
        and(
          eq(drawings.completionStatus, 'NOT_COMPLETED'),
          gte(drawings.currentExpectedReleaseDate, today),
          lte(drawings.currentExpectedReleaseDate, soon),
          isNull(drawings.archivedAt),
        ),
      )
      .orderBy(drawings.currentExpectedReleaseDate)
      .limit(15),
  ]);

  const daysLate = (d: Date | null) => (d ? Math.round((today.getTime() - d.getTime()) / 86_400_000) : null);

  const attention: ExecutiveDashboard['attention'] = {
    overdueDeliverables: overdueDl.map((r) => ({
      kind: 'OVERDUE_DELIVERABLE',
      entityType: 'DELIVERABLE',
      entityId: r.id,
      code: r.code,
      label: r.label,
      projectId: r.projectId,
      projectName: projectNameById.get(r.projectId) ?? '—',
      date: r.date,
      days: daysLate(r.date),
      detail: `${daysLate(r.date)} days past the current expected release`,
    })),
    overdueDrawings: overdueDw.map((r) => ({
      kind: 'OVERDUE_DRAWING',
      entityType: 'DRAWING',
      entityId: r.id,
      code: r.code,
      label: r.label,
      projectId: r.projectId,
      projectName: projectNameById.get(r.projectId) ?? '—',
      date: r.date,
      days: daysLate(r.date),
      detail: `${daysLate(r.date)} days past the current expected release`,
    })),
    delayedGoals: delayedGoals.map((r) => ({
      kind: 'DELAYED_GOAL',
      entityType: 'GOAL',
      entityId: r.id,
      code: r.code,
      label: r.label,
      projectId: r.projectId,
      projectName: projectNameById.get(r.projectId) ?? '—',
      date: r.date,
      days: daysLate(r.date),
      detail: `${r.delivered} of ${r.planned} packages delivered; target date passed ${daysLate(r.date)} days ago`,
    })),
    recentReschedules: recent.map((r) => ({
      kind: 'RECENT_RESCHEDULE',
      entityType: r.entityType,
      entityId: r.entityId,
      code: r.entityLabel?.split(' — ')[0] ?? r.entityId,
      label: r.entityLabel ?? r.entityId,
      projectId: r.projectId ?? '',
      projectName: r.projectId ? projectNameById.get(r.projectId) ?? '—' : '—',
      date: r.newDate,
      days: r.daysShift,
      detail: `${r.daysShift >= 0 ? '+' : ''}${r.daysShift} days — ${r.reason ?? 'no reason recorded'}`,
    })),
    upcomingReleases: [...upcomingDl, ...upcomingDw]
      .sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0))
      .slice(0, 20)
      .map((r) => ({
        kind: 'UPCOMING_RELEASE',
        entityType: 'code' in r ? 'DELIVERABLE' : 'DRAWING',
        entityId: r.id,
        code: r.code,
        label: r.label,
        projectId: r.projectId,
        projectName: projectNameById.get(r.projectId) ?? '—',
        date: r.date,
        days: r.date ? Math.round((r.date.getTime() - today.getTime()) / 86_400_000) : null,
        detail: `due in ${r.date ? Math.round((r.date.getTime() - today.getTime()) / 86_400_000) : '?'} days`,
      })),
    projectsBehindPlan: projectRows.filter((p) => p.rag === 'RED' || p.rag === 'AMBER').slice(0, 12),
    majorMovements: recent
      .filter((r) => Math.abs(r.daysShift) >= 15)
      .map((r) => ({
        kind: 'RECENT_RESCHEDULE',
        entityType: r.entityType,
        entityId: r.entityId,
        code: r.entityLabel?.split(' — ')[0] ?? r.entityId,
        label: r.entityLabel ?? r.entityId,
        projectId: r.projectId ?? '',
        projectName: r.projectId ? projectNameById.get(r.projectId) ?? '—' : '—',
        date: r.newDate,
        days: r.daysShift,
        detail: `${r.daysShift >= 0 ? '+' : ''}${r.daysShift} days — ${r.reason ?? 'no reason recorded'}`,
      })),
  };

  // --- disciplines -------------------------------------------------------
  const allDisciplines = await db.select().from(disciplines);
  const disciplineName = new Map(allDisciplines.map((d) => [d.id, d.name]));
  const byDiscipline = new Map<string, MetricItem[]>();
  for (const r of [...deliverableRows, ...drawingRows]) {
    const key = r.disciplineId ?? 'none';
    const list = byDiscipline.get(key) ?? [];
    list.push({
      id: r.id,
      completionStatus: r.completionStatus,
      baselineDate: r.baselineReleaseDate,
      expectedDate: r.currentExpectedReleaseDate,
      actualDate: r.actualReleaseDate,
      rescheduleCount: r.rescheduleCount,
    });
    byDiscipline.set(key, list);
  }
  const disciplineRows = [...byDiscipline.entries()]
    .map(([key, list]) => {
      const m = planVsActual(list, { today });
      return {
        disciplineId: key === 'none' ? null : key,
        disciplineName: key === 'none' ? 'Unassigned' : disciplineName.get(key) ?? key,
        planned: m.plan,
        completed: m.actual,
        completionPercent: m.completionPercent,
        overdue: m.overdue,
      };
    })
    .sort((a, b) => b.planned - a.planned);

  return {
    fiscalYear: opts.fiscalYear,
    today,
    goalBlock,
    deliveryBlock,
    projectCount: projectRowsRaw.length,
    atRiskProjects: projectRows.filter((p) => p.rag === 'RED' || p.rag === 'AMBER').length,
    projectRows,
    quarters,
    attention,
    disciplineRows,
  };
}

// ---------------------------------------------------------------------------
// Project dashboard
// ---------------------------------------------------------------------------

export interface ProjectDashboard {
  project: typeof projects.$inferSelect;
  phases: { id: string; code: string; name: string }[];
  goalSummary: GoalBlock;
  deliverySummary: DeliveryBlock;
  byDiscipline: {
    disciplineId: string | null;
    disciplineName: string;
    plannedPackages: number;
    deliveredPackages: number;
    packagePercent: number;
    items: number;
    itemsCompleted: number;
    itemPercent: number;
    overdue: number;
    rag: Rag;
  }[];
  byQuarter: QuarterPerformanceRow[];
  packages: {
    id: string;
    packageCode: string;
    packageName: string;
    packageGroup: string | null;
    durationDays: number | null;
    baselineReleaseDate: Date | null;
    currentExpectedReleaseDate: Date | null;
    actualReleaseDate: Date | null;
    items: number;
    itemsCompleted: number;
    percent: number;
    slipDays: number;
  }[];
  reschedules: (typeof rescheduleHistory.$inferSelect)[];
  criticalRequirements: { id: string; phaseLabel: string | null; requirement: string }[];
  forecast: {
    baselineCompletion: Date | null;
    forecastCompletion: Date | null;
    varianceDays: number;
    rescheduleCount: number;
  };
  attention: AttentionItem[];
  rag: { rag: Rag; reason: string; overridden: boolean; calculated: Rag };
}

export async function buildProjectDashboard(projectId: string, fiscalYear: string, today = new Date()): Promise<ProjectDashboard | null> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) return null;
  const t = startOfDay(today);

  const [goalRows, deliverableRows, drawingRows, phaseRows, pkgRows, resch, crit, allDisciplines, overrides] =
    await Promise.all([
      allGoalsForMetrics({ projectId, fiscalYear }),
      allDeliverablesForMetrics({ projectId }),
      allDrawingsForMetrics({ projectId }),
      db.select().from((await import('@/db/schema')).projectPhases).where(eq((await import('@/db/schema')).projectPhases.projectId, projectId)),
      db.select().from(packages).where(eq(packages.projectId, projectId)),
      db.select().from(rescheduleHistory).where(eq(rescheduleHistory.projectId, projectId)).orderBy(desc(rescheduleHistory.changedAt)).limit(200),
      db.select().from((await import('@/db/schema')).criticalRequirements).where(eq((await import('@/db/schema')).criticalRequirements.projectId, projectId)),
      db.select().from(disciplines),
      db.select().from(ragOverrides).where(and(eq(ragOverrides.active, true), eq(ragOverrides.entityType, 'PROJECT'), eq(ragOverrides.entityId, projectId))),
    ]);

  const items: MetricItem[] = [...toMetricItems(deliverableRows), ...toMetricItems(drawingRows)];
  const delivery = planVsActual(items, { today: t });
  const plannedPackages = goalRows.reduce((s, g) => s + g.plannedQuantity, 0);
  const deliveredPackages = goalRows.reduce((s, g) => s + g.reportedActualQuantity, 0);
  const goalPos = planVsActual(
    goalRows.map((g) => ({
      id: g.id,
      completionStatus: g.completionStatus,
      baselineDate: g.baselineTargetDate,
      expectedDate: g.currentExpectedDate,
      actualDate: g.actualCompletionDate,
      rescheduleCount: g.rescheduleCount,
      priority: g.priority,
      value: g.plannedValue,
    })),
    { today: t },
  );

  const disciplineName = new Map(allDisciplines.map((d) => [d.id, d.name]));
  const disciplineKeys = new Set<string>([
    ...goalRows.map((g) => g.disciplineId ?? 'none'),
    ...deliverableRows.map((d) => d.disciplineId ?? 'none'),
    ...drawingRows.map((d) => d.disciplineId ?? 'none'),
  ]);
  const byDiscipline = [...disciplineKeys].map((key) => {
    const dg = goalRows.filter((g) => (g.disciplineId ?? 'none') === key);
    const di = [
      ...toMetricItems(deliverableRows.filter((d) => (d.disciplineId ?? 'none') === key)),
      ...toMetricItems(drawingRows.filter((d) => (d.disciplineId ?? 'none') === key)),
    ];
    const m = planVsActual(di, { today: t });
    const planned = dg.reduce((s, g) => s + g.plannedQuantity, 0);
    const delivered = dg.reduce((s, g) => s + g.reportedActualQuantity, 0);
    const dgPos = planVsActual(
      dg.map((g) => ({
        id: g.id,
        completionStatus: g.completionStatus,
        baselineDate: g.baselineTargetDate,
        expectedDate: g.currentExpectedDate,
        actualDate: g.actualCompletionDate,
        rescheduleCount: g.rescheduleCount,
        priority: g.priority,
      })),
      { today: t },
    );
    const rag = calculateRag({
      plannedCount: dgPos.plan + m.plan,
      completedCount: dgPos.actual + m.actual,
      overdueCount: dgPos.overdue + m.overdue,
      expectedByTodayCount: dgPos.expectedByToday + m.expectedByToday,
      maxSlipDays: Math.max(dgPos.maxSlipDays, m.maxSlipDays),
    });
    return {
      disciplineId: key === 'none' ? null : key,
      disciplineName: key === 'none' ? 'Unassigned' : disciplineName.get(key) ?? key,
      plannedPackages: planned,
      deliveredPackages: delivered,
      packagePercent: pct(delivered, planned),
      items: m.plan,
      itemsCompleted: m.actual,
      itemPercent: m.completionPercent,
      overdue: m.overdue,
      rag: rag.rag,
    };
  }).sort((a, b) => b.plannedPackages + b.items - (a.plannedPackages + a.items));

  const byQuarter: QuarterPerformanceRow[] = [1, 2, 3, 4].map((q) => {
    const period = resolvePeriod(fiscalYear, q);
    const qg = goalRows.filter((g) => g.quarter === q);
    const plan = qg.reduce((s, g) => s + g.plannedQuantity, 0);
    const completed = qg.reduce((s, g) => s + g.reportedActualQuantity, 0);
    const forecast = qg
      .filter((g) => g.completionStatus === 'COMPLETED' || g.currentExpectedDate.getTime() <= period.end.getTime())
      .reduce((s, g) => s + g.plannedQuantity, 0);
    return {
      quarter: q,
      label: quarterLabel(q),
      periodEnd: period.end,
      plan,
      completed,
      variance: completed - plan,
      forecast,
      planValue: round2(qg.reduce((s, g) => s + g.plannedValue, 0)),
      actualValue: round2(qg.reduce((s, g) => s + g.reportedActualValue, 0)),
      completionPercent: pct(completed, plan),
    };
  });

  const packageRows = pkgRows
    .map((p) => {
      const pi = [
        ...toMetricItems(deliverableRows.filter((d) => d.packageId === p.id)),
        ...toMetricItems(drawingRows.filter((d) => d.packageId === p.id)),
      ];
      const m = planVsActual(pi, { today: t });
      const slip =
        p.baselineReleaseDate && p.currentExpectedReleaseDate
          ? Math.round((p.currentExpectedReleaseDate.getTime() - p.baselineReleaseDate.getTime()) / 86_400_000)
          : 0;
      return {
        id: p.id,
        packageCode: p.packageCode,
        packageName: p.packageName,
        packageGroup: p.packageGroup,
        durationDays: p.durationDays,
        baselineReleaseDate: p.baselineReleaseDate,
        currentExpectedReleaseDate: p.currentExpectedReleaseDate,
        actualReleaseDate: p.actualReleaseDate,
        items: m.plan,
        itemsCompleted: m.actual,
        percent: m.completionPercent,
        slipDays: slip,
      };
    })
    .sort((a, b) => (a.baselineReleaseDate?.getTime() ?? 0) - (b.baselineReleaseDate?.getTime() ?? 0));

  const openExpected = [
    ...goalRows.filter((g) => g.completionStatus === 'NOT_COMPLETED').map((g) => g.currentExpectedDate),
    ...items.filter((i) => i.completionStatus === 'NOT_COMPLETED').map((i) => i.expectedDate),
  ].filter((d): d is Date => Boolean(d));
  const openBaseline = [
    ...goalRows.filter((g) => g.completionStatus === 'NOT_COMPLETED').map((g) => g.baselineTargetDate),
    ...items.filter((i) => i.completionStatus === 'NOT_COMPLETED').map((i) => i.baselineDate),
  ].filter((d): d is Date => Boolean(d));
  const forecastCompletion = openExpected.length ? new Date(Math.max(...openExpected.map((d) => d.getTime()))) : null;
  const baselineCompletion = openBaseline.length ? new Date(Math.max(...openBaseline.map((d) => d.getTime()))) : null;

  const calculated = calculateRag({
    plannedCount: goalPos.plan + delivery.plan,
    completedCount: goalPos.actual + delivery.actual,
    overdueCount: goalPos.overdue + delivery.overdue,
    expectedByTodayCount: goalPos.expectedByToday + delivery.expectedByToday,
    maxSlipDays: Math.max(goalPos.maxSlipDays, delivery.maxSlipDays),
  });
  const ov = overrides[0];

  const overdueAttention: AttentionItem[] = [
    ...deliverableRows
      .filter((d) => d.completionStatus === 'NOT_COMPLETED' && d.currentExpectedReleaseDate && d.currentExpectedReleaseDate <= t)
      .slice(0, 20)
      .map((d) => ({
        kind: 'OVERDUE_DELIVERABLE' as const,
        entityType: 'DELIVERABLE',
        entityId: d.id,
        code: d.id,
        label: 'Deliverable past its expected release',
        projectId,
        projectName: projectLabel(project),
        date: d.currentExpectedReleaseDate,
        days: Math.round((t.getTime() - (d.currentExpectedReleaseDate?.getTime() ?? 0)) / 86_400_000),
        detail: 'Past the current expected release date',
      })),
  ];

  return {
    project,
    phases: phaseRows.map((p) => ({ id: p.id, code: p.code, name: p.name })),
    goalSummary: {
      goalCount: goalRows.length,
      plannedPackages,
      deliveredPackages,
      completionPercent: pct(deliveredPackages, plannedPackages),
      plannedValue: round2(goalRows.reduce((s, g) => s + g.plannedValue, 0)),
      actualValue: round2(goalRows.reduce((s, g) => s + g.reportedActualValue, 0)),
      completedGoals: goalPos.actual,
      openGoals: goalPos.remaining,
      overdueGoals: goalPos.overdue,
      rescheduledGoals: goalPos.rescheduled,
    },
    deliverySummary: {
      planned: delivery.plan,
      completed: delivery.actual,
      remaining: delivery.remaining,
      completionPercent: delivery.completionPercent,
      expectedByToday: delivery.expectedByToday,
      variance: delivery.variance,
      forecast: delivery.forecast,
      overdue: delivery.overdue,
      dueSoon: delivery.dueSoon,
      rescheduled: delivery.rescheduled,
    },
    byDiscipline,
    byQuarter,
    packages: packageRows,
    reschedules: resch,
    criticalRequirements: crit.map((c) => ({ id: c.id, phaseLabel: c.phaseLabel, requirement: c.requirement })),
    forecast: {
      baselineCompletion,
      forecastCompletion,
      varianceDays:
        forecastCompletion && baselineCompletion
          ? Math.round((forecastCompletion.getTime() - baselineCompletion.getTime()) / 86_400_000)
          : 0,
      rescheduleCount: resch.length,
    },
    attention: overdueAttention,
    rag: {
      rag: (ov?.overrideRag as Rag) ?? calculated.rag,
      reason: ov ? `Management override: ${ov.reason ?? 'no reason recorded'}` : calculated.reason,
      overridden: Boolean(ov),
      calculated: calculated.rag,
    },
  };
}

export { assessSchedule, sql };
