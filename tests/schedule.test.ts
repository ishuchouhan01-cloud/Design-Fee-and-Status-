import { describe, expect, it } from 'vitest';
import { assessSchedule, calculateRag } from '@/lib/schedule';
import { utc } from '@/lib/periods';

const today = utc(2026, 9, 8);

describe('schedule status is separate from completion', () => {
  it('an incomplete item past its expected date is DELAYED, not "in progress"', () => {
    const a = assessSchedule(
      { completionStatus: 'NOT_COMPLETED', baselineDate: utc(2026, 8, 1), expectedDate: utc(2026, 8, 20), actualDate: null },
      today,
    );
    expect(a.status).toBe('DELAYED');
    expect(a.overdue).toBe(true);
    expect(a.rescheduled).toBe(true); // expected ≠ baseline
  });

  it('an incomplete rescheduled item with a future date reports RESCHEDULED', () => {
    const a = assessSchedule(
      {
        completionStatus: 'NOT_COMPLETED',
        baselineDate: utc(2026, 9, 15),
        expectedDate: utc(2026, 9, 30),
        actualDate: null,
        rescheduleCount: 1,
      },
      today,
    );
    expect(a.status).toBe('RESCHEDULED');
    expect(a.slipDays).toBe(15);
  });

  it('an untouched item due inside the horizon is DUE_SOON, and further out ON_TRACK', () => {
    expect(
      assessSchedule(
        { completionStatus: 'NOT_COMPLETED', baselineDate: utc(2026, 9, 14), expectedDate: utc(2026, 9, 14), actualDate: null },
        today,
      ).status,
    ).toBe('DUE_SOON');
    expect(
      assessSchedule(
        { completionStatus: 'NOT_COMPLETED', baselineDate: utc(2026, 12, 1), expectedDate: utc(2026, 12, 1), actualDate: null },
        today,
      ).status,
    ).toBe('ON_TRACK');
  });

  it('completion is measured against the BASELINE, so a rescheduled item can still be late', () => {
    const late = assessSchedule(
      {
        completionStatus: 'COMPLETED',
        baselineDate: utc(2026, 9, 15),
        expectedDate: utc(2026, 9, 30),
        actualDate: utc(2026, 9, 27),
      },
      today,
    );
    expect(late.status).toBe('COMPLETED_LATE');
    expect(late.varianceDays).toBe(12);

    const onTime = assessSchedule(
      {
        completionStatus: 'COMPLETED',
        baselineDate: utc(2026, 9, 15),
        expectedDate: utc(2026, 9, 15),
        actualDate: utc(2026, 9, 10),
      },
      today,
    );
    expect(onTime.status).toBe('COMPLETED_ON_TIME');
    expect(onTime.varianceDays).toBe(-5);
  });

  it('an item with no date is NOT_SCHEDULED rather than silently on track', () => {
    expect(
      assessSchedule({ completionStatus: 'NOT_COMPLETED', baselineDate: null, expectedDate: null, actualDate: null }, today)
        .status,
    ).toBe('NOT_SCHEDULED');
  });
});

describe('RAG is calculated, with an auditable reason', () => {
  it('is grey when nothing is planned', () => {
    expect(
      calculateRag({ plannedCount: 0, completedCount: 0, overdueCount: 0, expectedByTodayCount: 0 }).rag,
    ).toBe('GREY');
  });

  it('is green when at or ahead of the expected position with nothing overdue', () => {
    const r = calculateRag({ plannedCount: 100, completedCount: 30, overdueCount: 0, expectedByTodayCount: 30 });
    expect(r.rag).toBe('GREEN');
  });

  it('is amber for a modest shortfall or a moderate slip', () => {
    expect(
      calculateRag({ plannedCount: 100, completedCount: 27, overdueCount: 0, expectedByTodayCount: 30 }).rag,
    ).toBe('AMBER');
    expect(
      calculateRag({ plannedCount: 100, completedCount: 30, overdueCount: 0, expectedByTodayCount: 30, maxSlipDays: 20 })
        .rag,
    ).toBe('AMBER');
  });

  it('is red when materially overdue, well behind, or badly slipped', () => {
    expect(
      calculateRag({ plannedCount: 100, completedCount: 30, overdueCount: 12, expectedByTodayCount: 30 }).rag,
    ).toBe('RED');
    expect(
      calculateRag({ plannedCount: 100, completedCount: 20, overdueCount: 0, expectedByTodayCount: 40 }).rag,
    ).toBe('RED');
    expect(
      calculateRag({ plannedCount: 100, completedCount: 40, overdueCount: 0, expectedByTodayCount: 40, maxSlipDays: 90 })
        .rag,
    ).toBe('RED');
    expect(
      calculateRag({
        plannedCount: 100,
        completedCount: 40,
        overdueCount: 1,
        criticalOverdueCount: 1,
        expectedByTodayCount: 40,
      }).rag,
    ).toBe('RED');
  });
});
