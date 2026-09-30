/**
 * DRAWING CONTROL — controlled, operational editing. Requires `drawing.write`.
 *
 *   drawing.write       + Add Drawing, Edit, Add Revision, Add Dependency
 *   drawing.complete    Mark as Released
 *   drawing.reschedule  Reschedule (through the reschedule engine)
 *   drawing.admin       Import, conflicts, phase map, delete where permitted
 *
 * Each control is rendered only for the permission it needs; every API route
 * checks the same permission again.
 */
import clsx from 'clsx';
import Link from 'next/link';
import { projectLabel } from '@/lib/labels';
import { headers } from 'next/headers';
import {
  AddDrawingButton,
  AddRevisionButton,
  ConflictActions,
  DrawingImportPanel,
  EditDrawingButton,
  ReleaseButton,
} from '@/components/drawing-actions';
import { FilterBar, type FilterDef } from '@/components/filter-bar';
import { Pagination } from '@/components/pagination';
import { RescheduleButton } from '@/components/reschedule-dialog';
import { ActualRelease, Card, DateCell, DrawingNumber, Kpi, Note, PageHeader, ReleaseBadge, ScheduleBadge, TableWrap } from '@/components/ui';
import { getCurrentUser, ROLE_LABEL } from '@/lib/auth';
import { listPackages } from '@/lib/services/reference';
import { SCHEDULE_STATUSES, SCHEDULE_STATUS_LABEL } from '@/lib/domain';
import { can } from '@/lib/rbac';
import {
  activeUsers,
  drawingKpis,
  drawingLookAhead,
  drawingReference,
  listConflicts,
  listDrawings,
  listImportBatches,
  listPhaseMap,
  parseDrawingFilters,
  type LookAheadBucket,
} from '@/lib/services/drawing-register';

export const dynamic = 'force-dynamic';

const TABS = [
  { key: 'drawings', label: 'Drawings', perm: 'drawing.write' },
  { key: 'look-ahead', label: 'Two-week look-ahead', perm: 'drawing.write' },
  { key: 'conflicts', label: 'Import conflicts', perm: 'drawing.admin' },
  { key: 'import', label: 'Import', perm: 'drawing.admin' },
  { key: 'phase-map', label: 'Location → phase map', perm: 'drawing.admin' },
] as const;

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

