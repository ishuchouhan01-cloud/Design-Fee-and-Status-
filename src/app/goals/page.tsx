import Link from 'next/link';
import {
  Card,
  CompletionBadge,
  DateCell,
  Delta,
  Kpi,
  Note,
  PageHeader,
  Pct,
  ScheduleBadge,
  TableWrap,
} from '@/components/ui';
import { FilterBar, type FilterDef } from '@/components/filter-bar';
import { Pagination } from '@/components/pagination';
import { RescheduleButton } from '@/components/reschedule-dialog';
import { GoalCreateForm } from '@/components/goal-create';
import { parseFilters } from '@/lib/services/filters';
import { queryGoals } from '@/lib/services/queries';
import { fiscalYears, listDisciplines, listDesignLeads, listProjects } from '@/lib/services/reference';
import { pct } from '@/lib/metrics';
import { PRIORITIES, SCHEDULE_STATUSES, SCHEDULE_STATUS_LABEL } from '@/lib/domain';
import { getCurrentUser } from '@/lib/auth';
import { can } from '@/lib/rbac';
import { headers } from 'next/headers';
import { PRIORITY_LABEL, projectLabel, quarterLabel, yearLabel } from '@/lib/labels';

export const dynamic = 'force-dynamic';

export default async function GoalsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const filters = parseFilters(sp);
  const [result, projects, disciplines, leads, years, user] = await Promise.all([
    queryGoals(filters),
    listProjects(),
    listDisciplines(),
    listDesignLeads(),
    fiscalYears(),
    getCurrentUser((await headers()) as unknown as Headers),
  ]);

  const plannedQty = result.rows.reduce((s, r) => s + r.plannedQuantity, 0);
  const deliveredQty = result.rows.reduce((s, r) => s + r.reportedActualQuantity, 0);
  const plannedValue = result.rows.reduce((s, r) => s + r.plannedValue, 0);

  const defs: FilterDef[] = [
    { key: 'projectId', label: 'Project', type: 'select', options: projects.map((p) => ({ value: p.id, label: projectLabel(p) })), width: '13rem' },
    { key: 'fiscalYear', label: 'Period', type: 'select', options: years.map((y) => ({ value: y, label: yearLabel(y) })), width: '13rem' },
    { key: 'quarter', label: 'Quarter', type: 'select', options: [1, 2, 3, 4].map((q) => ({ value: String(q), label: quarterLabel(q) })), width: '8rem' },
    { key: 'disciplineId', label: 'Discipline', type: 'select', options: disciplines.map((d) => ({ value: d.id, label: d.name })), width: '10rem' },
    { key: 'designLeadId', label: 'Design lead', type: 'select', options: leads.map((l) => ({ value: l.id, label: l.name })), width: '11rem' },
    { key: 'priority', label: 'Priority', type: 'select', options: PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] })), width: '8rem' },
    { key: 'completion', label: 'Completion', type: 'select', options: [{ value: 'COMPLETED', label: 'Completed' }, { value: 'NOT_COMPLETED', label: 'Not completed' }], width: '10rem' },
    { key: 'scheduleStatus', label: 'Schedule status', type: 'select', options: SCHEDULE_STATUSES.map((s) => ({ value: s, label: SCHEDULE_STATUS_LABEL[s] })), width: '11rem' },
    { key: 'rescheduled', label: 'Rescheduled', type: 'select', options: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }], width: '8rem' },
  ];

  return (
    <>
      <PageHeader
        title="Goals"
        description="A goal is a target quantity of packages plus a value and a timing. Delivery percentages are calculated from the quantities — they are never typed in."
        crumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Goals' }]}
      />

      <FilterBar filters={defs} exportKind="goals" />

      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Kpi label="Goals in view" value={result.total.toLocaleString()} />
        <Kpi label="Planned packages (page)" value={plannedQty} />
        <Kpi label="Delivered (page)" value={deliveredQty} tone="good" />
        <Kpi label="Delivery % (page)" value={pct(deliveredQty, plannedQty).toFixed(1)} suffix="%" />
        <Kpi label="Planned billing (page, ₹ Cr)" value={plannedValue.toFixed(1)} />
      </div>

      {can(user.role, 'goal.write') && (
        <div className="mb-3">
          <GoalCreateForm
            projects={projects.map((p) => ({ id: p.id, name: projectLabel(p) }))}
            disciplines={disciplines.map((d) => ({ id: d.id, name: d.name }))}
            leads={leads.map((l) => ({ id: l.id, name: l.name }))}
            years={years.length ? years : ['FY26-27']}
          />
        </div>
      )}

      <Card title={`${result.total.toLocaleString()} goals`} bodyClassName="">
        <TableWrap maxHeight="60vh">
          <table className="table">
            <thead>
              <tr>
                <th>Goal</th>
                <th>Project / phase</th>
                <th>Discipline</th>
                <th>Design lead</th>
                <th>Period</th>
                <th className="num">Plan</th>
                <th className="num">Delivered</th>
                <th className="num">%</th>
                <th className="num">Billing (₹ Cr)</th>
                <th>Baseline target</th>
                <th>Current expected</th>
                <th>Actual</th>
                <th>Completion</th>
                <th>Schedule</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((g) => (
                <tr key={g.id}>
                  <td className="max-w-[280px]">
                    <span className="block truncate font-medium" title={g.goalDescription} data-record>
                      {g.goalDescription}
                    </span>
                    <span className="sub font-mono">{g.goalCode}</span>
                    {g.isBaselineRevision && <span className="ml-1 pill bg-violet-50 text-violet-700">revised plan</span>}
                  </td>
                  <td>
                    <Link href={`/projects/${g.projectId}`} className="link">
                      {projectLabel({ displayName: g.projectDisplayName, projectName: g.projectName })}
                    </Link>
                    <div className="sub">{g.phaseCode ?? '—'}</div>
                  </td>
                  <td className="text-ink-mute">{g.disciplineName ?? '—'}</td>
                  <td className="text-ink-mute">{g.designLeadName ?? '—'}</td>
                  <td className="whitespace-nowrap">
                    {yearLabel(g.fiscalYear)}, {quarterLabel(g.quarter)}
                  </td>
                  <td className="num">{g.plannedQuantity}</td>
                  <td className="num">{g.reportedActualQuantity}</td>
                  <td className="num">
                    <Pct value={pct(g.reportedActualQuantity, g.plannedQuantity)} />
                  </td>
                  <td className="num">{g.plannedValue.toFixed(2)}</td>
                  <td>
                    <DateCell value={g.baselineTargetDate} muted />
                  </td>
                  <td>
                    <DateCell value={g.currentExpectedDate} />
                    {g.rescheduleCount > 0 && (
                      <div className="sub">
                        {g.rescheduleCount}× · <Delta value={g.schedule.slipDays} suffix="d" />
                      </div>
                    )}
                  </td>
                  <td>
                    <DateCell value={g.actualCompletionDate} />
                  </td>
                  <td>
                    <CompletionBadge status={g.completionStatus} />
                  </td>
                  <td>
                    <ScheduleBadge status={g.schedule.status} days={g.schedule.daysToDue} />
                  </td>
                  <td className="space-x-1 whitespace-nowrap">
                    <RescheduleButton
                      entityType="GOAL"
                      ids={[g.id]}
                      currentExpected={g.currentExpectedDate.toISOString()}
                      projectId={g.projectId}
                      disciplineId={g.disciplineId}
                      goalId={g.id}
                      label={`${g.goalCode} — ${g.goalDescription}`}
                    />
                    <Link href={`/audit?entityType=GOAL&entityId=${g.id}`} className="btn btn-sm">
                      History
                    </Link>
                  </td>
                </tr>
              ))}
              {result.rows.length === 0 && (
                <tr>
                  <td colSpan={15} className="py-6 text-center text-ink-mute">
                    No goals match the current filters.
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
          Rescheduling a goal records the original target alongside the new forecast, so the commitment the business
          made stays visible. It never overwrites the baseline target date.
        </Note>
      </div>
    </>
  );
}
