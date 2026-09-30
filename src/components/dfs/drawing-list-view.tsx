/**
 * The flat drawing list inside DFS — search / filter / export across every
 * drawing. Read-only. The DFS tree is the default view; this list is for
 * finding drawings across packages.
 */
import Link from 'next/link';
import { projectLabel } from '@/lib/labels';
import { updatedOnText } from '@/lib/updated-on';
import { FilterBar, type FilterDef } from '@/components/filter-bar';
import { Pagination } from '@/components/pagination';
import { ActualRelease, Card, DateCell, DrawingNumber, ReleaseBadge, ScheduleBadge, TableWrap } from '@/components/ui';
import { SCHEDULE_STATUSES, SCHEDULE_STATUS_LABEL } from '@/lib/domain';
import { drawingReference, listDrawings, parseDrawingFilters } from '@/lib/services/drawing-register';

export async function DrawingListView({ sp }: { sp: Record<string, string> }) {
  const filters = parseDrawingFilters(sp);
  const [result, ref] = await Promise.all([listDrawings(filters), drawingReference(filters.projectId)]);
  const defs: FilterDef[] = [
    { key: 'projectId', label: 'Project', type: 'select', options: ref.projectOptions.map((p) => ({ value: p.value, label: p.label })), width: '14rem' },
    {
      key: 'phaseId',
      label: 'Phase',
      type: 'select',
      options: [{ value: 'NONE', label: '(no phase)' }, ...ref.phases.map((p) => ({ value: p.id, label: p.code }))],
      width: '9rem',
    },
    { key: 'disciplineId', label: 'Discipline', type: 'select', options: ref.disciplines.map((d) => ({ value: d.id, label: d.name })), width: '8rem' },
    ...(ref.packages.length
      ? [{ key: 'packageId', label: 'Package', type: 'select' as const, options: ref.packages.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` })), width: '12rem' }]
      : []),
    ...(ref.batches.length
      ? [{ key: 'batchCode', label: 'Batch', type: 'select' as const, options: ref.batches.map((b) => ({ value: b, label: b })), width: '9rem' }]
      : [{ key: 'batchCode', label: 'Batch code', type: 'text' as const, width: '8rem' }]),
    {
      key: 'release',
      label: 'Release status',
      type: 'select',
      options: [
        { value: 'COMPLETED', label: 'RELEASED' },
        { value: 'NOT_COMPLETED', label: 'NOT RELEASED' },
      ],
      width: '9rem',
    },
    {
      key: 'scheduleStatus',
      label: 'Schedule status',
      type: 'select',
      options: SCHEDULE_STATUSES.map((s) => ({ value: s, label: SCHEDULE_STATUS_LABEL[s] })),
      width: '10rem',
    },
    {
      key: 'responsibleId',
      label: 'Responsible',
      type: 'select',
      options: [{ value: 'NONE', label: '(not assigned)' }, ...ref.responsibles.map((u) => ({ value: u.id, label: u.name }))],
      width: '10rem',
    },
    {
      key: 'numberStatus',
      label: 'Number',
      type: 'select',
      options: [
        { value: 'NUMBERED', label: 'Numbered' },
        { value: 'NOT_YET_NUMBERED', label: 'Not yet numbered' },
      ],
      width: '9rem',
    },
    {
      key: 'releaseDate',
      label: 'Release date',
      type: 'select',
      options: [
        { value: 'RECORDED', label: 'Recorded' },
        { value: 'NOT_RECORDED', label: 'Released — no release date' },
      ],
      width: '10rem',
    },
    {
      key: 'dateField',
      label: 'Date',
      type: 'select',
      options: [
        { value: 'expected', label: 'Expected release' },
        { value: 'actual', label: 'Actual release' },
        { value: 'baseline', label: 'Baseline' },
        { value: 'updated', label: 'Updated On' },
      ],
      width: '9rem',
    },
    { key: 'dateFrom', label: 'From (YYYY-MM-DD)', type: 'text', width: '8.5rem' },
    { key: 'dateTo', label: 'To (YYYY-MM-DD)', type: 'text', width: '8.5rem' },
    {
      key: 'sort',
      label: 'Sort by',
      type: 'select',
      options: [
        { value: 'updated', label: 'Updated On' },
        { value: 'expected', label: 'Expected release' },
        { value: 'actual', label: 'Actual release' },
        { value: 'name', label: 'Drawing name' },
      ],
      width: '9rem',
    },
    {
      key: 'dir',
      label: 'Order',
      type: 'select',
      options: [
        { value: 'desc', label: 'Newest first' },
        { value: 'asc', label: 'Oldest first' },
      ],
      width: '8rem',
    },
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
                <th>Project</th>
                <th>Phase</th>
                <th>Discipline</th>
                <th>Package</th>
                <th>Batch</th>
                <th>Revision</th>
                <th>Release status</th>
                <th>Expected release</th>
                <th>Actual release</th>
                <th>Responsible</th>
                <th>Schedule status</th>
                <th>Updated On</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/drawings/${r.id}`} className="link">
                      <DrawingNumber code={r.drawingCode} numberStatus={r.numberStatus} partialNumber={r.partialNumber} />
                    </Link>
                  </td>
                  <td className="max-w-[300px]">
                    <Link href={`/drawings/${r.id}`} className="block truncate hover:underline" title={r.drawingName}>
                      {r.drawingName}
                    </Link>
                    {r.location && <span className="sub">{r.location}</span>}
                  </td>
                  <td className="whitespace-nowrap text-ink-mute">{projectLabel({ displayName: r.projectDisplayName, projectName: r.projectName })}</td>
                  <td className="text-ink-mute">{r.phaseCode ?? '—'}</td>
                  <td className="text-ink-mute">{r.disciplineName ?? '—'}</td>
                  <td className="text-ink-mute" title={r.packageName ?? ''}>
                    {r.packageCode ?? '—'}
                  </td>
                  <td className="whitespace-nowrap text-ink-mute">{r.batchCode ?? r.batch ?? '—'}</td>
                  <td className="font-mono text-[11px]">{r.revision ?? '—'}</td>
                  <td>
                    <ReleaseBadge status={r.completionStatus} />
                  </td>
                  <td>
                    <DateCell value={r.currentExpectedReleaseDate} />
                    {r.rescheduleCount > 0 && <span className="sub block">{r.rescheduleCount}× moved</span>}
                  </td>
                  <td>
                    <ActualRelease status={r.completionStatus} value={r.actualReleaseDate} evidence={r.releaseEvidence} />
                  </td>
                  <td className="whitespace-nowrap text-ink-mute">{r.responsibleName ?? r.responsibleText ?? '—'}</td>
                  <td>{r.schedule ? <ScheduleBadge status={r.schedule.status} days={r.schedule.daysToDue} /> : <span className="text-2xs text-ink-mute">—</span>}</td>
                  <td className="whitespace-nowrap tabular-nums text-ink-mute">{updatedOnText(r)}</td>
                </tr>
              ))}
              {result.rows.length === 0 && (
                <tr>
                  <td colSpan={14} className="py-6 text-center text-ink-mute">
                    No drawings match the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableWrap>
        <Pagination page={result.page} pageCount={result.pageCount} total={result.total} pageSize={result.pageSize} />
      </Card>

    </>
  );
}
