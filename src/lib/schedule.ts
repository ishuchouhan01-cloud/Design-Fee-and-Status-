/**
 * Schedule status and RAG.
 *
 * Completion and schedule are two independent axes (spec §10):
 *   NOT_COMPLETED + RESCHEDULED, NOT_COMPLETED + DELAYED,
 *   COMPLETED + COMPLETED_LATE  … are all valid combinations.
 *
 * Nothing here is stored on the record; it is derived on read so it can never
 * go stale.
 */
import { config } from './config';
import { diffDays, startOfDay } from './periods';
import type { Rag, ScheduleStatus } from './domain';

export interface SchedulableItem {
  completionStatus: string;
  baselineDate: Date | null;
  expectedDate: Date | null;
  actualDate: Date | null;
  rescheduleCount?: number;
}

export interface ScheduleAssessment {
  status: ScheduleStatus;
  /** expected − baseline, in days. Positive = slipped later than baseline. */
  slipDays: number;
  /** actual − baseline, in days, once complete. */
  varianceDays: number | null;
  /** days from today to the current expected date (negative = overdue). */
  daysToDue: number | null;
  overdue: boolean;
  rescheduled: boolean;
}

export function assessSchedule(item: SchedulableItem, today = new Date()): ScheduleAssessment {
  const t = startOfDay(today);
  const baseline = item.baselineDate;
  const expected = item.expectedDate;
  const actual = item.actualDate;
  const rescheduled = (item.rescheduleCount ?? 0) > 0 || Boolean(
    baseline && expected && diffDays(expected, baseline) !== 0,
  );
  const slipDays = baseline && expected ? diffDays(expected, baseline) : 0;

  if (item.completionStatus === 'COMPLETED') {
    const ref = baseline ?? expected;
    const varianceDays = actual && ref ? diffDays(actual, ref) : null;
    return {
      status: varianceDays != null && varianceDays > 0 ? 'COMPLETED_LATE' : 'COMPLETED_ON_TIME',
      slipDays,
      varianceDays,
      daysToDue: null,
      overdue: false,
      rescheduled,
    };
  }

  if (!expected) {
    return { status: 'NOT_SCHEDULED', slipDays, varianceDays: null, daysToDue: null, overdue: false, rescheduled };
  }

  const daysToDue = diffDays(expected, t);
  if (daysToDue < 0) {
    return { status: 'DELAYED', slipDays, varianceDays: null, daysToDue, overdue: true, rescheduled };
  }
  if (rescheduled) {
    return { status: 'RESCHEDULED', slipDays, varianceDays: null, daysToDue, overdue: false, rescheduled };
  }
  if (daysToDue <= config.dueSoonDays) {
    return { status: 'DUE_SOON', slipDays, varianceDays: null, daysToDue, overdue: false, rescheduled };
  }
  return { status: 'ON_TRACK', slipDays, varianceDays: null, daysToDue, overdue: false, rescheduled };
}

export interface RagInput {
  plannedCount: number;
  completedCount: number;
  overdueCount: number;
  criticalOverdueCount?: number;
  expectedByTodayCount: number;
  maxSlipDays?: number;
}

/**
 * RAG for an aggregate (project / discipline / quarter).
 *
 *  RED    — anything overdue and material, or delivery well behind the
 *           expected-by-today position, or a big schedule movement.
 *  AMBER  — modestly behind, or work due inside the near-term horizon.
 *  GREEN  — at or ahead of the expected-by-today position, nothing overdue.
 *  GREY   — nothing planned, so no judgement to make.
 */
export function calculateRag(input: RagInput): { rag: Rag; reason: string } {
  const {
    plannedCount,
    completedCount,
    overdueCount,
    criticalOverdueCount = 0,
    expectedByTodayCount,
    maxSlipDays = 0,
  } = input;

  if (plannedCount === 0) return { rag: 'GREY', reason: 'Nothing planned in this scope' };

  const shortfall = expectedByTodayCount - completedCount;
  const shortfallRatio = expectedByTodayCount > 0 ? shortfall / expectedByTodayCount : 0;
  const overdueRatio = overdueCount / plannedCount;

  if (criticalOverdueCount > 0) {
    return { rag: 'RED', reason: `${criticalOverdueCount} critical item(s) past date` };
  }
  if (overdueRatio >= 0.1 || overdueCount >= 10) {
    return { rag: 'RED', reason: `${overdueCount} of ${plannedCount} tracked records overdue` };
  }
  if (shortfallRatio >= 0.25 && shortfall >= 3) {
    return { rag: 'RED', reason: `${shortfall} records behind the expected position` };
  }
  if (maxSlipDays >= 60) {
    return { rag: 'RED', reason: `Schedule moved by up to ${maxSlipDays} days` };
  }
  if (overdueCount > 0 || shortfallRatio >= 0.1 || maxSlipDays >= 15) {
    const bits: string[] = [];
    if (overdueCount > 0) bits.push(`${overdueCount} overdue`);
    if (shortfall > 0) bits.push(`${shortfall} behind expected`);
    if (maxSlipDays >= 15) bits.push(`up to ${maxSlipDays}d slip`);
    return { rag: 'AMBER', reason: bits.join(', ') };
  }
  return { rag: 'GREEN', reason: 'At or ahead of the expected position' };
}

export const RAG_ORDER: Record<Rag, number> = { RED: 0, AMBER: 1, GREEN: 2, GREY: 3 };
