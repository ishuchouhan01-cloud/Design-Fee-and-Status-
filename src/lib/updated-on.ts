/**
 * "Updated On" for a drawing.
 *
 * 1. When a person last changed the drawing in Drawing Control (date and time).
 * 2. Otherwise the date the source gives: the actual issue / release date,
 *    date of receipt, ACC release date, or a revision date.
 * 3. Otherwise the period the source gives, as the source gives it
 *    ("Quarter 2, 2026", "2026", "Before 01-Jan-2026").
 * 4. Otherwise "—".
 *
 * The time an import ran is never used.
 */
import { formatDate } from '@/lib/format';
import { calendarQuarter } from '@/lib/periods';

export interface SourceDating {
  sourceDate: Date | null;
  sourcePeriodLabel: string | null;
  sourcePeriodStart: Date | null;
  sourcePeriodEnd: Date | null;
}

const EV_BEFORE = /^Issued before 01-Jan-(\d{4})$/;
const EV_QUARTER = /^Issued (\d{4}) Q([1-4])$/;
const EV_YEAR = /^Issued in (\d{4})$/;

/** The source date or period of a drawing, from what an import read. */
export function sourceDating(actual: Date | null | undefined, evidence: string | null | undefined, revisionDate?: Date | null): SourceDating {
  const date = actual ?? revisionDate ?? null;
  if (date) return { sourceDate: date, sourcePeriodLabel: null, sourcePeriodStart: null, sourcePeriodEnd: null };
  const none: SourceDating = { sourceDate: null, sourcePeriodLabel: null, sourcePeriodStart: null, sourcePeriodEnd: null };
  if (!evidence) return none;
  let m = EV_QUARTER.exec(evidence);
  if (m) {
    const p = calendarQuarter(Number(m[1]), Number(m[2]));
    return { sourceDate: null, sourcePeriodLabel: `Quarter ${m[2]}, ${m[1]}`, sourcePeriodStart: p.start, sourcePeriodEnd: p.end };
  }
  m = EV_YEAR.exec(evidence);
  if (m) {
    const y = Number(m[1]);
    return { sourceDate: null, sourcePeriodLabel: String(y), sourcePeriodStart: calendarQuarter(y, 1).start, sourcePeriodEnd: calendarQuarter(y, 4).end };
  }
  m = EV_BEFORE.exec(evidence);
  if (m) {
    return { sourceDate: null, sourcePeriodLabel: `Before 01-Jan-${m[1]}`, sourcePeriodStart: null, sourcePeriodEnd: new Date(Date.UTC(Number(m[1]), 0, 1) - 1) };
  }
  return none;
}

export type UpdatedOn =
  | { kind: 'EDITED'; at: Date }
  | { kind: 'DATE'; date: Date }
  | { kind: 'PERIOD'; label: string }
  | { kind: 'NONE' };

export function updatedOn(d: { editedAt?: Date | null; sourceDate?: Date | null; sourcePeriodLabel?: string | null }): UpdatedOn {
  if (d.editedAt) return { kind: 'EDITED', at: d.editedAt };
  if (d.sourceDate) return { kind: 'DATE', date: d.sourceDate };
  if (d.sourcePeriodLabel) return { kind: 'PERIOD', label: d.sourcePeriodLabel };
  return { kind: 'NONE' };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** An edit's date and time in the office's time zone (APP_TIME_ZONE, default India). */
export function editTime(at: Date, timeZone = process.env.APP_TIME_ZONE || 'Asia/Kolkata'): string {
  let parts: Record<string, string>;
  try {
    parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(at)
        .map((p) => [p.type, p.value]),
    );
  } catch {
    return editTime(at, 'UTC');
  }
  return `${parts.day}-${MONTHS[Number(parts.month) - 1]}-${parts.year} ${parts.hour}:${parts.minute}`;
}

/** Display text: an edit as date and time, a source date as its date, a period as given, else "—". */
export function updatedOnText(d: { editedAt?: Date | null; sourceDate?: Date | null; sourcePeriodLabel?: string | null }): string {
  const u = updatedOn(d);
  switch (u.kind) {
    case 'EDITED':
      return editTime(u.at);
    case 'DATE':
      return formatDate(u.date);
    case 'PERIOD':
      return u.label;
    default:
      return '—';
  }
}

/** Sortable instant: the edit, the source date, or the end of the source period. */
export function updatedOnSortKey(d: { editedAt?: Date | null; sourceDate?: Date | null; sourcePeriodEnd?: Date | null }): number | null {
  const x = d.editedAt ?? d.sourceDate ?? d.sourcePeriodEnd ?? null;
  return x ? x.getTime() : null;
}
