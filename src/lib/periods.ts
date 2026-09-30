/**
 * Period arithmetic.
 *
 * The source workbooks use two different period systems:
 *   - "Goals 2026"           → calendar year quarters  (CY2026 Q1 = Jan-Mar)
 *   - "Goals FY 26-27 Qn"    → fiscal year quarters    (FY26-27 Q1 = Apr-Jun)
 *
 * Both are preserved. A goal stores its label (`fiscalYear`), its quarter and
 * the resolved period start/end so that all downstream date maths is ordinary
 * date maths and nothing has to re-derive quarter semantics.
 */
import { config } from './config';

export type PeriodKind = 'FISCAL' | 'CALENDAR';

export interface Period {
  label: string; // "FY26-27" | "CY2026"
  kind: PeriodKind;
  quarter: number; // 1..4
  start: Date;
  end: Date;
}

export function utc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
}

export function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(23, 59, 59, 999);
  return x;
}

export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

export function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + days);
  return x;
}

export function diffDays(a: Date, b: Date): number {
  return Math.round((startOfDay(a).getTime() - startOfDay(b).getTime()) / 86_400_000);
}

const MONTH_END = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Calendar quarter (Q1 = Jan-Mar) for a given calendar year. */
export function calendarQuarter(year: number, quarter: number): Period {
  const startMonth = (quarter - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  return {
    label: `CY${year}`,
    kind: 'CALENDAR',
    quarter,
    start: utc(year, startMonth, 1),
    end: endOfDay(utc(year, endMonth, MONTH_END(year, endMonth))),
  };
}

/**
 * Fiscal quarter. `fyStartYear` is the calendar year in which the fiscal year
 * begins: FY26-27 → 2026, so Q1 = Apr-Jun 2026 and Q4 = Jan-Mar 2027.
 */
export function fiscalQuarter(fyStartYear: number, quarter: number): Period {
  const fm = config.fiscalYearStartMonth; // 4 for April
  const monthOffset = (quarter - 1) * 3;
  const absStart = fm + monthOffset; // 4..13..
  const startYear = fyStartYear + Math.floor((absStart - 1) / 12);
  const startMonth = ((absStart - 1) % 12) + 1;
  const absEnd = absStart + 2;
  const endYear = fyStartYear + Math.floor((absEnd - 1) / 12);
  const endMonth = ((absEnd - 1) % 12) + 1;
  const shortA = String(fyStartYear % 100).padStart(2, '0');
  const shortB = String((fyStartYear + 1) % 100).padStart(2, '0');
  return {
    label: `FY${shortA}-${shortB}`,
    kind: 'FISCAL',
    quarter,
    start: utc(startYear, startMonth, 1),
    end: endOfDay(utc(endYear, endMonth, MONTH_END(endYear, endMonth))),
  };
}

/** Resolve a stored (label, quarter) pair back to its period. */
export function resolvePeriod(label: string, quarter: number): Period {
  const fy = /^FY(\d{2})-(\d{2})$/.exec(label);
  if (fy) return fiscalQuarter(2000 + Number(fy[1]), quarter);
  const cy = /^CY(\d{4})$/.exec(label);
  if (cy) return calendarQuarter(Number(cy[1]), quarter);
  const bare = /^(\d{4})$/.exec(label);
  if (bare) return calendarQuarter(Number(bare[1]), quarter);
  // Unknown label — fall back to the current calendar year so nothing explodes.
  return calendarQuarter(new Date().getUTCFullYear(), quarter);
}

export function periodLabelFull(label: string, quarter: number): string {
  return `${label} Q${quarter}`;
}

/** Which fiscal quarter a date falls in. */
export function fiscalQuarterOf(date: Date): { label: string; quarter: number } {
  const fm = config.fiscalYearStartMonth;
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const fyStartYear = m >= fm ? y : y - 1;
  const monthsIn = (m - fm + 12) % 12;
  const quarter = Math.floor(monthsIn / 3) + 1;
  const shortA = String(fyStartYear % 100).padStart(2, '0');
  const shortB = String((fyStartYear + 1) % 100).padStart(2, '0');
  return { label: `FY${shortA}-${shortB}`, quarter };
}

export function calendarQuarterOf(date: Date): { label: string; quarter: number } {
  return {
    label: `CY${date.getUTCFullYear()}`,
    quarter: Math.floor(date.getUTCMonth() / 3) + 1,
  };
}

export function formatDate(d: Date | null | undefined): string {
  if (!d) return '—';
  const day = String(d.getUTCDate()).padStart(2, '0');
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()];
  return `${day}-${mon}-${d.getUTCFullYear()}`;
}

export function formatDateInput(d: Date | null | undefined): string {
  if (!d) return '';
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function parseDateInput(v: string | null | undefined): Date | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (m) return utc(Number(m[1]), Number(m[2]), Number(m[3]));
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : startOfDay(d);
}

/** Quarters between two labels, inclusive, ordered — used by quarter tables. */
export function quartersOf(label: string): Period[] {
  return [1, 2, 3, 4].map((q) => resolvePeriod(label, q));
}
