/**
 * Project Drawing Status, `drawing.read`.
 *
 * Every role: the tree — Project → Tower / Product → headings → Package →
 * Discipline → Drawings (components/status). Super Admin also has the tabs:
 *   summary  DFS Summary — packages and billing per project and discipline
 *   periods  Year / Quarter spread of package status and billing
 *   list     every drawing in one searchable list
 */
import clsx from 'clsx';
import Link from 'next/link';
import { headers } from 'next/headers';
import { StatusScreen } from '@/components/status/status-screen';
import { DrawingListView } from '@/components/dfs/drawing-list-view';
import { DfsPeriodsView } from '@/components/dfs/dfs-views';
import { DfsSummaryPanel } from '@/components/dfs/dfs-summary';
import { FilterBar, type FilterDef } from '@/components/filter-bar';
import { Kpi, Note, PageHeader } from '@/components/ui';
import { getCurrentUser } from '@/lib/auth';
import { formatNumber } from '@/lib/format';
import { DFS_LABEL, NAV_LABEL, STATUS_LABEL } from '@/lib/labels';
import { can } from '@/lib/rbac';
import { dfsPeriods, dfsSummary, parseDfsFilters } from '@/lib/services/dfs';
import { drawingKpis, drawingReference } from '@/lib/services/drawing-register';

export const dynamic = 'force-dynamic';

const VIEWS = [
  { key: 'tree', label: DFS_LABEL.tabTree },
  { key: 'summary', label: DFS_LABEL.tabSummary },
  { key: 'periods', label: DFS_LABEL.tabPeriods },
  { key: 'list', label: DFS_LABEL.tabList },
] as const;

export default async function DfsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const user = await getCurrentUser((await headers()) as unknown as Headers);
  if (!can(user.role, 'drawing.read')) return <Note tone="warn">Your role does not include Project Drawing Status.</Note>;
  const superAdmin = user.loginRole === 'SUPER_ADMIN';
  // The DFS Summary, Year / Quarter and Drawing list tabs are Super Admin screens.
  const view = !superAdmin ? 'tree' : sp.view === 'billing' ? 'summary' : (VIEWS.find((v) => v.key === sp.view)?.key ?? 'tree');
  const href = (extra: Record<string, string | null>) => {
    const next = new URLSearchParams(sp as Record<string, string>);
    next.delete('page');
    for (const [k, v] of Object.entries(extra)) {
      if (v == null) next.delete(k);
      else next.set(k, v);
    }
    return `?${next.toString()}`;
  };
  if (view === 'tree') return <StatusScreen sp={sp} user={user} mode="status" tabs={superAdmin ? <ViewTabs current="tree" href={href} /> : null} />;
  const filters = parseDfsFilters(sp);
  const [kpis, ref] = await Promise.all([view === 'list' ? drawingKpis(filters) : Promise.resolve(null), drawingReference(filters.projectId)]);

  const projectOpts = ref.projectOptions.map((p) => ({ value: p.value, label: p.label }));
  const disciplineOpts = ref.disciplines.filter((d) => ['AR', 'ST', 'MEP', 'LS'].includes(d.code)).map((d) => ({ value: d.id, label: d.name }));
  const defs: FilterDef[] =
    view === 'summary'
      ? [{ key: 'projectId', label: DFS_LABEL.colProject, type: 'select', options: projectOpts, width: '16rem' }]
      : [
          { key: 'projectId', label: DFS_LABEL.colProject, type: 'select', options: projectOpts, width: '15rem' },
          { key: 'disciplineId', label: DFS_LABEL.colDiscipline, type: 'select', options: disciplineOpts, width: '13rem' },
          {
            key: 'unitStatus',
            label: DFS_LABEL.colPackageStatus,
            type: 'select',
            options: [
              { value: 'COMPLETE', label: STATUS_LABEL.COMPLETE },
              { value: 'NOT_COMPLETE', label: STATUS_LABEL.PENDING },
              { value: 'NA', label: STATUS_LABEL.NA },
            ],
            width: '10rem',
          },
        ];

  return (
    <>
      <PageHeader
        title={DFS_LABEL.title}
        crumbs={[{ label: NAV_LABEL.dashboard, href: '/' }, { label: DFS_LABEL.title }]}
        actions={
          <Link href="/drawing-control" className="btn btn-primary">
            {DFS_LABEL.openDrawingControl}
          </Link>
        }
      />
      <ViewTabs current={view} href={href} />

      {view === 'list' ? (
        <>
          {kpis && (
            <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
              <Kpi label="Total drawings" value={formatNumber(kpis.total)} />
              <Kpi label={STATUS_LABEL.RELEASED} value={formatNumber(kpis.released)} tone="good" />
              <Kpi label={STATUS_LABEL.NOT_RELEASED} value={formatNumber(kpis.notReleased)} tone={kpis.notReleased ? 'warn' : 'default'} />
              <Kpi label="Due soon" value={formatNumber(kpis.dueSoon)} tone={kpis.dueSoon ? 'warn' : 'default'} />
              <Kpi label="Delayed" value={formatNumber(kpis.delayed)} tone={kpis.delayed ? 'bad' : 'good'} />
              <Kpi label="Released this week" value={formatNumber(kpis.releasedThisWeek)} hint="Drawings with a release date this week" />
              <Kpi label="Released this month" value={formatNumber(kpis.releasedThisMonth)} hint="Drawings with a release date this month" />
            </div>
          )}
          <DrawingListView sp={sp} />
        </>
      ) : (
        <>
          <FilterBar filters={defs} showSearch={false} searchPlaceholder={DFS_LABEL.searchPlaceholder} />
          {view === 'summary' && <SummaryView sp={sp} />}
          {view === 'periods' && <PeriodsView sp={sp} href={href} />}
        </>
      )}
    </>
  );
}

function ViewTabs({ current, href }: { current: string; href: (e: Record<string, string | null>) => string }) {
  return (
    <nav className="mb-3 flex flex-wrap gap-1 border-b border-line" aria-label="Project Drawing Status views">
      {VIEWS.map((v) => (
        <Link
          key={v.key}
          href={href({ view: v.key })}
          aria-current={v.key === current ? 'page' : undefined}
          className={clsx('-mb-px border-b-2 px-3 py-2 text-[12.5px]', v.key === current ? 'border-brand-600 font-semibold text-ink' : 'border-transparent text-ink-mute hover:text-ink')}
        >
          {v.label}
        </Link>
      ))}
    </nav>
  );
}

async function SummaryView({ sp }: { sp: Record<string, string> }) {
  const f = parseDfsFilters(sp);
  return <DfsSummaryPanel summary={await dfsSummary({ projectId: f.projectId })} />;
}

async function PeriodsView({ sp, href }: { sp: Record<string, string>; href: (e: Record<string, string | null>) => string }) {
  const basis = sp.basis === 'FY' ? 'FY' : 'CY';
  const data = await dfsPeriods(parseDfsFilters(sp), basis);
  return <DfsPeriodsView data={data} basisHref={(b) => href({ basis: b })} />;
}
