/**
 * Billing roll-up — the ONE place that decides what a fee line contributes.
 * Used by the Project Drawing Status table, the Billing view, the exports and
 * the reconciliation report.
 *
 *   A fee line is a package × discipline line (package_fees) or, for Design
 *   Fee sheets with one fee per package, the whole-package line (packages.
 *   fee_value). It contributes Total / Billed / Unbilled only when at least one
 *   of its drawings is released. A line with no released drawing — including
 *   a discipline with no drawings at all, which the table does not show —
 *   contributes nothing: its row shows "—" and it is left out of every parent
 *   and of the header totals. The stored source values are never changed.
 *
 *   A left-out line that carries a Billed amount goes to "Billing to review"
 *   (reason: no drawings released), so nothing is dropped silently, and the
 *   reconciliation shows   source total = shown + left out.
 *
 * Amounts are rounded to 4 decimals at the line, so every parent shows
 * exactly the sum of what its children show.
 */

export type Billing = { total: number; billed: number; unbilled: number };

export interface FeeLineInput {
  total: number | null | undefined;
  billed: number | null | undefined;
  /** Released drawings of the line (all of them, whatever the filters). */
  released: number;
}

export interface LineOutcome {
  /** What the line contributes; null when it has no fee or is left out. */
  billing: Billing | null;
  /** The stored amounts of a line left out because none of its drawings is released. */
  excluded: { total: number; billed: number } | null;
}

export const EXCLUDED_NO_RELEASE = 'EXCLUDED_NO_RELEASE';
export const REVIEW_REASON_NO_RELEASE = 'No drawings released';

export function round4(v: number) {
  return Math.round(v * 10000) / 10000;
}

const hasAmount = (v: number | null | undefined) => v != null && Math.abs(v) > 1e-9;

export function lineBilling(l: FeeLineInput): LineOutcome {
  if (l.total == null && l.billed == null) return { billing: null, excluded: null };
  const total = round4(l.total ?? 0);
  const billed = round4(l.billed ?? 0);
  if (l.released <= 0) return { billing: null, excluded: hasAmount(total) || hasAmount(billed) ? { total, billed } : null };
  return { billing: { total, billed, unbilled: round4(total - billed) }, excluded: null };
}

export function addBilling(a: Billing | null, b: Billing | null): Billing | null {
  return !a ? b : !b ? a : { total: a.total + b.total, billed: a.billed + b.billed, unbilled: a.unbilled + b.unbilled };
}

/** Sums of 4-decimal amounts, cleaned of floating-point noise. */
export function roundBilling(b: Billing | null): Billing | null {
  return b ? { total: round4(b.total), billed: round4(b.billed), unbilled: round4(b.unbilled) } : null;
}

export interface ReviewLine {
  projectId: string;
  project: string;
  packageId: string;
  packageCode: string;
  packageName: string;
  /** Discipline group code, or the whole-package line. */
  discipline: string;
  disciplineName: string;
  total: number;
  billed: number;
  reason: string;
}

/** Running totals of what was left out (for the reconciliation). */
export interface ExcludedTotals {
  lines: number;
  total: number;
  billed: number;
}

export function emptyExcluded(): ExcludedTotals {
  return { lines: 0, total: 0, billed: 0 };
}

export function addExcluded(t: ExcludedTotals, e: { total: number; billed: number } | null) {
  if (!e) return;
  t.lines++;
  t.total = round4(t.total + e.total);
  t.billed = round4(t.billed + e.billed);
}
