/**
 * Project Drawing Status (and Billing): the full-screen tree.
 *
 *   Name | Responsible Person | Package Status | Release Date | Packages Complete | Drawings Released | (Admin) Total · Billed · Unbilled
 *
 * The table fills the screen and scrolls inside itself. Viewer: read only, no
 * billing, no export. Admin and Super Admin: billing columns, export, and Edit
 * Mode (the same screen with editing switched on).
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { FilterBar, type FilterDef } from '@/components/filter-bar';
import { FullScreenButton } from '@/components/nav';
import { StatusTree } from '@/components/status/status-tree';
import { userCan, type SessionUser } from '@/lib/auth';
import { SCHEDULE_STATUSES, SCHEDULE_STATUS_LABEL } from '@/lib/domain';
import { DFS_LABEL, STATUS_LABEL } from '@/lib/labels';
import { buildDfsModel, forRole, modelBilling, modelTotals, parseDfsFilters, responsibleNames, rowsOf } from '@/lib/services/dfs';
import { drawingReference } from '@/lib/services/drawing-register';

/** The filter part of the address, for the table's own requests and exports. */
export function filterQuery(sp: Record<string, string>) {
  const q = new URLSearchParams();
  for (const k of ['search', 'projectId', 'disciplineId', 'unitStatus', 'release', 'scheduleStatus', 'responsible']) if (sp[k]) q.set(k, sp[k]);
  return q.toString();
}

export async function StatusScreen({ sp, user, mode, tabs }: { sp: Record<string, string>; user: SessionUser; mode: 'status' | 'billing'; tabs?: ReactNode }) {
  const billing = userCan(user, 'billing.read');
  const admin = user.loginRole !== 'VIEWER';
  const f = parseDfsFilters(sp);
  const [ref, names, model] = await Promise.all([drawingReference(f.projectId), responsibleNames(), buildDfsModel(f)]);
  const query = filterQuery(sp);
  const projectOpts = ref.projectOptions.map((p) => ({ value: p.value, label: p.label }));
  const disciplineOpts = ref.disciplines.filter((d) => ['AR', 'ST', 'MEP', 'LS'].includes(d.code)).map((d) => ({ value: d.id, label: d.name }));
  const defs: FilterDef[] = [
    { key: 'projectId', label: DFS_LABEL.colProject, type: 'select', options: projectOpts, width: '13rem' },
    { key: 'disciplineId', label: DFS_LABEL.colDiscipline, type: 'select', options: disciplineOpts, width: '10rem' },
    {
      key: 'unitStatus',
      label: DFS_LABEL.colPackageStatus,
      type: 'select',
      options: [
        { value: 'COMPLETE', label: STATUS_LABEL.COMPLETE },
        { value: 'NOT_COMPLETE', label: STATUS_LABEL.PENDING },
        { value: 'NA', label: STATUS_LABEL.NA },
      ],
      width: '8.5rem',
    },
    { key: 'release', label: 'Drawing Release', type: 'select', options: [{ value: 'COMPLETED', label: STATUS_LABEL.RELEASED }, { value: 'NOT_COMPLETED', label: STATUS_LABEL.NOT_RELEASED }], width: '8.5rem' },
    { key: 'scheduleStatus', label: 'Schedule Status', type: 'select', options: SCHEDULE_STATUSES.map((s) => ({ value: s, label: SCHEDULE_STATUS_LABEL[s] })), width: '9rem' },
    { key: 'responsible', label: DFS_LABEL.colResponsible, type: 'select', options: names.map((n) => ({ value: n, label: n })), width: '10rem' },
  ];
  const title = mode === 'billing' ? DFS_LABEL.billingTitle : DFS_LABEL.title;
  const totals = { ...modelTotals(model), billing: billing ? modelBilling(model) : null };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {/* The Viewer's top bar already carries the title. */}
        <h1 className={admin ? 'mr-auto text-[17px] font-semibold tracking-tight text-ink' : 'sr-only'}>{title}</h1>
        {!admin && <span className="mr-auto" />}
        {user.editMode && admin && (
          <span className="pill bg-emerald-50 text-emerald-800 ring-1 ring-emerald-300" role="status">
            {DFS_LABEL.editingEnabled}
          </span>
        )}
        {user.loginRole === 'SUPER_ADMIN' && (
          <Link href="/drawing-control" className="btn btn-sm">
            {DFS_LABEL.openDrawingControl}
          </Link>
        )}
        {admin && <FullScreenButton />}
      </div>
      {tabs}
      <FilterBar filters={defs} showSearch compact searchPlaceholder={DFS_LABEL.searchPlaceholder} />
      <div className="card flex min-h-0 flex-1 flex-col">
        {/* Keyed by the filters so a new selection starts from a fresh table. */}
        <StatusTree
          key={`${query}|${mode}|${user.editMode}`}
          initialRows={rowsOf(model, null).map((r) => forRole(r, billing))}
          totals={totals}
          query={query}
          billing={billing}
          billingView={mode === 'billing'}
          canExport={admin}
          editMode={admin && user.editMode}
          canAddTower={userCan(user, 'project.write')}
          canMarkNa={userCan(user, 'drawing.admin')}
        />
      </div>
    </div>
  );
}
