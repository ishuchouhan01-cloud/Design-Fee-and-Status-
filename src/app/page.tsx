import Link from 'next/link';
import { CumulativeChart, DisciplineChart, QuarterChart } from '@/components/charts';
import {
  Bar,
  Card,
  DateCell,
  Delta,
  Empty,
  Kpi,
  Note,
  PageHeader,
  Pct,
  RagBadge,
  TableWrap,
} from '@/components/ui';
import { buildExecutiveDashboard } from '@/lib/services/dashboard';
import { fiscalYears, getSetting } from '@/lib/services/reference';
import { formatDate } from '@/lib/periods';
import { FiscalYearPicker } from '@/components/fy-picker';
import { projectLabel } from '@/lib/labels';

export const dynamic = 'force-dynamic';

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ fy?: string; portfolio?: string }>;
}) {
  const sp = await searchParams;
  const years = await fiscalYears();
  const fy = sp.fy && years.includes(sp.fy) ? sp.fy : (await getSetting('app.currentFiscalYear', years[0] ?? 'FY26-27'));
  const d = await buildExecutiveDashboard({ fiscalYear: fy, portfolio: sp.portfolio });

  const cumulative = d.quarters.reduce<{ label: string; plan: number; actual: number }[]>((acc, q, i) => {
    const prev = acc[i - 1];
    acc.push({
      label: q.label,
      plan: (prev?.plan ?? 0) + q.plan,
      actual: (prev?.actual ?? 0) + q.completed,
    });
    return acc;
  }, []);

  return (
    <>
      <PageHeader
        title="Executive dashboard"
        description={`Where we are, whether we are on plan, which projects are behind, what has moved and why — as at ${formatDate(d.today)}.`}
        actions={<FiscalYearPicker years={years} current={fy} portfolio={sp.portfolio} showPortfolio />}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-8">
        <Kpi
          label="Goals in period"
          value={d.goalBlock.goalCount}
          hint={`${d.goalBlock.completedGoals} met · ${d.goalBlock.openGoals} open`}
        />
        <Kpi
          label="Planned packages"
          value={d.goalBlock.plannedPackages.toLocaleString()}
          hint={`₹ ${d.goalBlock.plannedValue.toFixed(1)} Cr planned billing`}
        />
        <Kpi
          label="Delivered packages"
          value={d.goalBlock.deliveredPackages.toLocaleString()}
          hint={`₹ ${d.goalBlock.actualValue.toFixed(1)} Cr reported`}
          tone="good"
        />
        <Kpi
          label="Goal completion"
          value={d.goalBlock.completionPercent.toFixed(1)}
          suffix="%"
          hint="delivered ÷ planned packages — calculated"
        />
        <Kpi label="Projects" value={d.projectCount} hint={`${sp.portfolio ?? 'all portfolios'}`} />
        <Kpi
          label="At-risk projects"
          value={d.atRiskProjects}
          tone={d.atRiskProjects > 0 ? 'warn' : 'good'}
          hint="Status Amber or Red"
        />
        <Kpi
          label="Delayed deliverables"
          value={d.deliveryBlock.overdue}
          tone={d.deliveryBlock.overdue > 0 ? 'bad' : 'good'}
          hint="past expected release, still open"
        />
        <Kpi
          label="Rescheduled items"
          value={d.deliveryBlock.rescheduled}
          hint="expected date moved off baseline"
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card
          title="Plan vs actual — enumerated delivery items"
          subtitle="Deliverables and drawings that exist as individual records"
          className="xl:col-span-1"
        >
          <dl className="space-y-1.5 text-[12.5px]">
            {[
              ['Plan', d.deliveryBlock.planned.toLocaleString()],
              ['Expected by today', d.deliveryBlock.expectedByToday.toLocaleString()],
              ['Actual (completed)', d.deliveryBlock.completed.toLocaleString()],
              ['Remaining', d.deliveryBlock.remaining.toLocaleString()],
            ].map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-4">
                <dt className="text-ink-mute">{k}</dt>
                <dd className="font-mono font-semibold tabular-nums">{v}</dd>
              </div>
            ))}
            <div className="flex items-baseline justify-between gap-4 border-t border-line pt-1.5">
              <dt className="text-ink-mute">Variance vs expected</dt>
              <dd>
                <Delta value={d.deliveryBlock.variance} />
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-ink-mute">Forecast within period</dt>
              <dd className="font-mono font-semibold tabular-nums">{d.deliveryBlock.forecast.toLocaleString()}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-ink-mute">Completion</dt>
              <dd>
                <Pct value={d.deliveryBlock.completionPercent} />
              </dd>
            </div>
          </dl>
          <div className="mt-3">
            <Bar value={d.deliveryBlock.completed} total={d.deliveryBlock.planned} />
          </div>
          <p className="mt-3 text-2xs leading-relaxed text-ink-mute">
            Assumptions: &ldquo;expected by today&rdquo; counts items whose <em>baseline</em> date has passed;
            &ldquo;forecast&rdquo; counts items whose current expected date still falls inside the period. Goals are
            counted separately above because they are quantity targets, not individual records.
          </p>
        </Card>

        <Card title="Quarterly performance" subtitle="Packages planned, forecast and delivered" className="xl:col-span-1">
          <QuarterChart data={d.quarters.map((q) => ({ label: q.label, plan: q.plan, completed: q.completed, forecast: q.forecast }))} />
          <TableWrap>
            <table className="table mt-2">
              <thead>
                <tr>
                  <th>Quarter</th>
                  <th className="num">Plan</th>
                  <th className="num">Delivered</th>
                  <th className="num">Variance</th>
                  <th className="num">Forecast</th>
                  <th className="num">%</th>
                </tr>
              </thead>
              <tbody>
                {d.quarters.map((q) => (
                  <tr key={q.quarter}>
                    <td className="font-semibold">{q.label}</td>
                    <td className="num">{q.plan}</td>
                    <td className="num">{q.completed}</td>
                    <td className="num">
                      <Delta value={q.variance} />
                    </td>
                    <td className="num">{q.forecast}</td>
                    <td className="num">
                      <Pct value={q.completionPercent} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>

        <Card title="Cumulative plan vs delivered" subtitle="Packages, cumulative across the period" className="xl:col-span-1">
          <CumulativeChart data={cumulative} />
          <div className="mt-3">
            <p className="card-title mb-2">Delivery by discipline</p>
            <DisciplineChart data={d.disciplineRows.slice(0, 8)} />
          </div>
        </Card>
      </div>

      <Card
        title="Project performance"
        subtitle="Ordered by status, then by plan size. Packages come from goals; items are individual deliverables and drawings."
        className="mt-4"
        bodyClassName=""
        actions={
          <Link href="/projects" className="btn btn-sm">
            All projects
          </Link>
        }
      >
        <TableWrap maxHeight="520px">
          <table className="table">
            <thead>
              <tr>
                <th>Project</th>
                <th>Portfolio</th>
                <th className="num">Plan (packages)</th>
                <th className="num">Delivered</th>
                <th className="num">Remaining</th>
                <th className="num">%</th>
                <th className="w-24">Progress</th>
                <th className="num">Items</th>
                <th className="num">Overdue</th>
                <th>Forecast</th>
                <th className="num">Variance</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {d.projectRows.filter((p) => p.plannedPackages > 0 || p.items > 0).map((p) => (
                <tr key={p.projectId}>
                  <td>
                    <Link href={`/projects/${p.projectId}`} className="link font-medium">
                      {projectLabel({ displayName: p.projectDisplayName, projectName: p.projectName })}
                    </Link>
                    {p.onHold && <span className="ml-1.5 pill bg-slate-200 text-slate-700">on hold</span>}
                  </td>
                  <td className="text-ink-mute">{p.portfolio}</td>
                  <td className="num">{p.plannedPackages}</td>
                  <td className="num">{p.deliveredPackages}</td>
                  <td className="num">{p.remainingPackages}</td>
                  <td className="num">
                    <Pct value={p.packageCompletionPercent} />
                  </td>
                  <td>
                    <Bar value={p.deliveredPackages} total={p.plannedPackages} />
                  </td>
                  <td className="num">
                    {p.items > 0 ? (
                      <span title={`${p.itemsCompleted} of ${p.items} completed`}>
                        {p.itemsCompleted}/{p.items}
                      </span>
                    ) : (
                      <span className="text-ink-mute">—</span>
                    )}
                  </td>
                  <td className="num">
                    {p.overdueItems > 0 ? <span className="font-semibold text-rag-red">{p.overdueItems}</span> : '—'}
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

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title="Needs management attention" subtitle="Overdue work, ordered by how late it is">
          {d.attention.overdueDeliverables.length + d.attention.overdueDrawings.length === 0 ? (
            <Empty>Nothing is past its current expected release date.</Empty>
          ) : (
            <TableWrap maxHeight="260px">
              <table className="table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Project</th>
                    <th>Expected</th>
                    <th className="num">Days late</th>
                  </tr>
                </thead>
                <tbody>
                  {[...d.attention.overdueDeliverables, ...d.attention.overdueDrawings]
                    .sort((a, b) => (b.days ?? 0) - (a.days ?? 0))
                    .slice(0, 30)
                    .map((a) => (
                      <tr key={`${a.entityType}-${a.entityId}`}>
                        <td>
                          <Link
                            href={a.entityType === 'DRAWING' ? `/drawings?search=${encodeURIComponent(a.code)}` : `/deliverables?search=${encodeURIComponent(a.code)}`}
                            className="link"
                          >
                            {a.label}
                          </Link>
                          <div className="sub">{a.code}</div>
                        </td>
                        <td className="text-ink-mute">{a.projectName}</td>
                        <td>
                          <DateCell value={a.date} />
                        </td>
                        <td className="num font-semibold text-rag-red">{a.days}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        <Card title="What has moved, and why" subtitle="Most recent reschedules with the reason recorded at the time">
          {d.attention.recentReschedules.length === 0 ? (
            <Empty>No reschedules recorded yet.</Empty>
          ) : (
            <TableWrap maxHeight="260px">
              <table className="table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>New date</th>
                    <th className="num">Shift</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {d.attention.recentReschedules.slice(0, 25).map((a, i) => (
                    <tr key={`${a.entityId}-${i}`}>
                      <td className="max-w-[220px] truncate" title={a.label}>
                        {a.label}
                      </td>
                      <td>
                        <DateCell value={a.date} />
                      </td>
                      <td className="num">
                        <Delta value={a.days ?? 0} suffix="d" />
                      </td>
                      <td className="max-w-[260px] text-ink-mute">{a.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        <Card title="Delayed goals" subtitle="Target date passed with the quantity not yet delivered">
          {d.attention.delayedGoals.length === 0 ? (
            <Empty>No goals are past their target date.</Empty>
          ) : (
            <TableWrap maxHeight="240px">
              <table className="table">
                <thead>
                  <tr>
                    <th>Goal</th>
                    <th>Project</th>
                    <th>Target</th>
                    <th>Position</th>
                  </tr>
                </thead>
                <tbody>
                  {d.attention.delayedGoals.slice(0, 20).map((a) => (
                    <tr key={a.entityId}>
                      <td className="max-w-[240px]">
                        <Link href={`/goals?search=${encodeURIComponent(a.code)}`} className="link">
                          {a.label}
                        </Link>
                      </td>
                      <td className="text-ink-mute">{a.projectName}</td>
                      <td>
                        <DateCell value={a.date} />
                      </td>
                      <td className="text-ink-mute">{a.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        <Card title="Upcoming releases" subtitle="Due in the next 21 days">
          {d.attention.upcomingReleases.length === 0 ? (
            <Empty>Nothing due in the next three weeks.</Empty>
          ) : (
            <TableWrap maxHeight="240px">
              <table className="table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Project</th>
                    <th>Expected</th>
                    <th className="num">In</th>
                  </tr>
                </thead>
                <tbody>
                  {d.attention.upcomingReleases.map((a) => (
                    <tr key={`${a.entityType}-${a.entityId}`}>
                      <td className="max-w-[240px] truncate" title={a.label}>
                        {a.label}
                      </td>
                      <td className="text-ink-mute">{a.projectName}</td>
                      <td>
                        <DateCell value={a.date} />
                      </td>
                      <td className="num">{a.days}d</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      </div>

      {d.attention.majorMovements.length > 0 && (
        <div className="mt-4">
          <Note tone="warn">
            <strong>{d.attention.majorMovements.length} major schedule movement(s)</strong> of 15 days or more have been
            recorded. Every one is in the reschedule history, with its reason and the person who made it.
          </Note>
        </div>
      )}
    </>
  );
}
