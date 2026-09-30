import { describe, expect, it } from 'vitest';
import {
  addDays,
  calendarQuarter,
  calendarQuarterOf,
  diffDays,
  fiscalQuarter,
  fiscalQuarterOf,
  formatDate,
  parseDateInput,
  resolvePeriod,
} from '@/lib/periods';

describe('date and period calculations', () => {
  it('resolves calendar quarters to the right month boundaries', () => {
    const q1 = calendarQuarter(2026, 1);
    expect(q1.start.toISOString().slice(0, 10)).toBe('2026-01-01');
    expect(q1.end.toISOString().slice(0, 10)).toBe('2026-03-31');
    const q4 = calendarQuarter(2026, 4);
    expect(q4.start.toISOString().slice(0, 10)).toBe('2026-10-01');
    expect(q4.end.toISOString().slice(0, 10)).toBe('2026-12-31');
  });

  it('resolves Indian fiscal quarters (April start) and wraps into the next year', () => {
    const q1 = fiscalQuarter(2026, 1);
    expect(q1.label).toBe('FY26-27');
    expect(q1.start.toISOString().slice(0, 10)).toBe('2026-04-01');
    expect(q1.end.toISOString().slice(0, 10)).toBe('2026-06-30');
    const q4 = fiscalQuarter(2026, 4);
    expect(q4.start.toISOString().slice(0, 10)).toBe('2027-01-01');
    expect(q4.end.toISOString().slice(0, 10)).toBe('2027-03-31');
  });

  it('round-trips a stored label + quarter back to the same period', () => {
    for (const q of [1, 2, 3, 4]) {
      expect(resolvePeriod('FY26-27', q).end.toISOString()).toBe(fiscalQuarter(2026, q).end.toISOString());
      expect(resolvePeriod('CY2026', q).end.toISOString()).toBe(calendarQuarter(2026, q).end.toISOString());
    }
  });

  it('classifies a date into the correct fiscal and calendar quarter', () => {
    const aug = new Date(Date.UTC(2026, 7, 10));
    expect(fiscalQuarterOf(aug)).toEqual({ label: 'FY26-27', quarter: 2 });
    expect(calendarQuarterOf(aug)).toEqual({ label: 'CY2026', quarter: 3 });
    const feb = new Date(Date.UTC(2027, 1, 3));
    expect(fiscalQuarterOf(feb)).toEqual({ label: 'FY26-27', quarter: 4 });
  });

  it('adds and diffs days without timezone drift', () => {
    const d = new Date(Date.UTC(2026, 2, 29));
    expect(addDays(d, 3).toISOString().slice(0, 10)).toBe('2026-04-01');
    expect(diffDays(addDays(d, 45), d)).toBe(45);
    expect(diffDays(addDays(d, -10), d)).toBe(-10);
  });

  it('formats and parses dates consistently', () => {
    expect(formatDate(new Date(Date.UTC(2026, 8, 15)))).toBe('15-Sep-2026');
    expect(formatDate(null)).toBe('—');
    expect(parseDateInput('2026-09-15')?.toISOString().slice(0, 10)).toBe('2026-09-15');
    expect(parseDateInput('')).toBeNull();
  });
});
