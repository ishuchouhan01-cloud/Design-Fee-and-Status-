/**
 * Project Drawing Status (and Billing): the full-screen tree.
 *
 *   Name | Responsible Person | Package Status | Release Date | Packages Complete | Drawings Released | (Admin) Total · Billed · Unbilled
 *
 * The table fills the screen and scrolls inside itself. Viewer: read only, no
 * billing, no export. Admin and Super Admin: billing columns, export, and Edit
 * Mode (the same screen with editing switched on). Rows with no drawings are
 * not shown; Edit Mode can show them ("Show empty rows"). The Billing view
 * lists the billed lines left out because none of their drawings is released.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { FilterBar, type FilterDef } from '@/components/filter-bar';
import { FullScreenButton } from '@/components/nav';
import { StatusTree } from '@/components/status/status-tree';
import { userCan, type SessionUser } from '@/lib/auth';
import { SCHEDULE_STATUSES, SCHEDULE_STATUS_LABEL } from '@/lib/domain';
import { formatCrore } from '@/lib/format';
import { DFS_LABEL, STATUS_LABEL } from '@/lib/labels';
import { buildDfsModel, forRole, modelBilling, modelTotals, parseDfsFilters, responsibleNames, rowsOf } from '@/lib/services/dfs';
import { drawingReference, projectOptions } from '@/lib/services/drawing-register';

/** The filter part of the address, for the table's own requests and exports. */
export function filterQuery(sp: Record<string, string>) {
  const q = new URLSearchParams();
  for (const k of ['search', 'projectId', 'disciplineId', 'unitStatus', 'release', 'scheduleStatus', 'responsible', 'showEmpty']) if (sp[k]) q.set(k, sp[k]);
  return q.toString();
}

export async function StatusScreen({ sp, user, mode, tabs }: { sp: Record<string, string>; user: SessionUser; mode: 'status' | 'billing'; tabs?: ReactNode }) {
  const billing = userCan(user, 'billing.read');
  const admin = user.loginRole !== 'VIEWER';
  const editing = admin && user.editMode;
  // "Show empty rows" belongs to Edit Mode only.
  const query = filterQuery(editing ? sp : { ...sp, showEmpty: '' });
  const f = parseDfsFilters(editing ? sp : { ...sp, showEmpty: undefined });
  const [ref, names, model, options] = await Promise.all([drawingReference(f.projectId), responsibleNames(), buildDfsModel(f), projectOptions({ drawingsOnly: true })]);
  const projectOpts = options.map((p) => ({ value: p.value, label: p.label }));
  // Only discipline groups that hold drawings are offered.
  const groupsWithDrawings = new Set(model.units.filter((u) => u.all.drawings > 0).map((u) => u.group));
  const disciplineOpts = ref.disciplines.filter((d) => ['AR', 'ST', 'MEP', 'LS'].includes(d.code) && (groupsWithDrawings.has(d.code) || d.id === f.disciplineId)).map((d) => ({ value: d.id, label: d.name }));
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
  const money = (v: number) => formatCrore(v, { symbol: false });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {/* The Viewer's top bar already carries the title. */}
        <h1 className={admin ? 'mr-auto text-[17px] font-semibold tracking-tight text-ink' : 'sr-only'}>{title}</h1>
        {!admin && <span className="mr-auto" />}
        {editing && (
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
          editMode={editing}
          showEmpty={editing && Boolean(f.showEmpty)}
          storageKey={`pds.expand.${user.id}`}
          canAddTower={userCan(user, 'project.write')}
          canMarkNa={userCan(user, 'drawing.admin')}
        />
      </div>
      {mode === 'billing' && billing && (
        <section className="card mt-2 max-h-[38vh] overflow-auto" aria-labelledby="billing-review" data-billing-review="">
          <div className="flex flex-wrap items-baseline gap-2 border-b border-line px-3 py-2">
            <h2 id="billing-review" className="text-[13px] font-semibold text-ink">
              {DFS_LABEL.billingToReview} ({model.review.length})
            </h2>
            <p className="text-[12px] text-ink-soft">
              Fee lines with a Billed amount in the source but no drawing released. They are left out of every total (shown as “—”); the source values are kept.
            </p>
            <p className="ml-auto text-[12px] tabular-nums text-ink-soft" data-reconciliation="">
              Source ₹ {money(model.source.total)} Cr = shown ₹ {money(totals.billing?.total ?? 0)} Cr + left out ₹ {money(model.excluded.noRelease.total + model.excluded.notApplicable.total)} Cr · Billed: source ₹ {money(model.source.billed)} Cr = shown ₹{' '}
              {money(totals.billing?.billed ?? 0)} Cr + left out ₹ {money(model.excluded.noRelease.billed + model.excluded.notApplicable.billed)} Cr
            </p>
          </div>
          {model.review.length === 0 ? (
            <p className="px-3 py-3 text-[12px] text-ink-mute">{DFS_LABEL.reviewEmpty}</p>
          ) : (
            <table className="w-full table-fixed border-separate border-spacing-0 text-[12.5px]">
              <colgroup>
                <col style={{ width: '16rem' }} />
                <col />
                <col style={{ width: '13rem' }} />
                <col style={{ width: '7.5rem' }} />
                <col style={{ width: '7.5rem' }} />
                <col style={{ width: '12rem' }} />
              </colgroup>
              <thead className="sticky top-0 bg-surface-sunk text-left text-2xs uppercase tracking-wide text-ink-mute">
                <tr>
                  <th className="border-b border-line px-2.5 py-1.5 font-semibold">{DFS_LABEL.colProject}</th>
                  <th className="border-b border-line px-2.5 py-1.5 font-semibold">{DFS_LABEL.colPackage}</th>
                  <th className="border-b border-line px-2.5 py-1.5 font-semibold">{DFS_LABEL.colDiscipline}</th>
                  <th className="border-b border-line px-2.5 py-1.5 text-right font-semibold">{DFS_LABEL.colTotal}</th>
                  <th className="border-b border-line px-2.5 py-1.5 text-right font-semibold">{DFS_LABEL.colBilled}</th>
                  <th className="border-b border-line px-2.5 py-1.5 font-semibold">{DFS_LABEL.reviewReason}</th>
                </tr>
              </thead>
              <tbody>
                {model.review.map((x) => (
                  <tr key={`${x.packageId}|${x.discipline}`} data-review-row="">
                    <td className="border-b border-line/70 px-2.5 py-1">{x.project}</td>
                    <td className="border-b border-line/70 px-2.5 py-1">
                      {x.packageName} <span className="text-2xs tabular-nums text-ink-mute">{x.packageCode}</span>
                    </td>
                    <td className="border-b border-line/70 px-2.5 py-1">{x.disciplineName}</td>
                    <td className="border-b border-line/70 px-2.5 py-1 text-right tabular-nums">{money(x.total)}</td>
                    <td className="border-b border-line/70 px-2.5 py-1 text-right tabular-nums">
                      <span className="text-rag-red" aria-hidden="true">
                        ⚠{' '}
                      </span>
                      {money(x.billed)}
                    </td>
                    <td className="border-b border-line/70 px-2.5 py-1">{x.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
