/**
 * Aggregate metrics.
 *
 * RULE (spec §9): percentages are DERIVED here and nowhere else. No table
 * stores a completion percentage for an individual record, and no user types
 * one in. Every number on every dashboard is computed from the master rows.
 */
import { assessSchedule, calculateRag, type SchedulableItem } from './schedule';
import { startOfDay } from './periods';
import type { Rag, ScheduleStatus } from './domain';

export interface MetricItem extends SchedulableItem {
  id: string;
  priority?: string;
  value?: number; // billing value in Cr., where applicable
}

export interface PlanVsActual {
  plan: number;
  expectedByToday: number;
  actual: number;
  remaining: number;
  variance: number; // actual − expectedByToday
  forecast: number; // plan − items whose expected date is beyond the period
  completionPercent: number; // derived
  planValue: number;
  actualValue: number;
  overdue: number;
  dueSoon: number;
  rescheduled: number;
  delayedValue: number;
  maxSlipDays: number;
  statusCounts: Record<ScheduleStatus, number>;
  rag: Rag;
  ragReason: string;
}

const EMPTY_STATUS_COUNTS = (): Record<ScheduleStatus, number> => ({
  ON_TRACK: 0,
  DUE_SOON: 0,
  RESCHEDULED: 0,
  DELAYED: 0,
  COMPLETED_ON_TIME: 0,
  COMPLETED_LATE: 0,
  NOT_SCHEDULED: 0,
});

export function pct(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/**
 * Plan vs actual for a set of records.
 *
 * `horizonEnd` bounds the "forecast" figure: an incomplete item whose current
 * expected date falls after the horizon is forecast to miss the period.
 * `expectedByToday` counts items whose BASELINE date has already passed — the
 * position the plan said we should be in by now.
 */
export function planVsActual(
  items: MetricItem[],
  opts: { today?: Date; horizonEnd?: Date | null } = {},
): PlanVsActual {
  const today = startOfDay(opts.today ?? new Date());
  const horizonEnd = opts.horizonEnd ?? null;

  const statusCounts = EMPTY_STATUS_COUNTS();
  let plan = 0;
  let actual = 0;
  let expectedByToday = 0;
  let planValue = 0;
  let actualValue = 0;
  let overdue = 0;
  let dueSoon = 0;
  let rescheduled = 0;
  let delayedValue = 0;
  let maxSlipDays = 0;
  let forecastMisses = 0;
  let criticalOverdue = 0;

  for (const item of items) {
    plan += 1;
    planValue += item.value ?? 0;
    const a = assessSchedule(item, today);
    statusCounts[a.status] += 1;
    if (a.rescheduled) rescheduled += 1;
    if (a.slipDays > maxSlipDays) maxSlipDays = a.slipDays;

    const ref = item.baselineDate ?? item.expectedDate;
    if (ref && ref.getTime() <= today.getTime()) expectedByToday += 1;

    if (item.completionStatus === 'COMPLETED') {
      actual += 1;
      actualValue += item.value ?? 0;
    } else {
      if (a.overdue) {
        overdue += 1;
        delayedValue += item.value ?? 0;
        if (item.priority === 'CRITICAL') criticalOverdue += 1;
      }
      if (a.status === 'DUE_SOON') dueSoon += 1;
      if (horizonEnd && item.expectedDate && item.expectedDate.getTime() > horizonEnd.getTime()) {
        forecastMisses += 1;
      }
    }
  }

  const remaining = plan - actual;
  const { rag, reason } = calculateRag({
    plannedCount: plan,
    completedCount: actual,
    overdueCount: overdue,
    criticalOverdueCount: criticalOverdue,
    expectedByTodayCount: expectedByToday,
    maxSlipDays,
  });

  return {
    plan,
    expectedByToday,
    actual,
    remaining,
    variance: actual - expectedByToday,
    forecast: plan - forecastMisses,
    completionPercent: pct(actual, plan),
    planValue: round2(planValue),
    actualValue: round2(actualValue),
    overdue,
    dueSoon,
    rescheduled,
    delayedValue: round2(delayedValue),
    maxSlipDays,
    statusCounts,
    rag,
    ragReason: reason,
  };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function groupBy<T, K extends string>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = out.get(k);
    if (bucket) bucket.push(item);
    else out.set(k, [item]);
  }
  return out;
}
