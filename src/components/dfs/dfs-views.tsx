/**
 * Year / Quarter view — package status and billing per discipline over years
 * and quarters, from the same packages as the Design Fee Schedule (DFS).
 */
import clsx from 'clsx';
import Link from 'next/link';
import { Card, Note, TableWrap } from '@/components/ui';
import { formatCrore } from '@/lib/format';
import type { dfsPeriods } from '@/lib/services/dfs';

type Periods = Awaited<ReturnType<typeof dfsPeriods>>;

/** Discipline-wise status and billing over years and quarters. */
export function DfsPeriodsView({ data, basisHref }: { data: Periods; basisHref: (b: 'CY' | 'FY') => string }) {
  const metrics = [
    { key: 'planned', label: 'Packages planned', fmt: (v: number) => (v ? String(v) : '') },
    { key: 'completed', label: 'Packages complete', fmt: (v: number) => (v ? String(v) : '') },
    { key: 'scopePlanned', label: 'Billing planned (₹ Cr)', fmt: (v: number) => (v ? formatCrore(v, { symbol: false }) : '') },
    { key: 'actual', label: 'Billed (₹ Cr)', fmt: (v: number) => (v ? formatCrore(v, { symbol: false }) : '') },
  ] as const;
  const rows = [...data.rows, data.total];
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-2xs text-ink-mute">Basis:</span>
        {(['CY', 'FY'] as const).map((b) => (
          <Link key={b} href={basisHref(b)} className={clsx('btn btn-sm', data.basis === b && 'btn-primary')}>
            {b === 'CY' ? 'Calendar Year (drawing plan)' : 'Financial Year (April–March)'}
          </Link>
        ))}
      </div>
      <Note>
        Counts are packages by discipline. Planned: the quarter of the latest expected release date. Complete: the quarter the last
        drawing was released — from the release dates, or from the quarter or year the source gives (for example &ldquo;Issued 2026
        Quarter 1&rdquo;). A release the source gives only as &ldquo;before 01-Jan-2026&rdquo; stays in its own <i>Before</i> column; no date is
        made up.
      </Note>
      <Card bodyClassName="">
        <TableWrap maxHeight="70vh">
          <table className="table">
            <thead>
              <tr>
                <th rowSpan={2}>Discipline</th>
                <th rowSpan={2}>Measure</th>
                {data.years.map((y) => (
                  <th key={y.year} colSpan={y.buckets.length} className="text-center">
                    {y.year}
                  </th>
                ))}
                <th rowSpan={2} className="num">
                  Total
                </th>
              </tr>
              <tr>
                {data.columns.map((c) => (
                  <th key={c.key} className="num whitespace-nowrap">
                    {c.year ? c.label : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) =>
                metrics.map((m, i) => (
                  <tr key={`${r.discipline}-${m.key}`} className={clsx(i === 0 && 'border-t-2 border-line', r.discipline === 'TOTAL' && 'font-semibold')}>
                    {i === 0 && (
                      <td rowSpan={metrics.length} className="align-top font-medium">
                        {r.disciplineName}
                      </td>
                    )}
                    <td className="whitespace-nowrap text-2xs text-ink-mute">{m.label}</td>
                    {data.columns.map((c) => (
                      <td key={c.key} className="num">
                        {m.fmt(r.cells[c.key]?.[m.key] ?? 0)}
                      </td>
                    ))}
                    <td className="num">{m.fmt(r.totals[m.key])}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </TableWrap>
      </Card>
    </div>
  );
}
