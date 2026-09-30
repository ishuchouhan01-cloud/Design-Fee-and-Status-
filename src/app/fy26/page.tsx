import Link from 'next/link';
import { NAV_LABEL } from '@/lib/labels';
import { headers } from 'next/headers';
import { FilterBar, type FilterDef } from '@/components/filter-bar';
import { Pagination } from '@/components/pagination';
import { Card, CompletionBadge, DateCell, Empty, Kpi, Note, PageHeader, TableWrap } from '@/components/ui';
import { getCurrentUser } from '@/lib/auth';
import { can } from '@/lib/rbac';
import {
  dependenciesFor,
  fy26Kpis,
  fy26Reference,
  fy26Tree,
  listFy26Packages,
  type Fy26DependencyRow,
  type Fy26PackageRow,
} from '@/lib/services/fy26';
import { fy26ListFiltersSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

function cr(v: number | null | undefined) {
  return v == null ? '—' : v.toFixed(4);
}

export default async function Fy26Page({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) if (v !== undefined && v !== '' && k !== 'view') raw[k] = v;
  const view = sp.view === 'table' ? 'table' : 'hierarchy';
  const filters = fy26ListFiltersSchema.parse(raw);
  // The hierarchy view keeps a project's packages together on one page.
  if (view === 'hierarchy' && !filters.sort) filters.sort = 'project';

  const [result, kpis, reference, tree, user] = await Promise.all([
    listFy26Packages(filters),
    fy26Kpis(filters),
    fy26Reference(),
    fy26Tree(),
    getCurrentUser((await headers()) as unknown as Headers),
  ]);

  const phaseOptions = reference.phases
    .filter((p) => !filters.projectId || p.projectId === filters.projectId)
    .map((p) => ({ value: p.id, label: p.name }));

  const defs: FilterDef[] = [
    {
      key: 'projectId',
      label: 'Project',
      type: 'select',
      options: reference.projects.map((p) => ({ value: p.id, label: p.name })),
      width: '13rem',
    },
    { key: 'phaseId', label: 'Phase', type: 'select', options: phaseOptions, width: '13rem' },
    {
      key: 'disciplineId',
      label: 'Discipline',
      type: 'select',
      options: reference.disciplines.map((d) => ({ value: d.id, label: d.name })),
      width: '10rem',
    },
    {
      key: 'responsibleId',
      label: 'Responsible',
      type: 'select',
      options: reference.responsibles.map((r) => ({ value: r.id, label: r.name })),
      width: '11rem',
    },
    {
      key: 'completionStatus',
      label: 'Status',
      type: 'select',
      options: [
        { value: 'COMPLETED', label: 'Completed' },
        { value: 'NOT_COMPLETED', label: 'Not completed' },
      ],
      width: '10rem',
    },
    {
      key: 'hasDependencies',
      label: 'Dependencies',
      type: 'select',
      options: [
        { value: 'YES', label: 'Has dependencies' },
        { value: 'NO', label: 'None' },
      ],
      width: '11rem',
    },
    { key: 'releaseFrom', label: 'Release from', type: 'text', width: '9rem' },
    { key: 'releaseTo', label: 'Release to', type: 'text', width: '9rem' },
  ];

  const pageCount = Math.max(1, Math.ceil(result.total / result.pageSize));
  const deps = view === 'hierarchy' ? await dependenciesFor(result.rows.map((r) => r.id)) : new Map();

  // Group the current page Project -> Phase for the hierarchy view.
  const grouped = new Map<string, { name: string; phases: Map<string, { name: string; rows: Fy26PackageRow[] }> }>();
  for (const r of result.rows) {
    const proj = grouped.get(r.projectId) ?? { name: r.projectName, phases: new Map() };
    const key = r.phaseId ?? '__none__';
    const ph = proj.phases.get(key) ?? { name: r.phaseName ?? 'No phase', rows: [] };
    ph.rows.push(r);
    proj.phases.set(key, ph);
    grouped.set(r.projectId, proj);
  }

  const viewHref = (v: 'table' | 'hierarchy') => {
    const q = new URLSearchParams(raw);
    if (v === 'table') q.set('view', 'table');
    return `/fy26${q.toString() ? `?${q.toString()}` : ''}`;
  };
  const byProject = new Map<string, { name: string; packages: number; completed: number; phases: string[] }>();
  for (const row of tree) {
    const entry = byProject.get(row.projectId) ?? {
      name: row.projectName,
      packages: 0,
      completed: 0,
      phases: [] as string[],
    };
    entry.packages += row.packages;
    entry.completed += row.completed;
    if (row.phaseName) entry.phases.push(row.phaseName);
    byProject.set(row.projectId, entry);
  }

  return (
    <>
      <PageHeader
        title={NAV_LABEL.fy26}
        description="Project → phase → package → dependency, from the Financial Year 2026–27 Quarter 3 workbooks. Percentages are counted from the records."
        crumbs={[{ label: NAV_LABEL.dashboard, href: '/' }, { label: NAV_LABEL.fy26 }]}
      />

      <p className="-mt-2 mb-3 text-[12px]">
        <Link className="link" href="/fy26/import">
          Import report
        </Link>{' '}
        — validation totals, and every row the import skipped, merged or protected.
      </p>

      <FilterBar filters={defs} />

      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-6">
        <Kpi label="Packages in view" value={kpis.packages.toLocaleString()} />
        <Kpi label="Completed" value={kpis.completed.toLocaleString()} tone="good" />
        <Kpi label="Completion" value={`${kpis.completionPercent}%`} />
        <Kpi label="Dependencies" value={kpis.dependencies.toLocaleString()} />
        <Kpi label="Plan billing [Cr.]" value={kpis.planBillingCr.toFixed(4)} />
        <Kpi label="Overdue" value={kpis.overdue.toLocaleString()} tone={kpis.overdue > 0 ? 'bad' : undefined} />
      </div>

      {kpis.noReleaseDate > 0 ? (
        <Note tone="warn">
          {kpis.noReleaseDate} package{kpis.noReleaseDate === 1 ? '' : 's'} in view have no release date in the source
          workbook. They were imported without one rather than given an invented date.
        </Note>
      ) : null}

      <Card title="Hierarchy" subtitle={`${byProject.size} projects · ${reference.phases.length} phases`}>
        <div className="flex flex-wrap gap-2">
          {[...byProject.entries()].map(([id, p]) => (
            <Link
              key={id}
              href={`/fy26?projectId=${id}`}
              className="rounded border border-slate-200 px-2.5 py-1.5 text-[12px] hover:border-brand-300 hover:bg-brand-50/50"
            >
              <span className="font-medium text-slate-800">{p.name}</span>
              <span className="ml-1.5 text-slate-500">
                {p.packages} pkg{p.phases.length ? ` · ${p.phases.length} phase${p.phases.length === 1 ? '' : 's'}` : ''}
              </span>
            </Link>
          ))}
        </div>
      </Card>

      <Card
        title="Packages"
        subtitle={`${result.total.toLocaleString()} matching · page ${result.page} of ${pageCount}`}
        actions={
          <div className="flex gap-1 text-[12px]">
            <Link
              href={viewHref('hierarchy')}
              className={view === 'hierarchy' ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
            >
              Hierarchy
            </Link>
            <Link href={viewHref('table')} className={view === 'table' ? 'btn btn-sm btn-primary' : 'btn btn-sm'}>
              Table
            </Link>
          </div>
        }
      >
        {result.rows.length === 0 ? (
          <Empty>No packages match these filters.</Empty>
        ) : view === 'hierarchy' ? (
          <div className="space-y-3">
            {[...grouped.entries()].map(([pid, proj]) => (
              <section key={pid}>
                <h3 className="mb-1 text-[13px] font-semibold text-slate-800">{proj.name}</h3>
                <div className="space-y-2 border-l-2 border-slate-200 pl-3">
                  {[...proj.phases.entries()].map(([phk, ph]) => (
                    <div key={phk}>
                      <p className="mb-1 text-[11.5px] font-medium uppercase tracking-wide text-slate-500">{ph.name}</p>
                      <ul className="space-y-1">
                        {ph.rows.map((r) => (
                          <PackageNode key={r.id} row={r} deps={deps.get(r.id) ?? []} />
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <TableWrap>
            <table className="table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Phase</th>
                  <th>Discipline</th>
                  <th>Package</th>
                  <th>Responsible</th>
                  <th>Original</th>
                  <th>Expected</th>
                  <th>Actual</th>
                  <th className="num">Plan [Cr.]</th>
                  <th className="num">Qty</th>
                  <th className="num">Deps</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap">{r.projectName}</td>
                    <td className="whitespace-nowrap text-slate-600">{r.phaseName ?? '—'}</td>
                    <td className="whitespace-nowrap text-slate-600">{r.disciplineName ?? '—'}</td>
                    <td>
                      <Link className="link" href={`/fy26/${r.id}`}>
                        {r.packageDescription}
                      </Link>
                      {r.sourceScopeLabel && r.sourceScopeLabel !== r.projectName ? (
                        <span className="ml-1.5 text-[11px] text-slate-400">{r.sourceScopeLabel}</span>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap text-slate-600">
                      {r.responsibleName ?? r.responsibleSourceText ?? '—'}
                    </td>
                    <td>
                      <DateCell value={r.baselineReleaseDate} muted />
                    </td>
                    <td>
                      <DateCell value={r.currentExpectedReleaseDate} />
                    </td>
                    <td>
                      <DateCell value={r.actualReleaseDate} muted />
                    </td>
                    <td className="num">{cr(r.planBillingCr)}</td>
                    <td className="num">{r.plannedPackageQuantity ?? '—'}</td>
                    <td className="num">{r.dependencyCount}</td>
                    <td>
                      <CompletionBadge status={r.completionStatus} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        <Pagination page={result.page} pageCount={pageCount} total={result.total} pageSize={result.pageSize} />
      </Card>

      {!can(user.role, 'fy26.write') ? (
        <Note>Your role can view this module but not change it. Editing needs the Editor role or above.</Note>
      ) : null}
    </>
  );
}

function isoDay(d: Date | null | undefined) {
  return d ? new Date(d).toISOString().slice(0, 10) : '—';
}

/** One package in the hierarchy view, expandable to show its dependencies. */
function PackageNode({ row, deps }: { row: Fy26PackageRow; deps: Fy26DependencyRow[] }) {
  return (
    <li className="rounded border border-slate-200">
      <details>
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 hover:bg-slate-50">
          <span className="text-[11px] text-slate-400">{deps.length ? '▸' : '·'}</span>
          <Link className="link text-[13px]" href={`/fy26/${row.id}`}>
            {row.packageDescription}
          </Link>
          <span className="text-[11.5px] text-slate-500">{row.disciplineName ?? '—'}</span>
          <span className="text-[11.5px] text-slate-500">
            {row.responsibleName ?? row.responsibleSourceText ?? '—'}
          </span>
          <span className="text-[11.5px] text-slate-600">expected {isoDay(row.currentExpectedReleaseDate)}</span>
          <span className="text-[11.5px] text-slate-600">
            {row.planBillingCr == null ? '—' : `${row.planBillingCr.toFixed(4)} Cr`}
          </span>
          <span className="text-[11.5px] text-slate-500">
            {deps.length} dependenc{deps.length === 1 ? 'y' : 'ies'}
          </span>
          <span className="ml-auto">
            <CompletionBadge status={row.completionStatus} />
          </span>
        </summary>
        <div className="border-t border-slate-100 px-3 py-2">
          {deps.length === 0 ? (
            <p className="text-[12px] text-slate-500">
              No dependencies.{' '}
              <Link className="link" href={`/fy26/${row.id}`}>
                Open the package
              </Link>{' '}
              to add one.
            </p>
          ) : (
            <ul className="space-y-1">
              {deps.map((d) => (
                <li key={d.id} className="flex flex-wrap items-baseline gap-x-2 text-[12.5px]">
                  <span className="w-14 shrink-0 text-[11px] text-slate-400">{d.stepLabel ?? 'no step'}</span>
                  <span className="text-slate-800">{d.description}</span>
                  <span className="text-[11.5px] text-slate-500">
                    {isoDay(d.targetDate)}
                    {d.responsibleText ? ` · ${d.responsibleText}` : ''}
                  </span>
                  {d.remarks ? <span className="text-[11.5px] text-amber-700">{d.remarks}</span> : null}
                  <span className="ml-auto">
                    <CompletionBadge status={d.completionStatus} />
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1.5 text-[11px] text-slate-400">
            {row.sourceWorkbook} › {row.sourceSheet} › row {row.sourceRow}
          </p>
        </div>
      </details>
    </li>
  );
}
