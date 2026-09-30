'use client';

import { useRouter, useSearchParams } from 'next/navigation';

export function Pagination({
  page,
  pageCount,
  total,
  pageSize,
}: {
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const go = (p: number) => {
    const next = new URLSearchParams(sp.toString());
    next.set('page', String(p));
    router.push(`?${next.toString()}`);
  };
  const setSize = (s: string) => {
    const next = new URLSearchParams(sp.toString());
    next.set('pageSize', s);
    next.delete('page');
    router.push(`?${next.toString()}`);
  };
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-2.5">
      <p className="text-2xs text-ink-mute">
        Showing <span className="font-semibold text-ink-soft">{from.toLocaleString()}</span>–
        <span className="font-semibold text-ink-soft">{to.toLocaleString()}</span> of{' '}
        <span className="font-semibold text-ink-soft">{total.toLocaleString()}</span> records
      </p>
      <div className="flex items-center gap-2">
        <select className="select w-20" value={pageSize} onChange={(e) => setSize(e.target.value)}>
          {[25, 50, 100, 200, 500].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button className="btn btn-sm" disabled={page <= 1} onClick={() => go(1)}>
          First
        </button>
        <button className="btn btn-sm" disabled={page <= 1} onClick={() => go(page - 1)}>
          Prev
        </button>
        <span className="text-2xs text-ink-mute">
          Page {page} of {pageCount}
        </span>
        <button className="btn btn-sm" disabled={page >= pageCount} onClick={() => go(page + 1)}>
          Next
        </button>
        <button className="btn btn-sm" disabled={page >= pageCount} onClick={() => go(pageCount)}>
          Last
        </button>
      </div>
    </div>
  );
}
