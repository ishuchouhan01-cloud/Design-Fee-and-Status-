/**
 * Drawing detail — the eight sections, shared by the read-only register page
 * (/drawings/[id]) and the Drawing Control page (/drawing-control/[id]).
 * Controls are rendered only when `controls` says the user holds the matching
 * permission; with `controls` omitted the view is strictly read-only.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  AddDependencyButton,
  AddRevisionButton,
  DeleteDrawingButton,
  DependencyActions,
  EditDrawingButton,
  ReleaseButton,
  WithdrawReleaseButton,
  type Option,
} from '@/components/drawing-actions';
import { RescheduleButton } from '@/components/reschedule-dialog';
import { ActualRelease, Card, DateCell, DrawingNumber, Note, ReleaseBadge, ScheduleBadge, TableWrap } from '@/components/ui';
import { DEPENDENCY_TYPE_LABEL, type DependencyType } from '@/lib/domain';
import { formatDate } from '@/lib/periods';
import { evidenceLabel } from '@/lib/labels';
import { updatedOnText } from '@/lib/updated-on';
import type { getDrawingDetail } from '@/lib/services/drawing-register';

type Detail = NonNullable<Awaited<ReturnType<typeof getDrawingDetail>>>;

export interface DetailControls {
  write: boolean;
  complete: boolean;
  reschedule: boolean;
  admin: boolean;
  phases: (Option & { projectId: string })[];
  packages: (Option & { projectId: string })[];
  disciplines: Option[];
  users: Option[];
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[11rem_1fr] gap-2 border-b border-line/60 py-1.5 text-[12.5px] last:border-0">
      <dt className="text-ink-mute">{k}</dt>
      <dd className="min-w-0">{children ?? '—'}</dd>
    </div>
  );
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

export function DrawingDetailView({ detail, controls }: { detail: Detail; controls?: DetailControls }) {
  const d = detail.drawing;
  const full = detail.full;
  const label = `${d.numberStatus === 'NOT_YET_NUMBERED' ? 'Not yet numbered' : d.drawingCode} — ${d.drawingName}`;
  const released = d.completionStatus === 'COMPLETED';
  const currentRev = detail.revisions.find((r) => r.revision === d.revision) ?? null;
  const c = controls;

  return (
    <div className="space-y-4">
      {c && (
        <div className="card flex flex-wrap items-center gap-2 px-4 py-3">
          <span className="mr-2 text-2xs font-semibold uppercase tracking-wide text-ink-mute">Drawing Control</span>
          {c.write && (
            <EditDrawingButton
              small={false}
              drawing={{
                id: d.id,
                label,
                projectId: d.projectId,
                numberStatus: d.numberStatus,
                drawingCode: d.drawingCode,
                drawingName: d.drawingName,
                phaseId: d.phaseId,
                packageId: d.packageId,
                disciplineId: d.disciplineId,
                location: d.location,
                areaOfWorks: d.areaOfWorks,
                batchCode: d.batchCode,
                batch: d.batch,
                responsibleUserId: d.responsibleUserId,
                responsibleText: d.responsibleText,
                remarks: d.remarks,
              }}
              phases={c.phases}
              packages={c.packages}
              disciplines={c.disciplines}
              users={c.users}
            />
          )}
          {c.complete && (
            <ReleaseButton
              small={false}
              id={d.id}
              label={label}
              revision={d.revision}
              released={released}
              revisionReleased={!currentRev || currentRev.completionStatus === 'COMPLETED'}
            />
          )}
          {c.write && <AddRevisionButton small={false} id={d.id} label={label} current={d.revision} />}
          {c.write && <AddDependencyButton small={false} drawingId={d.id} users={c.users} />}
          {c.reschedule && !released && (
            <RescheduleButton
              entityType="DRAWING"
              ids={[d.id]}
              currentExpected={iso(d.currentExpectedReleaseDate)}
              projectId={d.projectId}
              packageId={d.packageId}
              disciplineId={d.disciplineId}
              label={label}
              className="btn"
            />
          )}
          {c.reschedule && released && <span className="text-2xs text-ink-mute">Released drawings are not rescheduled.</span>}
          <a href="#history" className="btn">
            View History
          </a>
          {c.admin && released && <WithdrawReleaseButton id={d.id} label={label} />}
          {c.admin && full.isManual && !released && <DeleteDrawingButton id={d.id} label={label} />}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Overview">
          <dl>
            <Row k="Drawing number">
              <DrawingNumber code={d.drawingCode} numberStatus={d.numberStatus} partialNumber={d.partialNumber} />
            </Row>
            <Row k="Title">{d.drawingName}</Row>
            <Row k="Project">
              <Link className="link" href={`/projects/${d.projectId}`}>
                {detail.projectPath}
              </Link>
            </Row>
            <Row k="Phase">{d.phaseCode ?? <span className="text-ink-mute">No phase {detail.phaseMap.length ? `(${detail.phaseMap.map((m) => m.rule).join(', ')})` : ''}</span>}</Row>
            <Row k="Discipline">{d.disciplineName ? `${d.disciplineCode} — ${d.disciplineName}` : '—'}</Row>
            <Row k="DFS position">
              {d.packageCode ? (
                [...detail.dfsPath.map((n) => n.name), `${d.packageCode} — ${d.packageName}`].join(' › ')
              ) : (
                <span className="text-ink-mute">Not assigned to a package</span>
              )}
            </Row>
            <Row k="Batch">{[d.batchCode, d.batch && d.batch !== d.batchCode ? `(${d.batch})` : null].filter(Boolean).join(' ') || '—'}</Row>
            <Row k="Location / area">{[d.location, d.areaOfWorks].filter(Boolean).join(' · ') || '—'}</Row>
            <Row k="Responsible">{d.responsibleName ?? d.responsibleText ?? '—'}</Row>
            <Row k="Remarks">{d.remarks ?? '—'}</Row>
          </dl>
        </Card>

        <Card title="Release">
          <dl>
            <Row k="Release status">
              <ReleaseBadge status={d.completionStatus} />
            </Row>
            <Row k="Actual release date">
              <DateCell value={d.actualReleaseDate} />
            </Row>
            {released && !d.actualReleaseDate && <Row k="Evidence of release">{evidenceLabel(d.releaseEvidence) || 'None given in the source'}</Row>}
            {d.actualReleaseDate && d.releaseEvidence && <Row k="Source">{evidenceLabel(d.releaseEvidence)}</Row>}
            <Row k="Current revision">{d.revision ?? '—'}</Row>
            <Row k="Updated On">{updatedOnText(d)}</Row>
            <Row k="Released by">{full.releasedByName ?? full.releasedByLabel ?? (released ? 'Source import' : '—')}</Row>
            <Row k="Released at">{full.releasedAt ? formatDate(full.releasedAt) : '—'}</Row>
            {full.versionCount != null && <Row k="Autodesk Construction Cloud versions">{full.versionCount}</Row>}
          </dl>
        </Card>

        <Card title="Schedule">
          <dl>
            <Row k="Baseline release">
              <DateCell value={d.baselineReleaseDate} muted /> <span className="sub">never changes</span>
            </Row>
            <Row k="Current expected">
              <DateCell value={d.currentExpectedReleaseDate} /> {d.planPeriodLabel && <span className="sub">{d.planPeriodLabel}</span>}
            </Row>
            <Row k="Actual release">
              <ActualRelease status={d.completionStatus} value={d.actualReleaseDate} evidence={null} />
            </Row>
            <Row k="Schedule status">
              {d.schedule ? (
                <ScheduleBadge status={d.schedule.status} days={d.schedule.daysToDue} />
              ) : (
                <span className="text-2xs text-ink-mute">Not assessable — the source gives no release date</span>
              )}
            </Row>
            <Row k="Slip vs baseline">{d.schedule ? `${d.schedule.slipDays} day(s)` : '—'}</Row>
            <Row k="Times rescheduled">{d.rescheduleCount}</Row>
            <Row k="Scheduling links">
              {detail.scheduleLinks.length === 0
                ? 'None'
                : detail.scheduleLinks.map((l) => (
                    <span key={l.id} className="block text-[11.5px]">
                      {l.predecessorType === 'DRAWING' && l.predecessorId === d.id ? `→ ${l.successorType}` : `← ${l.predecessorType}`}{' '}
                      {DEPENDENCY_TYPE_LABEL[l.dependencyType as DependencyType] ?? l.dependencyType}
                      {l.lagDays ? ` ${l.lagDays > 0 ? '+' : ''}${l.lagDays}d` : ''}
                    </span>
                  ))}
            </Row>
          </dl>
        </Card>

        <Card title={`Dependencies (${detail.dependencies.length})`} subtitle="Department / task dependencies — separate from FS/SS/FF scheduling links">
          {detail.dependencies.length === 0 ? (
            <p className="text-[12px] text-ink-mute">No dependencies recorded.</p>
          ) : (
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Department / owner</th>
                    <th>Description</th>
                    <th>Target</th>
                    <th>Closure</th>
                    <th>Status</th>
                    <th>Remarks</th>
                    {c?.write && <th />}
                  </tr>
                </thead>
                <tbody>
                  {detail.dependencies.map((x) => (
                    <tr key={x.id}>
                      <td className="whitespace-nowrap">
                        <b>{x.department}</b>
                        {x.ownerText && <span className="sub block">{x.ownerText}</span>}
                      </td>
                      <td className="max-w-[260px]">{x.description}</td>
                      <td>
                        <DateCell value={x.targetDate} />
                      </td>
                      <td>
                        <DateCell value={x.closureDate} />
                      </td>
                      <td>
                        <span className={x.status === 'OPEN' ? 'pill bg-amber-50 text-amber-800 ring-1 ring-amber-200' : 'pill bg-emerald-50 text-rag-green ring-1 ring-emerald-200'}>
                          {x.status}
                        </span>
                      </td>
                      <td className="text-ink-mute">{x.remarks ?? '—'}</td>
                      {c?.write && (
                        <td>
                          <DependencyActions dep={{ id: x.id, status: x.status, isManual: x.isManual, closureDate: iso(x.closureDate) }} />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      </div>

      <div id="history" className="grid gap-4 xl:grid-cols-2">
        <Card title={`Revision history (${detail.revisions.length})`} subtitle="Every revision is kept; none is overwritten" bodyClassName="">
          <TableWrap maxHeight="40vh">
            <table className="table">
              <thead>
                <tr>
                  <th>Revision</th>
                  <th>Release</th>
                  <th>Expected</th>
                  <th>Actual</th>
                  <th>Released by</th>
                  <th>Source</th>
                  <th>Remarks</th>
                </tr>
              </thead>
              <tbody>
                {detail.revisions.map((r) => (
                  <tr key={r.id} className={r.revision === d.revision ? 'bg-brand-50/40' : undefined}>
                    <td className="font-mono text-[11.5px]">
                      {r.revision ?? '—'}
                      {r.revision === d.revision && <span className="sub block">current</span>}
                    </td>
                    <td>
                      <ReleaseBadge status={r.completionStatus} />
                    </td>
                    <td>
                      <DateCell value={r.expectedReleaseDate} />
                    </td>
                    <td>
                      <ActualRelease status={r.completionStatus} value={r.actualReleaseDate} evidence={r.releaseEvidence} />
                    </td>
                    <td className="whitespace-nowrap text-ink-mute">
                      {r.releasedByLabel ?? '—'}
                      {r.releasedAt && <span className="sub block">{formatDate(r.releasedAt)}</span>}
                    </td>
                    <td className="text-2xs text-ink-mute">
                      {r.source}
                      {r.snapshotLabel && <span className="block">{r.snapshotLabel}</span>}
                    </td>
                    <td className="max-w-[220px] whitespace-pre-line text-2xs text-ink-mute">{r.remarks ?? '—'}</td>
                  </tr>
                ))}
                {detail.revisions.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-4 text-center text-ink-mute">
                      No revision recorded.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </TableWrap>
        </Card>

        <Card title={`Reschedule history (${detail.reschedules.length})`} subtitle="Expected-date moves; the baseline never changes" bodyClassName="">
          <TableWrap maxHeight="40vh">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>From</th>
                  <th>To</th>
                  <th>Shift</th>
                  <th>Reason</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                {detail.reschedules.map((h) => (
                  <tr key={h.id}>
                    <td>
                      <DateCell value={h.changedAt} />
                    </td>
                    <td>
                      <DateCell value={h.oldDate} muted />
                    </td>
                    <td>
                      <DateCell value={h.newDate} />
                    </td>
                    <td className="font-mono text-[11px]">
                      {h.daysShift > 0 ? '+' : ''}
                      {h.daysShift}d
                    </td>
                    <td className="max-w-[260px] text-[11.5px]">{h.reason}</td>
                    <td className="whitespace-nowrap text-2xs text-ink-mute">{h.changedByLabel}</td>
                  </tr>
                ))}
                {detail.reschedules.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-4 text-center text-ink-mute">
                      Never rescheduled.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      </div>

      <Card title={`Audit history (${detail.audit.length})`} bodyClassName="">
        <TableWrap maxHeight="40vh">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Field</th>
                <th>From</th>
                <th>To</th>
                <th>Reason</th>
                <th>User</th>
              </tr>
            </thead>
            <tbody>
              {detail.audit.map((a) => (
                <tr key={a.id}>
                  <td className="whitespace-nowrap font-mono text-[11px]">{a.timestamp.toISOString().replace('T', ' ').slice(0, 16)}</td>
                  <td className="whitespace-nowrap text-[11.5px] font-medium">{a.action}</td>
                  <td className="text-2xs">{a.field ?? '—'}</td>
                  <td className="max-w-[180px] truncate text-2xs text-ink-mute" title={a.oldValue ?? ''}>
                    {a.oldValue ?? '—'}
                  </td>
                  <td className="max-w-[180px] truncate text-2xs" title={a.newValue ?? ''}>
                    {a.newValue ?? '—'}
                  </td>
                  <td className="max-w-[200px] truncate text-2xs" title={a.reason ?? ''}>
                    {a.reason ?? '—'}
                  </td>
                  <td className="whitespace-nowrap text-2xs text-ink-mute">{a.userLabel}</td>
                </tr>
              ))}
              {detail.audit.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-4 text-center text-ink-mute">
                    No changes recorded since import.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableWrap>
      </Card>

      <Card title={`Source information (${detail.snapshots.length} source row${detail.snapshots.length === 1 ? '' : 's'})`} subtitle="Every workbook row this drawing was imported from — current and historical snapshots" bodyClassName="">
        <div className="px-4 pt-3 text-[12px]">
          <p>
            {full.isManual ? 'Added manually in Drawing Control.' : `Current record from ${full.sourceWorkbook ?? '—'} · ${full.sourceSheet ?? '—'} · row ${full.sourceRow ?? '—'}.`}
            {full.collection && ` ACC collection: ${full.collection}.`}
            {full.accDiscipline && ` ACC discipline: ${full.accDiscipline}.`}
            {full.tags && ` Tags: ${full.tags}.`}
            {full.accCreatedAt && ` ACC upload: ${formatDate(full.accCreatedAt)} (a bulk-upload time — not a release date).`}
          </p>
          {full.userEditedFields && <p className="mt-1 text-2xs text-ink-mute">Protected from re-import (edited by a user): {full.userEditedFields.split(',').join(', ')}</p>}
        </div>
        <TableWrap maxHeight="40vh">
          <table className="table">
            <thead>
              <tr>
                <th>Snapshot</th>
                <th>Role</th>
                <th>Sheet / row</th>
                <th>Number</th>
                <th>Title</th>
                <th>Location / batch</th>
                <th>Revision</th>
                <th>Released</th>
                <th>Plan</th>
              </tr>
            </thead>
            <tbody>
              {detail.snapshots.map((s) => (
                <tr key={s.id}>
                  <td className="whitespace-nowrap text-2xs">{s.snapshotLabel}</td>
                  <td className="text-2xs">{s.snapshotRole}</td>
                  <td className="whitespace-nowrap text-2xs text-ink-mute">
                    {s.sourceSheet} · {s.sourceRow}
                  </td>
                  <td className="font-mono text-[11px]">{s.drawingNumber ?? (s.partialNumber ? `(${s.partialNumber})` : '—')}</td>
                  <td className="max-w-[220px] truncate text-2xs" title={s.title ?? ''}>
                    {s.title ?? '—'}
                  </td>
                  <td className="whitespace-nowrap text-2xs">{[s.location, s.batchCode].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="font-mono text-[11px]">{s.revision ?? '—'}</td>
                  <td className="text-2xs">
                    {s.sourceKind === 'ACC'
                      ? `ACC ${s.explicitDateText ?? ''}`
                      : s.released
                        ? s.issuedBeforeYear
                          ? `before ${s.planYear}`
                          : `${s.planYear}${s.issuedQuarter ? ` Q${s.issuedQuarter}` : ''}`
                        : '—'}
                  </td>
                  <td className="text-2xs">{s.plannedQuarter ? `${s.planYear} Q${s.plannedQuarter}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>

      {!c && (
        <Note>
          Releases, revisions, dependencies and reschedules are changed in Drawing Control by users whose role allows it.
        </Note>
      )}
    </div>
  );
}
