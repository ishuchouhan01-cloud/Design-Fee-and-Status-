/**
 * One formatting utility for numbers, dates and money, so every screen and
 * export writes them the same way (the app's existing conventions).
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 25-Sep-2026, in UTC (dates are stored as UTC midnights). Empty → "—". */
export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const x = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(x.getTime())) return '—';
  return `${String(x.getUTCDate()).padStart(2, '0')}-${MONTHS[x.getUTCMonth()]}-${x.getUTCFullYear()}`;
}

/** 25-Sep-2026 14:05 */
export function formatDateTime(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const x = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(x.getTime())) return '—';
  return `${formatDate(x)} ${String(x.getUTCHours()).padStart(2, '0')}:${String(x.getUTCMinutes()).padStart(2, '0')}`;
}

/** Indian digit grouping (1,23,456). */
export function formatNumber(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-IN');
}

/** "x of y" */
export function formatOf(x: number, y: number): string {
  return `${formatNumber(x)} of ${formatNumber(y)}`;
}

/** Money in crore: "₹ 12.3456 Cr" (4 decimals, the design-fee convention). */
export function formatCrore(v: number | null | undefined, opts: { symbol?: boolean } = {}): string {
  if (v == null || Number.isNaN(v)) return '—';
  const s = v.toLocaleString('en-IN', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  return opts.symbol === false ? s : `₹ ${s} Cr`;
}

export function formatPercent(v: number | null | undefined, digits = 1): string {
  if (v == null || Number.isNaN(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}