export default async function DrawingControlPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const user = await getCurrentUser((await headers()) as unknown as Headers);
  if (!can(user.role, 'drawing.write')) {
    return (
      <>
        <PageHeader title="Drawing Control" crumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Drawing Control' }]} />
        <Note tone="warn">
          Drawing Control is for users who can edit drawings. Your role ({ROLE_LABEL[user.role] ?? user.role}) can view drawings but not change them — use the{' '}
          <Link className="link" href="/drawings">
            Design Fee Schedule (DFS)
          </Link>
          .
        </Note>
      </>
    );
  }
  const perms = {
    write: can(user.role, 'drawing.write'),
    complete: can(user.role, 'drawing.complete'),
    reschedule: can(user.role, 'drawing.reschedule'),
    admin: can(user.role, 'drawing.admin'),
  };
  const tabs = TABS.filter((t) => can(user.role, t.perm));
  const tab = tabs.find((t) => t.key === sp.tab)?.key ?? 'drawings';
  const filters = parseDrawingFilters(sp);
  const [ref, people, kpis] = await Promise.all([drawingReference(filters.projectId), activeUsers(), drawingKpis(filters)]);
  const phaseOpts = ref.phases.map((p) => ({ value: p.id, label: p.code, projectId: p.projectId }));
  const discOpts = ref.disciplines.map((x) => ({ value: x.id, label: x.name }));
  const userOpts = people.map((u) => ({ value: u.id, label: u.name }));
  const packageOpts = (await listPackages(filters.projectId)).map((p) => ({ value: p.id, label: `${p.packageCode} — ${p.packageName}`, projectId: p.projectId }));
  const allPhases = filters.projectId ? phaseOpts : (await drawingReference()).phases.map((p) => ({ value: p.id, label: p.code, projectId: p.projectId }));

  const tabHref = (key: string) => {
    const next = new URLSearchParams(sp as Record<string, string>);
    next.set('tab', key);
    next.delete('page');
    return `?${next.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="Drawing Control"
        description="Add and edit drawings, mark them released, add revisions and dependencies, and reschedule. Every change is audited; expected-date moves go through the reschedule engine."
        crumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Drawing Control' }]}
        actions={
          <div className="flex gap-2">
            <Link href="/drawings" className="btn">
              DFS
            </Link>
            {perms.write && (
              <AddDrawingButton
                projects={ref.projectOptions.filter((p) => p.leaf).map((p) => ({ value: p.value, label: p.path }))}
                phases={allPhases}
                disciplines={discOpts}
                users={userOpts}
                defaultProjectId={filters.projectId}
              />
            )}
          </div>
        }
      />

      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <Kpi label="Total drawings" value={kpis.total.toLocaleString()} />
        <Kpi label="Released" value={kpis.released.toLocaleString()} tone="good" />
        <Kpi label="Not released" value={kpis.notReleased.toLocaleString()} tone={kpis.notReleased ? 'warn' : 'default'} />
        <Kpi label="Due soon" value={kpis.dueSoon.toLocaleString()} tone={kpis.dueSoon ? 'warn' : 'default'} />
        <Kpi label="Delayed" value={kpis.delayed.toLocaleString()} tone={kpis.delayed ? 'bad' : 'good'} />
        <Kpi label="Released this week" value={kpis.releasedThisWeek.toLocaleString()} hint="Actual dates only" />
        <Kpi label="Released this month" value={kpis.releasedThisMonth.toLocaleString()} hint="Actual dates only" />
      </div>

      <nav className="mb-3 flex flex-wrap gap-1 border-b border-line">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={tabHref(t.key)}
            className={clsx(
              '-mb-px border-b-2 px-3 py-2 text-[12.5px]',
              t.key === tab ? 'border-brand-600 font-semibold text-ink' : 'border-transparent text-ink-mute hover:text-ink',
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === 'drawings' && <DrawingsTab sp={sp} perms={perms} ref_={ref} phases={phaseOpts} packageOpts={packageOpts} disciplines={discOpts} users={userOpts} />}
      {tab === 'look-ahead' && <LookAheadTab sp={sp} perms={perms} />}
      {tab === 'conflicts' && perms.admin && <ConflictsTab status={sp.status} />}
      {tab === 'import' && perms.admin && <ImportTab />}
      {tab === 'phase-map' && perms.admin && <PhaseMapTab projectId={filters.projectId} />}
    </>
  );
}

type Perms = { write: boolean; complete: boolean; reschedule: boolean; admin: boolean };
type Opt = { value: string; label: string };

async function DrawingsTab({
  sp,
  perms,
  ref_,
  phases,
  packageOpts,
  disciplines,
  users,
}: {
  sp: Record<string, string>;
  perms: Perms;
  ref_: Awaited<ReturnType<typeof drawingReference>>;
  phases: (Opt & { projectId: string })[];
  packageOpts: (Opt & { projectId: string })[];
  disciplines: Opt[];
  users: Opt[];
}) {
  const filters = parseDrawingFilters(sp);
  const result = await listDrawings(filters);
  const defs: FilterDef[] = [
    { key: 'projectId', label: 'Project', type: 'select', options: ref_.projectOptions.map((p) => ({ value: p.value, label: p.label })), width: '14rem' },
    { key: 'phaseId', label: 'Phase', type: 'select', options: [{ value: 'NONE', label: '(no phase)' }, ...ref_.phases.map((p) => ({ value: p.id, label: p.code }))], width: '9rem' },
    { key: 'disciplineId', label: 'Discipline', type: 'select', options: ref_.disciplines.map((d) => ({ value: d.id, label: d.name })), width: '8rem' },
    ...(ref_.batches.length
      ? [{ key: 'batchCode', label: 'Batch', type: 'select' as const, options: ref_.batches.map((b) => ({ value: b, label: b })), width: '9rem' }]
      : [{ key: 'batchCode', label: 'Batch code', type: 'text' as const, width: '8rem' }]),
    { key: 'release', label: 'Release status', type: 'select', options: [{ value: 'COMPLETED', label: 'RELEASED' }, { value: 'NOT_COMPLETED', label: 'NOT RELEASED' }], width: '9rem' },
    { key: 'scheduleStatus', label: 'Schedule status', type: 'select', options: SCHEDULE_STATUSES.map((s) => ({ value: s, label: SCHEDULE_STATUS_LABEL[s] })), width: '10rem' },
    { key: 'responsibleId', label: 'Responsible', type: 'select', options: [{ value: 'NONE', label: '(not assigned)' }, ...ref_.responsibles.map((u) => ({ value: u.id, label: u.name }))], width: '10rem' },
    { key: 'numberStatus', label: 'Number', type: 'select', options: [{ value: 'NUMBERED', label: 'Numbered' }, { value: 'NOT_YET_NUMBERED', label: 'Not yet numbered' }], width: '9rem' },
  ];
  return (
    <>
      <FilterBar filters={defs} exportKind="drawings" />
      <Card title={`${result.total.toLocaleString()} drawings`} bodyClassName="">
        <TableWrap maxHeight="62vh">
          <table className="table">
            <thead>
              <tr>
                <th>Drawing number</th>
                <th>Title</th>
                <th>Project / phase</th>
                <th>Discipline</th>
                <th>Batch</th>
                <th>Revision</th>
                <th>Release status</th>
                <th>Expected</th>
                <th>Actual</th>
                <th>Schedule</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r) => {
                const label = `${r.numberStatus === 'NOT_YET_NUMBERED' ? 'Not yet numbered' : r.drawingCode} — ${r.drawingName}`;
                const released = r.completionStatus === 'COMPLETED';
                return (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/drawing-control/${r.id}`} className="link">
                        <DrawingNumber code={r.drawingCode} numberStatus={r.numberStatus} partialNumber={r.partialNumber} />
                      </Link>
                    </td>
                    <td className="max-w-[260px]">
                      <span className="block truncate" title={r.drawingName}>
                        {r.drawingName}
                      </span>
                      {r.location && <span className="sub">{r.location}</span>}
                    </td>
                    <td className="whitespace-nowrap text-ink-mute">
                      {projectLabel({ displayName: r.projectDisplayName, projectName: r.projectName })}
                      {r.phaseCode && <span className="sub block">{r.phaseCode}</span>}
                    </td>
                    <td className="text-ink-mute">{r.disciplineName ?? '—'}</td>
                    <td className="whitespace-nowrap text-ink-mute">{r.batchCode ?? '—'}</td>
                    <td className="font-mono text-[11px]">{r.revision ?? '—'}</td>
                    <td>
                      <ReleaseBadge status={r.completionStatus} />
                    </td>
                    <td>
                      <DateCell value={r.currentExpectedReleaseDate} />
                    </td>
                    <td>
                      <ActualRelease status={r.completionStatus} value={r.actualReleaseDate} evidence={r.releaseEvidence} />
                    </td>
                    <td>{r.schedule ? <ScheduleBadge status={r.schedule.status} days={r.schedule.daysToDue} /> : '—'}</td>
                    <td className="whitespace-nowrap">
                      <div className="flex flex-wrap items-center gap-1">
                        {perms.write && (
                          <EditDrawingButton
                            drawing={{
                              id: r.id,
                              label,
                              projectId: r.projectId,
                              numberStatus: r.numberStatus,
                              drawingCode: r.drawingCode,
                              drawingName: r.drawingName,
                              phaseId: r.phaseId,
                              packageId: r.packageId,
                              disciplineId: r.disciplineId,
                              location: r.location,
                              areaOfWorks: r.areaOfWorks,
                              batchCode: r.batchCode,
                              batch: r.batch,
                              responsibleUserId: r.responsibleUserId,
                              responsibleText: r.responsibleText,
                              remarks: r.remarks,
                            }}
                            phases={phases.length ? phases : []}
                            packages={packageOpts}
                            disciplines={disciplines}
                            users={users}
                          />
                        )}
                        {perms.complete && !released && (
                          <ReleaseButton id={r.id} label={label} revision={r.revision} released={false} revisionReleased={false} />
                        )}
                        {perms.write && <AddRevisionButton id={r.id} label={label} current={r.revision} />}
                        {perms.reschedule && !released && (
                          <RescheduleButton
                            entityType="DRAWING"
                            ids={[r.id]}
                            currentExpected={iso(r.currentExpectedReleaseDate)}
                            projectId={r.projectId}
                            packageId={r.packageId}
                            disciplineId={r.disciplineId}
                            label={label}
                          />
                        )}
                        <Link href={`/drawing-control/${r.id}#history`} className="btn btn-sm">
                          View History
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {result.rows.length === 0 && (
                <tr>
                  <td colSpan={11} className="py-6 text-center text-ink-mute">
                    No drawings match the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableWrap>
        <Pagination page={result.page} pageCount={result.pageCount} total={result.total} pageSize={result.pageSize} />
      </Card>
      {!phases.length && perms.write && (
        <p className="mt-2 text-2xs text-ink-mute">Pick a project in the filter to change a drawing&rsquo;s phase from this list; it can always be changed on the drawing&rsquo;s page.</p>
      )}
    </>
  );
}

