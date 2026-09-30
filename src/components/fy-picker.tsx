'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { yearLabel } from '@/lib/labels';

export function FiscalYearPicker({
  years,
  current,
  portfolio,
  showPortfolio = false,
}: {
  years: string[];
  current: string;
  portfolio?: string;
  showPortfolio?: boolean;
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(sp.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.push(`?${next.toString()}`);
  };
  return (
    <div className="flex items-end gap-2">
      <div>
        <label className="label" htmlFor="fy">
          Reporting period
        </label>
        <select id="fy" className="select w-56" value={current} onChange={(e) => set('fy', e.target.value)}>
          {years.map((y) => (
            <option key={y} value={y}>
              {yearLabel(y)}
            </option>
          ))}
        </select>
      </div>
      {showPortfolio && (
      <div>
        <label className="label" htmlFor="portfolio">
          Portfolio
        </label>
        <select
          id="portfolio"
          className="select w-44"
          value={portfolio ?? ''}
          onChange={(e) => set('portfolio', e.target.value)}
        >
          <option value="">All portfolios</option>
          {['Ongoing', 'New Projects', 'Design & Build', 'HPL', 'CSR', 'Interior Design + Product Development'].map(
            (p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ),
          )}
        </select>
      </div>
      )}
    </div>
  );
}
