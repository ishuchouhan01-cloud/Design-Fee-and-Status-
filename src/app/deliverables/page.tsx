import Link from 'next/link';
import {
  Bar,
  Card,
  CompletionBadge,
  DateCell,
  Delta,
  Kpi,
  Note,
  PageHeader,
  ScheduleBadge,
  TableWrap,
} from '@/components/ui';
import { FilterBar, type FilterDef } from '@/components/filter-bar';
import { Pagination } from '@/components/pagination';
import { CompletionToggle } from '@/components/completion-toggle';
import { RescheduleButton } from '@/components/reschedule-dialog';
import { parseFilters } from '@/lib/services/filters';
import { allDeliverablesForMetrics, queryDeliverables } from '@/lib/services/queries';
import { listDisciplines, listDesignLeads, listPackages, listProjects } from '@/lib/services/reference';
import { planVsActual } from '@/lib/metrics';
import { SCHEDULE_STATUSES, SCHEDULE_STATUS_LABEL } from '@/lib/domain';
import { projectLabel, quarterLabel } from '@/lib/labels';

export const dynamic = 'force-dynamic';

export default async function DeliverablesPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const filters = parseFilters(sp);
  const [result, all, projects, disciplines, packages, owners] = await Promise.all([
    queryDeliverables(filters),
    allDeliverablesForMetrics(filters),
    listProjects(),
    listDisciplines(),
    listPackages(filters.projectId),
    listDesignLeads(),
  ]);

  const metrics = planVsActual(
    all.map((r) => ({
      id: r.id,
      completionStatus: r.completionStatus,
      baselineDate: r.baselineReleaseDate,
      expectedDate: r.currentExpectedReleaseDate,
      actualDate: r.actualReleaseDate,
      rescheduleCount: r.rescheduleCount,
    })),
  );

  const defs: FilterDef[] = [
    { key: 'projectId', label: 'Project', type: 'select', options: projects.map((p) => ({ value: p.id, label: projectLabel(p) })), width: '13rem' },
    { key: 'disciplineId', label: 'Discipline', type: 'select', options: disciplines.map((d) => ({ value: d.id, label: d.name })), width: '10rem' },
    { key: 'packageId', label: 'Package', type: 'select', options: packages.map((p) => ({ value: p.id, label: `${p.packageCode} — ${p.packageName}` })), width: '15rem' },
    { key: 'quarter', label: 'Quarter (expected)', type: 'select', options: [1, 2, 3, 4].map((q) => ({ value: String(q), label: quarterLabel(q) })), width: '9rem' },
    { key: 'ownerId', label: 'Owner', type: 'select', options: owners.map((o) => ({ value: o.id, label: o.name })), width: '11rem' },
    { key: 'completion', label: 'Completion', type: 'select', options: [{ value: 'COMPLETED', label: 'Completed' }, { value: 'NOT_COMPLETED', label: 'Not completed' }], width: '10rem' },
    { key: 'scheduleStatus', label: 'Schedule status', type: 'select', options: SCHEDULE_STATUSES.map((s) => ({ value: s, label: SCHEDULE_STATUS_LABEL[s] })), width: '11rem' },
    { key: 'rescheduled', label: 'Rescheduled', type: 'select', options: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }], width: '8rem' },
  ];

  return (
    <>
      <PageHeader
        title="Design delivery"
        description="Individual design deliverables. Completion is Complete or Pending — there is no percentage input on a record."
        crumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Design delivery' }]}
        actions={
          <Link href={`/update-centre?entity=DELIVERABLE&${new URLSearchParams(sp as Record<string, string>).toString()}`} className="btn btn-primary">
            Open in Update Centre
          </Link>
        }
      />

      <FilterBar filters={defs} exportKind="deliverables" />

      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-6">
        <Kpi label="Planned" value={metrics.plan.toLocaleString()} />
        <Kpi label="Completed" value={metrics.actual.toLocaleString()} tone="good" />
        <Kpi label="Not completed" value={metrics.remaining.toLocaleString()} />
        <Kpi label="Completion" value={metrics.completionPercent.toFixed(1)} suffix="%" />
        <Kpi label="Delayed releases" value={metrics.overdue} tone={metrics.overdue ? 'bad' : 'good'} />
        <Kpi label="Rescheduled releases" value={metrics.rescheduled} />
      </div>

      <div className="mb-3">
        <Bar value={metrics.actual} total={metrics.plan} />
      </div>

      <Card title={`${result.total.toLocaleString()} deliverables`} bodyClassName="">
        <TableWrap maxHeight="58vh">
          <table className="table">
            <thead>
              <tr>
                <th>Deliverable</th>
                <th>Project</th>
                <th>Package</th>
                <th>Discipline</th>
                <th>Owner</th>
                <th>Baseline release</th>
                <th>Current expected</th>
                <th>Actual release</th>
                <th>Completion</th>
                <th>Schedule</th>
                <th>Revision</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r) => (
                <tr key={r.id}>
                  <td className="max-w-[280px]">
                    <span className="block truncate font-medium" title={r.deliverableDescription} data-record>
                      {r.deliverableDescription}
                    </span>
                    <span className="sub font-mono">{r.deliverableCode}</span>
                  </td>
                  <td>
                    <Link href={`/projects/${r.projectId}`} className="link">
                      {projectLabel({ displayName: r.projectDisplayName, projectName: r.projectName })}
                    </Link>
                  </td>
                  <td className="max-w-[120px] truncate text-ink-mute" title={r.packageName ?? ''} data-record>
                    {r.packageCode ?? '—'}
                  </td>
                  <td className="text-ink-mute">{r.disciplineName ?? '—'}</td>
                  <td className="text-ink-mute">{r.ownerName ?? '—'}</td>
                  <td>
                    <DateCell value={r.baselineReleaseDate} muted />
                  </td>
                  <td>
                    <DateCell value={r.currentExpectedReleaseDate} />
                    {r.rescheduleCount > 0 && (
                      <div className="sub">
                        {r.rescheduleCount}× · <Delta value={r.schedule.slipDays} suffix="d" />
                      </div>
                    )}
                  </td>
                  <td>
                    <DateCell value={r.actualReleaseDate} />
                  </td>
                  <td>
                    <CompletionBadge status={r.completionStatus} />
                  </td>
                  <td>
                    <ScheduleBadge status={r.schedule.status} days={r.schedule.daysToDue} />
                  </td>
                  <td className="font-mono text-[11px]">{r.revision ?? '—'}</td>
                  <td className="whitespace-nowrap">
                    <div className="flex flex-wrap items-center gap-1">
                    <CompletionToggle
                      entityType="DELIVERABLE"
                      id={r.id}
                      status={r.completionStatus}
                      actualDate={r.actualReleaseDate?.toISOString() ?? null}
                    />
                      <RescheduleButton
                        entityType="DELIVERABLE"
                        ids={[r.id]}
                        currentExpected={r.currentExpectedReleaseDate.toISOString()}
                        projectId={r.projectId}
                        packageId={r.packageId}
                        disciplineId={r.disciplineId}
                        goalId={r.goalId}
                        label={`${r.deliverableCode} — ${r.deliverableDescription}`}
                      />
                      <Link href={`/audit?entityType=DELIVERABLE&entityId=${r.id}`} className="btn btn-sm">
                        History
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
              {result.rows.length === 0 && (
                <tr>
                  <td colSpan={12} className="py-6 text-center text-ink-mute">
                    No deliverables match the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableWrap>
        <Pagination page={result.page} pageCount={result.pageCount} total={result.total} pageSize={result.pageSize} />
      </Card>

      <div className="mt-4">
        <Note>
          Percentages on this page are aggregates over the filtered set: completed ÷ planned. No record stores a
          percentage, and none can be set through the API.
        </Note>
      </div>
    </>
  );
}