const BUCKETS: { key: LookAheadBucket; label: string; tone: string }[] = [
  { key: 'OVERDUE', label: 'Overdue', tone: 'text-rag-red' },
  { key: 'THIS_WEEK', label: 'This week', tone: 'text-rag-amber' },
  { key: 'NEXT_WEEK', label: 'Next week', tone: 'text-ink' },
];

async function LookAheadTab({ sp, perms }: { sp: Record<string, string>; perms: Perms }) {
  const filters = parseDrawingFilters(sp);
  const la = await drawingLookAhead(filters);
  return (
    <div className="space-y-4">
      <Note>
        NOT RELEASED drawings only, by current expected release date. Weeks run Monday to Sunday. Released drawings are never in the look-ahead.
      </Note>
      {BUCKETS.map((b) => (
        <Card key={b.key} title={<span className={b.tone}>{`${b.label} — ${la.counts[b.key].toLocaleString()}`}</span>} bodyClassName="">
          <TableWrap maxHeight="40vh">
            <table className="table">
              <thead>
                <tr>
                  <th>Drawing number</th>
                  <th>Title</th>
                  <th>Project / phase</th>
                  <th>Discipline</th>
                  <th>Batch</th>
                  <th>Expected</th>
                  <th>Responsible</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {la.rows[b.key].map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/drawing-control/${r.id}`} className="link">
                        <DrawingNumber code={r.drawingCode} numberStatus={r.numberStatus} partialNumber={r.partialNumber} />
                      </Link>
                    </td>
                    <td className="max-w-[300px] truncate" title={r.drawingName}>
                      {r.drawingName}
                    </td>
                    <td className="whitespace-nowrap text-ink-mute">
                      {projectLabel({ displayName: r.projectDisplayName, projectName: r.projectName })}
                      {r.phaseCode && ` · ${r.phaseCode}`}
                    </td>
                    <td className="text-ink-mute">{r.disciplineName ?? '—'}</td>
                    <td className="text-ink-mute">{r.batchCode ?? '—'}</td>
                    <td>
                      <DateCell value={r.currentExpectedReleaseDate} />
                    </td>
                    <td className="text-ink-mute">{r.responsibleName ?? r.responsibleText ?? '—'}</td>
                    <td>
                      {perms.reschedule && (
                        <RescheduleButton
                          entityType="DRAWING"
                          ids={[r.id]}
                          currentExpected={iso(r.currentExpectedReleaseDate)}
                          projectId={r.projectId}
                          packageId={r.packageId}
                          disciplineId={r.disciplineId}
                          label={`${r.drawingCode} — ${r.drawingName}`}
                        />
                      )}
                    </td>
                  </tr>
                ))}
                {la.rows[b.key].length === 0 && (
                  <tr>
                    <td colSpan={8} className="py-4 text-center text-ink-mute">
                      Nothing {b.label.toLowerCase()}.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </TableWrap>
          {la.counts[b.key] > la.rows[b.key].length && (
            <p className="px-4 py-2 text-2xs text-ink-mute">Showing the first {la.rows[b.key].length} of {la.counts[b.key]} — narrow with the filters.</p>
          )}
        </Card>
      ))}
    </div>
  );
}

async function ConflictsTab({ status }: { status?: string }) {
  const rows = await listConflicts(status || 'OPEN');
  return (
    <Card
      title={`${rows.length} ${status || 'OPEN'} import conflicts`}
      subtitle="Held back by the importer — same number with different titles, or an ACC number missing from the register. Nothing is merged silently."
      actions={
        <div className="flex gap-1">
          {['OPEN', 'RESOLVED', 'DISMISSED'].map((s) => (
            <Link key={s} href={`?tab=conflicts&status=${s}`} className={clsx('btn btn-sm', (status || 'OPEN') === s && 'btn-primary')}>
              {s}
            </Link>
          ))}
        </div>
      }
      bodyClassName=""
    >
      <TableWrap maxHeight="68vh">
        <table className="table">
          <thead>
            <tr>
              <th>Project</th>
              <th>Number</th>
              <th>Type</th>
              <th>Candidates</th>
              <th>Decision</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const cands = JSON.parse(c.candidates) as Record<string, unknown>[];
              const labels = cands.map((x) => ({
                label: `${x.title ?? '(untitled)'} — ${x.source === 'ACC' ? 'ACC' : `${x.sheet} r${x.row}`}${x.batchCode ? ` · ${x.batchCode}` : ''}${x.revision ? ` · ${x.revision}` : ''}`,
              }));
              return (
                <tr key={c.id}>
                  <td className="whitespace-nowrap">{c.projectCode}</td>
                  <td className="whitespace-nowrap font-mono text-[11.5px]">{c.drawingNumber}</td>
                  <td className="text-2xs">{c.conflictType}</td>
                  <td className="max-w-[420px] text-2xs">
                    {labels.map((l, i) => (
                      <span key={i} className="block truncate" title={l.label}>
                        {i + 1}. {l.label}
                      </span>
                    ))}
                  </td>
                  <td>
                    {c.status === 'OPEN' ? (
                      <ConflictActions id={c.id} candidates={labels} />
                    ) : (
                      <span className="text-2xs">
                        {c.status} by {c.resolvedByLabel}: {c.resolutionNote}
                        {c.resolvedDrawingId && (
                          <>
                            {' '}
                            ·{' '}
                            <Link className="link" href={`/drawing-control/${c.resolvedDrawingId}`}>
                              drawing
                            </Link>
                          </>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-ink-mute">
                  None.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </TableWrap>
    </Card>
  );
}

async function ImportTab() {
  const batches = await listImportBatches(10);
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card title="Import from the drawing-source manifest" subtitle="data/drawing-sources/poarr.json — preview first, then apply">
        <DrawingImportPanel />
      </Card>
      <Card title="Recent import batches" bodyClassName="">
        <TableWrap>
          <table className="table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Status</th>
                <th>Created</th>
                <th>Updated</th>
                <th>Protected</th>
                <th>Conflicts</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id}>
                  <td className="whitespace-nowrap font-mono text-[11px]">{b.startedAt.toISOString().replace('T', ' ').slice(0, 16)}</td>
                  <td className="text-2xs font-semibold">{b.status}</td>
                  <td>{b.createdCount}</td>
                  <td>{b.updatedCount}</td>
                  <td>{b.protectedCount}</td>
                  <td>{b.conflictCount}</td>
                  <td className="text-2xs text-ink-mute">{b.startedByLabel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>
    </div>
  );
}

async function PhaseMapTab({ projectId }: { projectId?: string }) {
  const rows = await listPhaseMap(projectId);
  return (
    <Card title="Explicit location → phase map" subtitle="Maintained in the drawing-source manifest; applied on import. No fuzzy matching." bodyClassName="">
      <TableWrap maxHeight="68vh">
        <table className="table">
          <thead>
            <tr>
              <th>Project</th>
              <th>Location</th>
              <th>Zone token</th>
              <th>Phase</th>
              <th>Rule</th>
              <th>Evidence / note</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap">{r.projectCode}</td>
                <td className="font-mono text-[11.5px]">{r.locationCode}</td>
                <td className="font-mono text-[11.5px]">{r.zoneCode || '—'}</td>
                <td>{r.phaseCode ?? <span className="text-rag-amber">no phase</span>}</td>
                <td className="text-2xs">{r.rule}</td>
                <td className="max-w-[480px] text-2xs text-ink-mute">{r.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </Card>
  );
}
