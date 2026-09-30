import Link from 'next/link';
import { notFound } from 'next/navigation';
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
import { GanttChart } from '@/components/gantt';
import { RagOverrideControl } from '@/components/rag-override';
import { RescheduleButton } from '@/components/reschedule-dialog';
import { buildProjectDashboard } from '@/lib/services/dashboard';
import { buildGantt } from '@/lib/services/gantt';
import { fiscalYears, getSetting } from '@/lib/services/reference';
import { formatDate } from '@/lib/periods';
import { FiscalYearPicker } from '@/components/fy-picker';
import { projectLabel, yearLabel } from '@/lib/labels';

export const dynamic = 'force-dynamic';

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ fy?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const years = await fiscalYears();
  const fy = sp.fy && years.includes(sp.fy) ? sp.fy : await getSetting('app.currentFiscalYear', years[0] ?? 'FY26-27');
  const d = await buildProjectDashboard(id, fy);
  if (!d) notFound();
  const name = projectLabel(d.project);
  const gantt = await buildGantt({ projectId: id, include: ['PACKAGE', 'DELIVERABLE'], limit: 200 });

  return (
    <>
      <PageHeader
        title={name}
        description={
          <>
            {d.project.portfolio}
            {d.project.phase ? ` · ${d.project.phase}` : ''}
            {d.project.description ? ` · ${d.project.description}` : ''}
            {d.project.onHold ? ' · ON HOLD' : ''}
          </>
        }
        crumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Projects', href: '/projects' },
          { label: name },
        ]}
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <FiscalYearPicker years={years} current={fy} />
            <RescheduleButton
              entityType="DELIVERABLE"
              ids={[]}
              projectId={id}
              label={`${name} — every incomplete deliverable`}
              buttonLabel="Reschedule project"
              className="btn"
            />
            <Link href={`/schedule?projectId=${id}`} className="btn">
              Programme view
            </Link>
          </div>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <RagBadge rag={d.rag.rag} title={d.rag.reason} overridden={d.rag.overridden} />
        <span className="text-[12px] text-ink-mute">{d.rag.reason}</span>
        <div className="ml-auto">
          <RagOverrideControl
            entityId={id}
            calculated={d.rag.calculated}
            current={d.rag.rag}
            overridden={d.rag.overridden}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-8">
        <Kpi label="Goals" value={d.goalSummary.goalCount} hint={`${d.goalSummary.completedGoals} met`} />
        <Kpi label="Planned packages" value={d.goalSummary.plannedPackages} />
        <Kpi label="Delivered packages" value={d.goalSummary.deliveredPackages} tone="good" />
        <Kpi label="Package completion" value={d.goalSummary.completionPercent.toFixed(1)} suffix="%" />
        <Kpi label="Delivery items" value={d.deliverySummary.planned} hint="deliverables + drawings" />
        <Kpi label="Items completed" value={d.deliverySummary.completed} tone="good" />
        <Kpi
          label="Items overdue"
          value={d.deliverySummary.overdue}
          tone={d.deliverySummary.overdue ? 'bad' : 'good'}
        />
        <Kpi label="Item completion" value={d.deliverySummary.completionPercent.toFixed(1)} suffix="%" />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card title="Plan vs actual" subtitle="Enumerated delivery items">
          <dl className="space-y-1.5 text-[12.5px]">
            <Line k="Plan" v={d.deliverySummary.planned} />
            <Line k="Expected by today" v={d.deliverySummary.expectedByToday} />
            <Line k="Actual" v={d.deliverySummary.completed} />
            <Line k="Remaining" v={d.deliverySummary.remaining} />
            <div className="flex items-baseline justify-between border-t border-line pt-1.5">
              <dt className="text-ink-mute">Variance</dt>
              <dd>
                <Delta value={d.deliverySummary.variance} />
              </dd>
            </div>
            <Line k="Forecast" v={d.deliverySummary.forecast} />
          </dl>
          <div className="mt-3">
            <Bar value={d.deliverySummary.completed} total={d.deliverySummary.planned} />
          </div>
        </Card>

        <Card title="Forecast" subtitle="Based on the current expected dates">
          <dl className="space-y-1.5 text-[12.5px]">
            <div className="flex items-baseline justify-between">
              <dt className="text-ink-mute">Original baseline completion</dt>
              <dd>
                <DateCell value={d.forecast.baselineCompletion} muted />
              </dd>
            </div>
            <div className="flex items-baseline justify-between">
              <dt className="text-ink-mute">Current forecast completion</dt>
              <dd>
                <DateCell value={d.forecast.forecastCompletion} />
              </dd>
            </div>
            <div className="flex items-baseline justify-between border-t border-line pt-1.5">
              <dt className="text-ink-mute">Variance</dt>
              <dd>
                <Delta value={-d.forecast.varianceDays} suffix=" days" />
              </dd>
            </div>
            <Line k="Reschedules recorded" v={d.forecast.rescheduleCount} />
            <Line k="Rescheduled goals" v={d.goalSummary.rescheduledGoals} />
          </dl>
          <p className="mt-3 text-2xs leading-relaxed text-ink-mute">
            The original commitment stays visible: the baseline column is never overwritten, so a slipped project still
            reports what it promised.
          </p>
        </Card>

        <Card title="Quarterly plan" subtitle={`${yearLabel(fy)} package targets`} bodyClassName="">
          <TableWrap>
            <table className="table">
              <thead>
                <tr>
                  <th>Quarter</th>
                  <th>Ends</th>
                  <th className="num">Plan</th>
                  <th className="num">Delivered</th>
                  <th className="num">Variance</th>
                  <th className="num">Forecast</th>
                  <th className="num">%</th>
                </tr>
              </thead>
              <tbody>
                {d.byQuarter.map((q) => (
                  <tr key={q.quarter}>
                    <td className="font-semibold">{q.label}</td>
                    <td>
                      <DateCell value={q.periodEnd} muted />
                    </td>
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
      </div>

      <Card
        title="By discipline"
        subtitle="Drill down: project → discipline → goal / package → deliverable → drawing"
        className="mt-4"
        bodyClassName=""
      >
        <TableWrap>
          <table className="table">
            <thead>
              <tr>
                <th>Discipline</th>
                <th className="num">Plan (packages)</th>
                <th className="num">Delivered</th>
                <th className="num">%</th>
                <th className="num">Items</th>
                <th className="num">Completed</th>
                <th className="num">%</th>
                <th className="num">Overdue</th>
                <th>Status</th>
                <th>Drill down</th>
              </tr>
            </thead>
            <tbody>
              {d.byDiscipline.map((r) => (
                <tr key={r.disciplineId ?? 'none'}>
                  <td className="font-medium">{r.disciplineName}</td>
                  <td className="num">{r.plannedPackages}</td>
                  <td className="num">{r.deliveredPackages}</td>
                  <td className="num">
                    <Pct value={r.packagePercent} />
                  </td>
                  <td className="num">{r.items}</td>
                  <td className="num">{r.itemsCompleted}</td>
                  <td className="num">
                    <Pct value={r.itemPercent} />
                  </td>
                  <td className="num">{r.overdue || '—'}</td>
                  <td>
                    <RagBadge rag={r.rag} />
                  </td>
                  <td className="space-x-1.5">
                    <Link
                      href={`/goals?projectId=${id}&fiscalYear=${fy}${r.disciplineId ? `&disciplineId=${r.disciplineId}` : ''}`}
                      className="link"
                    >
                      goals
                    </Link>
                    <Link
                      href={`/deliverables?projectId=${id}${r.disciplineId ? `&disciplineId=${r.disciplineId}` : ''}`}
                      className="link"
                    >
                      delivery
                    </Link>
                    <Link
                      href={`/drawings?projectId=${id}${r.disciplineId ? `&disciplineId=${r.disciplineId}` : ''}`}
                      className="link"
                    >
                      drawings
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>

      {d.packages.length > 0 && (
        <Card
          title="Packages"
          subtitle="Baseline, current expected and actual release dates side by side"
          className="mt-4"
          bodyClassName=""
        >
          <TableWrap maxHeight="360px">
            <table className="table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Package</th>
                  <th>Group</th>
                  <th className="num">Duration</th>
                  <th>Baseline release</th>
                  <th>Current expected</th>
                  <th>Actual</th>
                  <th className="num">Slip</th>
                  <th className="num">Items</th>
                  <th className="num">%</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {d.packages.map((p) => (
                  <tr key={p.id}>
                    <td className="font-mono text-[11px]">{p.packageCode}</td>
                    <td className="max-w-[240px]">{p.packageName}</td>
                    <td className="text-ink-mute">{p.packageGroup ?? '—'}</td>
                    <td className="num">{p.durationDays ?? '—'}</td>
                    <td>
                      <DateCell value={p.baselineReleaseDate} muted />
                    </td>
                    <td>
                      <DateCell value={p.currentExpectedReleaseDate} />
                    </td>
                    <td>
                      <DateCell value={p.actualReleaseDate} />
                    </td>
                    <td className="num">
                      <Delta value={-p.slipDays} suffix="d" />
                    </td>
                    <td className="num">
                      {p.itemsCompleted}/{p.items}
                    </td>
                    <td className="num">
                      <Pct value={p.percent} />
                    </td>
                    <td className="space-x-1">
                      <Link href={`/deliverables?packageId=${p.id}`} className="link">
                        items
                      </Link>
                      <RescheduleButton
                        entityType="PACKAGE"
                        ids={[p.id]}
                        currentExpected={p.currentExpectedReleaseDate?.toISOString() ?? null}
                        projectId={id}
                        packageId={p.id}
                        label={`${p.packageCode} — ${p.packageName}`}
                        className="btn btn-sm"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      )}

      <Card
        title="Programme view"
        subtitle="Baseline vs current expected vs actual, with the links between packages and deliverables"
        className="mt-4"
      >
        <GanttChart data={gantt} maxRows={60} />
      </Card>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title="Reschedule history" subtitle="Every movement, with the reason recorded at the time" bodyClassName="">
          {d.reschedules.length === 0 ? (
            <Empty>Nothing has been rescheduled on this project yet.</Empty>
          ) : (
            <TableWrap maxHeight="300px">
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Item</th>
                    <th>Old</th>
                    <th>New</th>
                    <th className="num">Shift</th>
                    <th>Reason</th>
                    <th>User</th>
                  </tr>
                </thead>
                <tbody>
                  {d.reschedules.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <DateCell value={r.changedAt} muted />
                      </td>
                      <td className="max-w-[220px] truncate" title={r.entityLabel ?? ''}>
                        {r.entityLabel ?? `${r.entityType} ${r.entityId}`}
                      </td>
                      <td>
                        <DateCell value={r.oldDate} muted />
                      </td>
                      <td>
                        <DateCell value={r.newDate} />
                      </td>
                      <td className="num">
                        <Delta value={r.daysShift} suffix="d" />
                      </td>
                      <td className="max-w-[240px] text-ink-mute">{r.reason ?? '—'}</td>
                      <td className="text-ink-mute">{r.changedByLabel ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        <Card title="Critical requirements & notes" subtitle="Carried across from the goals workbook" bodyClassName="">
          {d.criticalRequirements.length === 0 ? (
            <Empty>No critical requirements recorded.</Empty>
          ) : (
            <TableWrap maxHeight="300px">
              <table className="table">
                <thead>
                  <tr>
                    <th className="w-32">Scope</th>
                    <th>Requirement</th>
                  </tr>
                </thead>
                <tbody>
                  {d.criticalRequirements.map((c) => (
                    <tr key={c.id}>
                      <td className="text-ink-mute">{c.phaseLabel ?? '—'}</td>
                      <td>{c.requirement}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      </div>

      <div className="mt-4">
        <Note>
          Drill-down links above filter the Goals, Design Delivery and Drawings registers by this project and
          discipline. Updates made there are reflected here immediately because both read the same rows — figures on
          this page are recalculated on every request, as at {formatDate(new Date())}.
        </Note>
      </div>
    </>
  );
}

function Line({ k, v }: { k: string; v: number }) {
  return (
    <div className="flex items-baseline justify-between">
      <dt className="text-ink-mute">{k}</dt>
      <dd className="font-mono font-semibold tabular-nums">{v.toLocaleString()}</dd>
    </div>
  );
}
