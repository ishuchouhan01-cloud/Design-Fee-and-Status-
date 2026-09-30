import { describe, expect, it } from 'vitest';
import { pct, planVsActual } from '@/lib/metrics';
import { utc } from '@/lib/periods';

const today = utc(2026, 9, 8);

function item(id: string, completed: boolean, baseline: string, expected = baseline, actual?: string) {
  const d = (s: string) => {
    const [y, m, day] = s.split('-').map(Number);
    return utc(y, m, day);
  };
  return {
    id,
    completionStatus: completed ? 'COMPLETED' : 'NOT_COMPLETED',
    baselineDate: d(baseline),
    expectedDate: d(expected),
    actualDate: actual ? d(actual) : null,
  };
}

describe('percentages are derived, never stored', () => {
  it('computes the worked example from the specification: 65 of 100 = 65%', () => {
    const items = Array.from({ length: 100 }, (_, i) => item(`i${i}`, i < 65, '2026-01-31', '2026-01-31', '2026-01-20'));
    const m = planVsActual(items, { today });
    expect(m.plan).toBe(100);
    expect(m.actual).toBe(65);
    expect(m.completionPercent).toBe(65);
  });

  it('reports plan / expected-by-today / actual / remaining / variance / forecast', () => {
    const items = [
      ...Array.from({ length: 27 }, (_, i) => item(`done${i}`, true, '2026-05-31', '2026-05-31', '2026-05-20')),
      ...Array.from({ length: 3 }, (_, i) => item(`late${i}`, false, '2026-05-31')),
      ...Array.from({ length: 5 }, (_, i) => item(`soon${i}`, false, '2026-09-30')),
      ...Array.from({ length: 5 }, (_, i) => item(`slipped${i}`, false, '2026-09-30', '2027-02-28')),
    ];
    const m = planVsActual(items, { today, horizonEnd: utc(2026, 12, 31) });
    expect(m.plan).toBe(40);
    expect(m.expectedByToday).toBe(30);
    expect(m.actual).toBe(27);
    expect(m.remaining).toBe(13);
    expect(m.variance).toBe(-3);
    expect(m.forecast).toBe(35); // the 5 slipped past the horizon are forecast to miss
    expect(m.overdue).toBe(3);
  });

  it('never divides by zero', () => {
    expect(pct(0, 0)).toBe(0);
    const m = planVsActual([], { today });
    expect(m.completionPercent).toBe(0);
    expect(m.rag).toBe('GREY');
  });
});
