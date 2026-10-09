import Link from 'next/link';
import { headers } from 'next/headers';
import { getCurrentUser, ROLE_LABEL, userCan } from '@/lib/auth';
import { Card, Kpi, Note, PageHeader } from '@/components/ui';
import { FilterBar, type FilterDef } from '@/components/filter-bar';
import { Pagination } from '@/components/pagination';
import { UpdateGrid, type UpdateRow } from '@/components/update-grid';
import { parseFilters } from '@/lib/services/filters';
import { queryDeliverables, queryDrawings } from '@/lib/services/queries';
import { listDisciplines, listDesignLeads, listPackages, listProjects } from '@/lib/services/reference';
import { SCHEDULE_STATUSES, SCHEDULE_STATUS_LABEL } from '@/lib/domain';

export const dynamic = 'force-dynamic';

export default async function UpdateCentrePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const sp = await searchParams;
  const entity = sp.entity === 'DRAWING' ? 'DRAWING' : 'DELIVERABLE';
  const user = await getCurrentUser((await headers()) as unknown as Headers);
  // Hide update controls the server would refuse anyway.
  const canBulk = userCan(user, 'bulk.update') && userCan(user, entity === 'DRAWING' ? 'drawing.write' : 'deliverable.write');
  const filters = parseFilters({ ...sp, pageSize: sp.pageSize ?? '100' });

  const [projects, disciplines, packages, owners] = await Promise.all([
    listProjects(),
    listDisciplines(),
    listPackages(filters.projectId),
    listDesignLeads(),
  ]);

  let rows: UpdateRow[] = [];
  let page = 1;
  let pageCount = 1;
  let total = 0;
  let pageSize = filters.pageSize ?? 100;

  if (entity === 'DELIVERABLE') {
    const res = await queryDeliverables(filters);
    rows = res.rows.map((r) => ({
      id: r.id,
      code: r.deliverableCode,
      description: r.deliverableDescription,
      projectName: r.projectName,
      packageCode: r.packageCode,
      disciplineName: r.disciplineName,
      baseline: r.baselineReleaseDate?.toISOString() ?? null,
      expected: r.currentExpectedReleaseDate?.toISOString() ?? null,
      actual: r.actualReleaseDate?.toISOString() ?? null,
      completionStatus: r.completionStatus,
      scheduleStatus: r.schedule.status,
      revision: r.revision,
      owner: r.ownerName,
      remarks: r.remarks,
    }));
    page = res.page;
    pageCount = res.pageCount;
    total = res.total;
    pageSize = res.pageSize;
  } else {
    const res = await queryDrawings(filters);
    rows = res.rows.map((r) => ({
      id: r.id,
      code: r.drawingCode,
      description: r.drawingName,
      projectName: r.projectName,
      packageCode: r.packageCode,
      disciplineName: r.disciplineName,
      baseline: r.baselineReleaseDate?.toISOString() ?? null,
      expected: r.currentExpectedReleaseDate?.toISOString() ?? null,
      actual: r.actualReleaseDate?.toISOString() ?? null,
      completionStatus: r.completionStatus,
      scheduleStatus: r.schedule.status,
      revision: r.revision,
      owner: null,
      remarks: r.remarks,
    }));
    page = res.page;
    pageCount = res.pageCount;
    total = res.total;
    pageSize = res.pageSize;
  }

  const completed = rows.filter((r) => r.completionStatus === 'COMPLETED').length;

  const defs: FilterDef[] = [
    { key: 'projectId', label: 'Project', type: 'select', options: projects.map((p) => ({ value: p.id, label: p.projectName })), width: '13rem' },
    { key: 'disciplineId', label: 'Discipline', type: 'select', options: disciplines.map((d) => ({ value: d.id, label: d.name })), width: '10rem' },
    { key: 'packageId', label: 'Package', type: 'select', options: packages.map((p) => ({ value: p.id, label: `${p.packageCode} — ${p.packageName}` })), width: '14rem' },
    { key: 'completion', label: 'Completion', type: 'select', options: [{ value: 'NOT_COMPLETED', label: 'Not completed' }, { value: 'COMPLETED', label: 'Completed' }], width: '10rem' },
    { key: 'scheduleStatus', label: 'Schedule status', type: 'select', options: SCHEDULE_STATUSES.map((s) => ({ value: s, label: SCHEDULE_STATUS_LABEL[s] })), width: '11rem' },
  ];

  return (
    <>
      <PageHeader
        title="Update Centre"
        description="One screen for normal operational updates. Select rows, choose an action, apply. Everything is validated before it is written and every change is audited."
        crumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Update Centre' }]}
        actions={
          <div className="flex gap-2">
            <Link
              href={`/update-centre?entity=DELIVERABLE${filters.projectId ? `&projectId=${filters.projectId}` : ''}`}
              className={`btn ${entity === 'DELIVERABLE' ? 'btn-primary' : ''}`}
            >
              Design deliverables
            </Link>
            <Link
              href={`/update-centre?entity=DRAWING${filters.projectId ? `&projectId=${filters.projectId}` : ''}`}
              className={`btn ${entity === 'DRAWING' ? 'btn-primary' : ''}`}
            >
              Drawings
            </Link>
          </div>
        }
      />

      <FilterBar filters={defs} exportKind={entity === 'DRAWING' ? 'drawings' : 'deliverables'} />

      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Records in view" value={total.toLocaleString()} />
        <Kpi label="On this page" value={rows.length} />
        <Kpi label="Completed on page" value={completed} tone="good" />
        <Kpi label="Open on page" value={rows.length - completed} />
      </div>

      {canBulk ? (
        <UpdateGrid entityType={entity} rows={rows} owners={owners.map((o) => ({ id: o.id, name: o.name }))} />
      ) : (
        <Note tone="warn">
          Your role ({ROLE_LABEL[user.role] ?? user.role}) can view records but not change them, so no update controls are shown.{' '}
          {entity === 'DRAWING' ? (
            <Link className="link" href="/drawings">
              View drawings in the Design Fee Schedule (DFS).
            </Link>
          ) : null}
        </Note>
      )}

      <Card className="mt-3" bodyClassName="">
        <Pagination page={page} pageCount={pageCount} total={total} pageSize={pageSize} />
      </Card>

      <div className="mt-4">
        <Note>
          Bulk actions available: mark completed, mark not completed, change expected date, change owner, add remark,
          change revision, and reschedule with an impact preview. Baseline dates are not offered here because they are
          immutable.
        </Note>
      </div>
    </>
  );
}
