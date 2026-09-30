/**
 * Reporting data layer.
 *
 * This is the contract the existing Node.js weekly PowerPoint automation
 * should consume, so that the deck and the dashboard are generated from the
 * same rows. It can be called in-process (import the functions) or over HTTP
 * (`/api/reporting/*`). No Excel is involved on either path.
 */
import { desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { rescheduleHistory } from '@/db/schema';
import { addDays, formatDate, startOfDay } from '@/lib/periods';
import { buildExecutiveDashboard, buildProjectDashboard } from './dashboard';
import { getSetting } from './reference';

export interface WeeklyReportPayload {
  generatedAt: string;
  fiscalYear: string;
  asOf: string;
  headline: {
    projects: number;
    atRiskProjects: number;
    plannedPackages: number;
    deliveredPackages: number;
    packageCompletionPercent: number;
    plannedBillingCr: number;
    actualBillingCr: number;
    deliveryItems: number;
    deliveryItemsCompleted: number;
    deliveryCompletionPercent: number;
    overdueItems: number;
    rescheduledItems: number;
  };
  quarters: {
    quarter: number;
    plan: number;
    completed: number;
    variance: number;
    forecast: number;
    completionPercent: number;
    planValueCr: number;
    actualValueCr: number;
  }[];
  projects: {
    projectCode: string;
    projectName: string;
    projectDisplayName: string | null;
    portfolio: string;
    rag: string;
    ragReason: string;
    plan: number;
    completed: number;
    remaining: number;
    completionPercent: number;
    forecastDate: string | null;
    varianceDays: number;
    overdueItems: number;
  }[];
  planVsActual: {
    plan: number;
    expectedByToday: number;
    actual: number;
    remaining: number;
    variance: number;
    forecast: number;
  };
  managementAttention: {
    overdueDeliverables: { code: string; label: string; project: string; date: string | null; daysLate: number | null }[];
    delayedGoals: { code: string; label: string; project: string; detail: string }[];
    upcomingReleases: { code: string; label: string; project: string; date: string | null }[];
    recentReschedules: { entity: string; oldDate: string | null; newDate: string | null; shiftDays: number; reason: string | null; by: string | null }[];
    projectsBehindPlan: { projectName: string; rag: string; reason: string }[];
  };
  disciplines: { discipline: string; planned: number; completed: number; completionPercent: number; overdue: number }[];
}

export async function buildWeeklyReport(opts: { fiscalYear?: string; today?: Date } = {}): Promise<WeeklyReportPayload> {
  const fiscalYear = opts.fiscalYear ?? (await getSetting('app.currentFiscalYear', 'FY26-27'));
  const today = startOfDay(opts.today ?? new Date());
  const d = await buildExecutiveDashboard({ fiscalYear, today });
  const recent = await db
    .select()
    .from(rescheduleHistory)
    .orderBy(desc(rescheduleHistory.changedAt))
    .limit(30);
  const sinceLastWeek = recent.filter((r) => r.changedAt >= addDays(today, -7));

  return {
    generatedAt: new Date().toISOString(),
    fiscalYear,
    asOf: formatDate(today),
    headline: {
      projects: d.projectCount,
      atRiskProjects: d.atRiskProjects,
      plannedPackages: d.goalBlock.plannedPackages,
      deliveredPackages: d.goalBlock.deliveredPackages,
      packageCompletionPercent: d.goalBlock.completionPercent,
      plannedBillingCr: d.goalBlock.plannedValue,
      actualBillingCr: d.goalBlock.actualValue,
      deliveryItems: d.deliveryBlock.planned,
      deliveryItemsCompleted: d.deliveryBlock.completed,
      deliveryCompletionPercent: d.deliveryBlock.completionPercent,
      overdueItems: d.deliveryBlock.overdue,
      rescheduledItems: d.deliveryBlock.rescheduled,
    },
    quarters: d.quarters.map((q) => ({
      quarter: q.quarter,
      plan: q.plan,
      completed: q.completed,
      variance: q.variance,
      forecast: q.forecast,
      completionPercent: q.completionPercent,
      planValueCr: q.planValue,
      actualValueCr: q.actualValue,
    })),
    projects: d.projectRows.map((p) => ({
      projectCode: p.projectCode,
      projectName: p.projectName,
      projectDisplayName: p.projectDisplayName,
      portfolio: p.portfolio,
      rag: p.rag,
      ragReason: p.ragReason,
      plan: p.plannedPackages,
      completed: p.deliveredPackages,
      remaining: p.remainingPackages,
      completionPercent: p.packageCompletionPercent,
      forecastDate: p.expectedForecastDate ? formatDate(p.expectedForecastDate) : null,
      varianceDays: p.varianceDays,
      overdueItems: p.overdueItems,
    })),
    planVsActual: {
      plan: d.deliveryBlock.planned,
      expectedByToday: d.deliveryBlock.expectedByToday,
      actual: d.deliveryBlock.completed,
      remaining: d.deliveryBlock.remaining,
      variance: d.deliveryBlock.variance,
      forecast: d.deliveryBlock.forecast,
    },
    managementAttention: {
      overdueDeliverables: d.attention.overdueDeliverables.map((a) => ({
        code: a.code,
        label: a.label,
        project: a.projectName,
        date: a.date ? formatDate(a.date) : null,
        daysLate: a.days,
      })),
      delayedGoals: d.attention.delayedGoals.map((a) => ({
        code: a.code,
        label: a.label,
        project: a.projectName,
        detail: a.detail,
      })),
      upcomingReleases: d.attention.upcomingReleases.map((a) => ({
        code: a.code,
        label: a.label,
        project: a.projectName,
        date: a.date ? formatDate(a.date) : null,
      })),
      recentReschedules: sinceLastWeek.map((r) => ({
        entity: r.entityLabel ?? `${r.entityType} ${r.entityId}`,
        oldDate: r.oldDate ? formatDate(r.oldDate) : null,
        newDate: r.newDate ? formatDate(r.newDate) : null,
        shiftDays: r.daysShift,
        reason: r.reason,
        by: r.changedByLabel,
      })),
      projectsBehindPlan: d.attention.projectsBehindPlan.map((p) => ({
        projectName: p.projectName,
        rag: p.rag,
        reason: p.ragReason,
      })),
    },
    disciplines: d.disciplineRows.map((r) => ({
      discipline: r.disciplineName,
      planned: r.planned,
      completed: r.completed,
      completionPercent: r.completionPercent,
      overdue: r.overdue,
    })),
  };
}

export async function buildProjectReport(projectId: string, fiscalYear?: string) {
  const fy = fiscalYear ?? (await getSetting('app.currentFiscalYear', 'FY26-27'));
  const d = await buildProjectDashboard(projectId, fy);
  if (!d) return null;
  return {
    generatedAt: new Date().toISOString(),
    fiscalYear: fy,
    project: {
      code: d.project.projectCode,
      name: d.project.projectName,
      displayName: d.project.displayName,
      portfolio: d.project.portfolio,
      phase: d.project.phase,
      onHold: d.project.onHold,
    },
    rag: d.rag,
    goals: d.goalSummary,
    delivery: d.deliverySummary,
    quarters: d.byQuarter,
    disciplines: d.byDiscipline,
    packages: d.packages.map((p) => ({
      code: p.packageCode,
      name: p.packageName,
      group: p.packageGroup,
      baseline: p.baselineReleaseDate ? formatDate(p.baselineReleaseDate) : null,
      expected: p.currentExpectedReleaseDate ? formatDate(p.currentExpectedReleaseDate) : null,
      actual: p.actualReleaseDate ? formatDate(p.actualReleaseDate) : null,
      items: p.items,
      itemsCompleted: p.itemsCompleted,
      percent: p.percent,
      slipDays: p.slipDays,
    })),
    forecast: {
      baselineCompletion: d.forecast.baselineCompletion ? formatDate(d.forecast.baselineCompletion) : null,
      forecastCompletion: d.forecast.forecastCompletion ? formatDate(d.forecast.forecastCompletion) : null,
      varianceDays: d.forecast.varianceDays,
      rescheduleCount: d.forecast.rescheduleCount,
    },
    criticalRequirements: d.criticalRequirements,
    reschedules: d.reschedules.slice(0, 50).map((r) => ({
      entity: r.entityLabel,
      oldDate: r.oldDate ? formatDate(r.oldDate) : null,
      newDate: r.newDate ? formatDate(r.newDate) : null,
      shiftDays: r.daysShift,
      reason: r.reason,
      by: r.changedByLabel,
      at: r.changedAt.toISOString(),
    })),
  };
}

export { eq };
