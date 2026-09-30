import Link from 'next/link';
import { Card, DateCell, Delta, Empty, Kpi, Note, PageHeader, TableWrap } from '@/components/ui';
import { GanttChart } from '@/components/gantt';
import { RescheduleButton } from '@/components/reschedule-dialog';
import { DependencyEditor } from '@/components/dependency-editor';
import { buildGantt } from '@/lib/services/gantt';
import { listProjects } from '@/lib/services/reference';
import { db } from '@/db';
import { rescheduleHistory } from '@/db/schema';
import { desc, eq } from 'drizzle-orm';
import { DEPENDENCY_TYPE_LABEL } from '@/lib/domain';
import { ProjectPicker } from '@/components/project-picker';

export const dynamic = 'force-dynamic';

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string; include?: string }>;
}) {
  const sp = await searchParams;
  const projects = await listProjects();
  const projectId = sp.projectId ?? projects.find((p) => p.projectCode === 'VIOLET-HILL')?.id ?? projects[0]?.id;
  if (!projectId) {
    return (
      <>
        <PageHeader title="Schedule / Reschedule" />
        <Empty>No projects in the database yet. Run the Excel migration first.</Empty>
      </>
    );
  }
  const project = projects.find((p) => p.id === projectId)!;
  const include = (sp.include ?? 'PACKAGE,DELIVERABLE').split(',') as ('PACKAGE' | 'DELIVERABLE' | 'DRAWING')[];
  const gantt = await buildGantt({ projectId, include, limit: 400 });
  const history = await db
    .select()
    .from(rescheduleHistory)
    .where(eq(rescheduleHistory.projectId, projectId))
    .orderBy(desc(rescheduleHistory.changedAt))
    .limit(100);

  const delayed = gantt.bars.filter((b) => b.scheduleStatus === 'DELAYED').length;
  const moved = gantt.bars.filter((b) => b.rescheduleCount > 0).length;

  return (
    <>
      <PageHeader
        title="Schedule / Reschedule"
        description="Asta-inspired rescheduling: baseline preserved, current expected date moved, dependent work recalculated, impact previewed before anything is committed."
        crumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Schedule' }]}
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <ProjectPicker projects={projects.map((p) => ({ id: p.id, name: p.projectName }))} current={projectId} include={sp.include} />
            <Link href={`/projects/${projectId}`} className="btn">
              Project dashboard
            </Link>
            <RescheduleButton
              entityType="DELIVERABLE"
              ids={[]}
              projectId={projectId}
              label={`${project.projectName} — every incomplete deliverable`}
              buttonLabel="Reschedule project"
              className="btn btn-primary"
            />
          </div>
        }
      />

      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Kpi label="Programme rows" value={gantt.bars.length} />
        <Kpi label="Links" value={gantt.links.length} />
        <Kpi label="Delayed" value={delayed} tone={delayed ? 'bad' : 'good'} />
        <Kpi label="Rescheduled" value={moved} />
        <Kpi label="History entries" value={history.length} />
      </div>

      <Card
        title={`Programme — ${project.projectName}`}
        subtitle="Hollow bar = baseline · solid = current expected · dark tick = actual release"
      >
        <GanttChart data={gantt} maxRows={120} />
      </Card>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title="Dependencies" subtitle="Finish-to-Start, Start-to-Start and Finish-to-Finish with positive or negative lag" bodyClassName="">
          {gantt.links.length === 0 ? (
            <Empty>No links on this project yet. Add one below.</Empty>
          ) : (
            <TableWrap maxHeight="260px">
              <table className="table">
                <thead>
                  <tr>
                    <th>Predecessor</th>
                    <th>Type</th>
                    <th className="num">Lag</th>
                    <th>Successor</th>
                  </tr>
                </thead>
                <tbody>
                  {gantt.links.slice(0, 200).map((l, i) => {
                    const pre = gantt.bars.find((b) => b.entityId === l.predecessorId);
                    const suc = gantt.bars.find((b) => b.entityId === l.successorId);
                    return (
                      <tr key={`${l.predecessorId}-${l.successorId}-${i}`}>
                        <td className="max-w-[220px] truncate">{pre ? `${pre.code} — ${pre.label}` : l.predecessorId}</td>
                        <td>{DEPENDENCY_TYPE_LABEL[l.dependencyType as 'FS'] ?? l.dependencyType}</td>
                        <td className="num">{l.lagDays}d</td>
                        <td className="max-w-[220px] truncate">{suc ? `${suc.code} — ${suc.label}` : l.successorId}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
          )}
          <div className="border-t border-line p-4">
            <DependencyEditor
              options={gantt.bars.slice(0, 300).map((b) => ({
                value: `${b.entityType}:${b.entityId}`,
                label: `${b.entityType[0]} ${b.code} — ${b.label}`,
              }))}
            />
          </div>
        </Card>

        <Card title="Reschedule history" subtitle="Date · item · old · new · shift · reason · user" bodyClassName="">
          {history.length === 0 ? (
            <Empty>Nothing rescheduled on this project yet.</Empty>
          ) : (
            <TableWrap maxHeight="320px">
              <table className="table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Item</th>
                    <th>Old</th>
                    <th>New</th>
                    <th className="num">Shift</th>
                    <th>Scope</th>
                    <th>Reason</th>
                    <th>User</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td>
                        <DateCell value={h.changedAt} muted />
                      </td>
                      <td className="max-w-[200px] truncate" title={h.entityLabel ?? ''}>
                        {h.entityLabel ?? h.entityId}
                      </td>
                      <td>
                        <DateCell value={h.oldDate} muted />
                      </td>
                      <td>
                        <DateCell value={h.newDate} />
                      </td>
                      <td className="num">
                        <Delta value={h.daysShift} suffix="d" />
                      </td>
                      <td className="text-ink-mute">{h.scope}</td>
                      <td className="max-w-[220px] text-ink-mute">{h.reason ?? '—'}</td>
                      <td className="text-ink-mute">{h.changedByLabel ?? '—'}</td>
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
          Completed work is never moved automatically: a reschedule skips anything already released and says so in the
          impact preview. Dependent items only move when the link is actually violated, so pulling a predecessor earlier
          does not drag its successors backwards.
        </Note>
      </div>
    </>
  );
}
