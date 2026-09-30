'use client';

/**
 * DFS Summary — package status and billing per project (with its towers /
 * products), then per discipline. Project rows count packages; discipline rows
 * count the package × discipline lines billing is made of.
 */
import clsx from 'clsx';
import { Fragment, useState } from 'react';
import { DFS_TOOLTIP, SUMMARY_LABEL } from '@/lib/labels';
import { formatCrore, formatNumber, formatPercent } from '@/lib/format';
import type { DfsSummary, DfsSummaryBlock, DfsSummaryRow } from '@/lib/services/dfs';

const cr = (v: number) => formatCrore(v, { symbol: false });

function useOpen(initial: string[]) {
  const [open, setOpen] = useState<Set<string>>(new Set(initial));
  const toggle = (k: string) =>
    setOpen((prev) => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  return { open, toggle, setOpen };
}

function PackageCells({ r }: { r: DfsSummaryRow }) {
  return (
    <>
      <td className="num">{formatNumber(r.packages)}</td>
      <td className="num text-rag-green">{formatNumber(r.complete)}</td>
      <td className={clsx('num', r.pending ? 'text-amber-800' : 'text-ink-mute')}>{formatNumber(r.pending)}</td>
      <td className="num font-medium">{formatPercent(r.overall)}</td>
    </>
  );
}

function BillingCells({ r }: { r: DfsSummaryRow }) {
  return (
    <>
      <td className="num">{cr(r.total)}</td>
      <td className="num text-rag-green">{cr(r.billed)}</td>
      <td className={clsx('num', r.unbilled > 1e-6 ? 'text-amber-800' : 'text-ink-mute')}>{cr(r.unbilled)}</td>
    </>
  );
}

function Blocks({ blocks, kind, open, toggle }: { blocks: DfsSummaryBlock[]; kind: 'packages' | 'billing'; open: Set<string>; toggle: (k: string) => void }) {
  return (
    <>
      {blocks.map((b) => {
        const o = open.has(b.row.key);
        const pad = { paddingLeft: `${0.75 + b.depth * 1.25}rem` };
        return (
          <Fragment key={b.row.key}>
            <tr className={clsx('font-semibold', b.projectId ? (b.depth === 0 ? 'bg-slate-50' : '') : 'bg-slate-100')}>
              <td className="whitespace-nowrap" style={pad}>
                <button type="button" className="inline-flex items-center gap-1.5 rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500" aria-expanded={o} onClick={() => toggle(b.row.key)}>
                  <span className="inline-block w-3 text-ink-mute" aria-hidden="true">
                    {o ? '▾' : '▸'}
                  </span>
                  {b.name}
                </button>
              </td>
              {kind === 'packages' ? <PackageCells r={b.row} /> : <BillingCells r={b.row} />}
            </tr>
            {o &&
              b.disciplines.map((d) => (
                <tr key={d.key}>
                  <td style={{ paddingLeft: `${0.75 + (b.depth + 1) * 1.25 + 1.125}rem` }}>{d.label}</td>
                  {kind === 'packages' ? <PackageCells r={d} /> : <BillingCells r={d} />}
                </tr>
              ))}
          </Fragment>
        );
      })}
    </>
  );
}

export function DfsSummaryPanel({ summary }: { summary: DfsSummary }) {
  const roots = summary.projects.filter((b) => b.depth === 0);
  const single = roots.length === 1;
  const blocks = single ? summary.projects : [...summary.projects, summary.total];
  const t = single ? roots[0].row : summary.total.row;
  const first = single ? [roots[0].row.key] : [];
  const pk = useOpen(first);
  const bl = useOpen(first);
  if (!summary.projects.length) return <p className="card px-4 py-10 text-center text-[12.5px] text-ink-mute">No packages match the current filters.</p>;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          { label: SUMMARY_LABEL.packages, value: formatNumber(t.packages) },
          { label: SUMMARY_LABEL.complete, value: formatNumber(t.complete), cls: 'text-rag-green' },
          { label: SUMMARY_LABEL.pending, value: formatNumber(t.pending), cls: t.pending ? 'text-amber-800' : '' },
          { label: SUMMARY_LABEL.overall, value: formatPercent(t.overall), hint: 'of packages complete' },
        ].map((k) => (
          <div key={k.label} className="card p-3">
            <div className="text-2xs font-semibold uppercase tracking-wide text-ink-mute">{k.label}</div>
            <div className={clsx('text-xl font-semibold', k.cls)}>{k.value}</div>
            {k.hint && <div className="text-2xs text-ink-mute">{k.hint}</div>}
          </div>
        ))}
      </div>

      {(['packages', 'billing'] as const).map((kind) => {
        const st = kind === 'packages' ? pk : bl;
        return (
          <div className="card" key={kind}>
            <div className="flex items-center justify-between border-b border-line px-4 py-2">
              <h2 className="text-[13px] font-semibold">{kind === 'packages' ? SUMMARY_LABEL.packageSummary : SUMMARY_LABEL.billing}</h2>
              <button type="button" className="btn btn-sm" onClick={() => st.setOpen((prev) => (prev.size ? new Set() : new Set(blocks.map((b) => b.row.key))))}>
                {st.open.size ? 'Collapse All' : 'Expand All'}
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>{SUMMARY_LABEL.projectDiscipline}</th>
                    {kind === 'packages' ? (
                      <>
                        <th className="num">{SUMMARY_LABEL.packages}</th>
                        <th className="num">{SUMMARY_LABEL.complete}</th>
                        <th className="num">{SUMMARY_LABEL.pending}</th>
                        <th className="num" title={DFS_TOOLTIP.overall}>
                          {SUMMARY_LABEL.overall}
                        </th>
                      </>
                    ) : (
                      <>
                        <th className="num" title={DFS_TOOLTIP.total}>
                          {SUMMARY_LABEL.total}
                        </th>
                        <th className="num" title={DFS_TOOLTIP.billed}>
                          {SUMMARY_LABEL.billed}
                        </th>
                        <th className="num" title={DFS_TOOLTIP.unbilled}>
                          {SUMMARY_LABEL.unbilled}
                        </th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  <Blocks blocks={blocks} kind={kind} open={st.open} toggle={st.toggle} />
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
      <p className="text-2xs text-ink-mute">Project rows count packages. Discipline rows count each package&rsquo;s discipline lines, which is how the design fee is billed.</p>
    </div>
  );
}
