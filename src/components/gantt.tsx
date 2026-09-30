import clsx from 'clsx';
import { addDays, diffDays, formatDate } from '@/lib/periods';
import type { GanttData } from '@/lib/services/gantt';

/**
 * Programme view. Three visually distinct tracks per row:
 *   BASELINE          hollow outline
 *   CURRENT EXPECTED  solid
 *   ACTUAL            solid dark with a tick
 * Links are drawn as thin connectors between rows.
 */
export function GanttChart({ data, maxRows = 80 }: { data: GanttData; maxRows?: number }) {
  if (!data.windowStart || !data.windowEnd || data.bars.length === 0) {
    return <p className="px-1 py-6 text-center text-[12px] text-ink-mute">No dated programme items for this project.</p>;
  }
  const start = addDays(data.windowStart, -14);
  const end = addDays(data.windowEnd, 14);
  const totalDays = Math.max(1, diffDays(end, start));
  const rows = data.bars.slice(0, maxRows);

  const x = (d: Date) => (diffDays(d, start) / totalDays) * 100;
  const width = (a: Date, b: Date) => Math.max(0.4, (diffDays(b, a) / totalDays) * 100);

  // month ticks
  const ticks: { label: string; left: number }[] = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cursor <= end) {
    ticks.push({
      label: `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][cursor.getUTCMonth()]} ${String(cursor.getUTCFullYear()).slice(2)}`,
      left: x(new Date(cursor)),
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  const todayLeft = x(new Date());

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-4 text-2xs text-ink-mute">
        <Legend className="border border-slate-400 bg-transparent" label="Baseline" />
        <Legend className="bg-brand-500" label="Current expected" />
        <Legend className="bg-slate-800" label="Actual (released)" />
        <Legend className="bg-rag-red" label="Delayed" />
        <Legend className="bg-violet-500" label="Rescheduled" />
        <span className="ml-auto">{data.links.length} link(s) · showing {rows.length} of {data.bars.length} rows</span>
      </div>

      <div className="overflow-auto">
        <div className="min-w-[900px]">
          <div className="relative h-5 border-b border-line">
            {ticks.map((t) => (
              <span
                key={t.label}
                className="absolute -top-0.5 text-2xs text-ink-mute"
                style={{ left: `calc(${t.left}% + 2px)` }}
              >
                {t.label}
              </span>
            ))}
          </div>
          <div className="relative">
            <div
              className="pointer-events-none absolute top-0 z-10 h-full border-l-2 border-dashed border-rag-red/60"
              style={{ left: `${todayLeft}%` }}
              title={`Today — ${formatDate(new Date())}`}
            />
            {ticks.map((t) => (
              <div
                key={`grid-${t.label}`}
                className="pointer-events-none absolute top-0 h-full border-l border-line/70"
                style={{ left: `${t.left}%` }}
              />
            ))}
            {rows.map((b) => {
              const bStart = b.baselineStart ?? b.baselineFinish;
              const bEnd = b.baselineFinish ?? b.baselineStart;
              const eStart = b.expectedStart ?? b.expectedFinish;
              const eEnd = b.expectedFinish ?? b.expectedStart;
              const expectedTone =
                b.completionStatus === 'COMPLETED'
                  ? 'bg-slate-800'
                  : b.scheduleStatus === 'DELAYED'
                    ? 'bg-rag-red'
                    : b.rescheduleCount > 0 || b.slipDays !== 0
                      ? 'bg-violet-500'
                      : 'bg-brand-500';
              return (
                <div key={`${b.entityType}-${b.entityId}`} className="relative flex items-center gap-2 border-b border-line/60 py-1">
                  <div className="w-72 shrink-0 truncate pr-2 text-[11.5px]" title={`${b.code} — ${b.label}`}>
                    <span
                      className="mr-1 inline-block rounded bg-slate-200 px-1 font-mono text-[9.5px] uppercase text-slate-600"
                      title={b.entityType}
                    >
                      {b.entityType === 'PACKAGE' ? 'pkg' : b.entityType === 'DELIVERABLE' ? 'del' : 'dwg'}
                    </span>
                    <span className="font-medium">{b.label}</span>
                    {b.entityType === 'PACKAGE' && <span className="ml-1 text-ink-mute">{b.code}</span>}
                  </div>
                  <div className="relative h-6 flex-1">
                    {bStart && bEnd && (
                      <div
                        className="absolute top-0 h-2 rounded-sm border border-slate-400/80 bg-transparent"
                        style={{ left: `${x(bStart)}%`, width: `${width(bStart, bEnd)}%`, minWidth: 8 }}
                        title={`Baseline ${formatDate(b.baselineStart)} → ${formatDate(b.baselineFinish)}`}
                      />
                    )}
                    {eStart && eEnd && (
                      <div
                        className={clsx('absolute top-2.5 h-2 rounded-sm', expectedTone)}
                        style={{ left: `${x(eStart)}%`, width: `${width(eStart, eEnd)}%`, minWidth: 8 }}
                        title={`Current expected ${formatDate(b.expectedFinish)}${b.slipDays ? ` (${b.slipDays > 0 ? '+' : ''}${b.slipDays}d vs baseline)` : ''}`}
                      />
                    )}
                    {b.actualFinish && (
                      <div
                        className="absolute top-5 h-1.5 rounded-sm bg-slate-900"
                        style={{ left: `${x(b.actualFinish)}%`, width: '0.6%', minWidth: 6 }}
                        title={`Actual release ${formatDate(b.actualFinish)}`}
                      />
                    )}
                  </div>
                  <div className="w-20 shrink-0 text-right font-mono text-[10.5px] text-ink-mute">
                    {b.slipDays !== 0 ? `${b.slipDays > 0 ? '+' : ''}${b.slipDays}d` : '—'}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={clsx('inline-block h-2 w-6 rounded-sm', className)} />
      {label}
    </span>
  );
}
