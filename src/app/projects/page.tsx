import Link from 'next/link';
import { Bar, Card, DateCell, Delta, Kpi, PageHeader, Pct, RagBadge, TableWrap } from '@/components/ui';
import { FiscalYearPicker } from '@/components/fy-picker';
import { buildExecutiveDashboard } from '@/lib/services/dashboard';
import { fiscalYears, getSetting } from '@/lib/services/reference';
import { projectLabel } from '@/lib/labels';

export const dynamic = 'force-dynamic';

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ fy?: string; portfolio?: string }>;
}) {
  const sp = await searchParams;
  const years = await fiscalYears();
  const fy = sp.fy && years.includes(sp.fy) ? sp.fy : await getSetting('app.currentFiscalYear', years[0] ?? 'FY26-27');
  const d = await buildExecutiveDashboard({ fiscalYear: fy, portfolio: sp.portfolio });

  const byPortfolio = new Map<string, typeof d.projectRows>();
  for (const p of d.projectRows) {
    const list = byPortfolio.get(p.portfolio) ?? [];
    list.push(p);
    byPortfolio.set(p.portfolio, list);
  }

  return (
    <>
      <PageHeader
        title="Projects"
        description="Every project is a row of data in one generic model. There is no project-specific logic anywhere in the application."
        crumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Projects' }]}
        actions={<FiscalYearPicker years={years} current={fy} portfolio={sp.portfolio} showPortfolio />}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Projects" value={d.projectCount} />
        <Kpi label="With goals this period" value={d.projectRows.filter((p) => p.plannedPackages > 0).length} />
        <Kpi label="At risk" value={d.atRiskProjects} tone={d.atRiskProjects ? 'warn' : 'good'} />
        <Kpi label="On hold" value={d.projectRows.filter((p) => p.onHold).length} />
      </div>

      {[...byPortfolio.entries()].map(([portfolio, rows]) => (
        <Card key={portfolio} title={portfolio} subtitle={`${rows.length} project(s)`} className="mt-4" bodyClassName="">
          <TableWrap>
            <table className="table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th className="num">Plan (packages)</th>
                  <th className="num">Delivered</th>
                  <th className="num">%</th>
                  <th className="w-24">Progress</th>
                  <th className="num">Items</th>
                  <th className="num">Overdue</th>
                  <th className="num">Billing plan (₹ Cr)</th>
                  <th>Baseline</th>
                  <th>Forecast</th>
                  <th className="num">Slip</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.projectId}>
                    <td>
                      <Link href={`/projects/${p.projectId}`} className="link font-medium">
                        {projectLabel({ displayName: p.projectDisplayName, projectName: p.projectName })}
                      </Link>
                      {p.onHold && <span className="ml-1.5 pill bg-slate-200 text-slate-700">on hold</span>}
                    </td>
                    <td className="num">{p.plannedPackages}</td>
                    <td className="num">{p.deliveredPackages}</td>
                    <td className="num">
                      <Pct value={p.packageCompletionPercent} />
                    </td>
                    <td>
                      <Bar value={p.deliveredPackages} total={p.plannedPackages} />
                    </td>
                    <td className="num">{p.items > 0 ? `${p.itemsCompleted}/${p.items}` : '—'}</td>
                    <td className="num">{p.overdueItems || '—'}</td>
                    <td className="num">{p.plannedValue.toFixed(2)}</td>
                    <td>
                      <DateCell value={p.baselineDate} muted />
                    </td>
                    <td>
                      <DateCell value={p.expectedForecastDate} />
                    </td>
                    <td className="num">
                      <Delta value={-p.varianceDays} suffix="d" />
                    </td>
                    <td>
                      <RagBadge rag={p.rag} title={p.ragReason} overridden={p.ragOverridden} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      ))}
    </>
  );
}
