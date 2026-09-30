'use client';

/**
 * Drawing Control actions. Rendered only for users whose role carries the
 * matching permission (the page decides); the API checks the same permission
 * again, so hiding a button is a convenience, never the protection.
 *
 * There is no expected-date field anywhere here: moving a date is the
 * Reschedule dialog (reschedule engine, history, audit). There is no baseline
 * field at all.
 */
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';

export interface Option {
  value: string;
  label: string;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

async function send(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const issues = Array.isArray(json.issues) ? `: ${json.issues.map((i: { message: string; path?: string[] }) => `${i.path?.join('.') ?? ''} ${i.message}`).join('; ')}` : '';
    throw new Error((json.error ?? `Request failed (${res.status})`) + issues);
  }
  return json;
}

function Modal({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-slate-900/40 p-6" role="dialog" aria-modal="true">
      <div className="w-full max-w-2xl rounded-lg border border-line bg-surface shadow-xl">
        <header className="flex items-start justify-between border-b border-line px-5 py-3">
          <div>
            <h2 className="text-[15px] font-semibold">{title}</h2>
            {subtitle && <p className="mt-0.5 text-2xs text-ink-mute">{subtitle}</p>}
          </div>
          <button className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="space-y-3 px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
      {hint && <p className="mt-0.5 text-2xs text-ink-mute">{hint}</p>}
    </div>
  );
}

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      after?.();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-rag-red">{error}</p> : null;
}

// ---------------------------------------------------------------------------
// + Add Drawing
// ---------------------------------------------------------------------------

export function AddDrawingButton({
  projects,
  phases,
  disciplines,
  users,
  defaultProjectId,
}: {
  projects: Option[];
  phases: (Option & { projectId: string })[];
  disciplines: Option[];
  users: Option[];
  defaultProjectId?: string;
}) {
  const [open, setOpen] = useState(false);
  const { busy, error, run } = useAction();
  const [f, setF] = useState({
    projectId: defaultProjectId ?? '',
    drawingNumber: '',
    drawingName: '',
    phaseId: '',
    disciplineId: '',
    location: '',
    batchCode: '',
    batch: '',
    revision: '',
    expectedReleaseDate: '',
    responsibleUserId: '',
    responsibleText: '',
    remarks: '',
  });
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });
  const nul = (v: string) => (v.trim() ? v.trim() : null);
  if (!open) {
    return (
      <button className="btn btn-primary" onClick={() => setOpen(true)}>
        + Add Drawing
      </button>
    );
  }
  return (
    <Modal title="Add drawing" subtitle="A new drawing starts NOT RELEASED with no actual release date." onClose={() => setOpen(false)}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Project *">
          <select className="select" value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value, phaseId: '' })}>
            <option value="">Select…</option>
            {projects.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Phase">
          <select className="select" value={f.phaseId} onChange={(e) => set('phaseId', e.target.value)}>
            <option value="">—</option>
            {phases
              .filter((p) => p.projectId === f.projectId)
              .map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Drawing number" hint="Leave blank if the number has not been assigned yet.">
          <input className="input" value={f.drawingNumber} onChange={(e) => set('drawingNumber', e.target.value)} />
        </Field>
        <Field label="Discipline">
          <select className="select" value={f.disciplineId} onChange={(e) => set('disciplineId', e.target.value)}>
            <option value="">—</option>
            {disciplines.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </Field>
        <div className="col-span-2">
          <Field label="Title *">
            <input className="input w-full" value={f.drawingName} onChange={(e) => set('drawingName', e.target.value)} />
          </Field>
        </div>
        <Field label="Location">
          <input className="input" value={f.location} onChange={(e) => set('location', e.target.value)} />
        </Field>
        <Field label="Revision">
          <input className="input" value={f.revision} onChange={(e) => set('revision', e.target.value)} placeholder="R0" />
        </Field>
        <Field label="Batch code">
          <input className="input" value={f.batchCode} onChange={(e) => set('batchCode', e.target.value)} />
        </Field>
        <Field label="Batch">
          <input className="input" value={f.batch} onChange={(e) => set('batch', e.target.value)} />
        </Field>
        <Field label="Expected release" hint="Becomes the baseline too; later changes go through Reschedule.">
          <input type="date" className="input" value={f.expectedReleaseDate} onChange={(e) => set('expectedReleaseDate', e.target.value)} />
        </Field>
        <Field label="Responsible">
          <select className="select" value={f.responsibleUserId} onChange={(e) => set('responsibleUserId', e.target.value)}>
            <option value="">—</option>
            {users.map((u) => (
              <option key={u.value} value={u.value}>
                {u.label}
              </option>
            ))}
          </select>
        </Field>
        <div className="col-span-2">
          <Field label="Remarks">
            <textarea className="input w-full" rows={2} value={f.remarks} onChange={(e) => set('remarks', e.target.value)} />
          </Field>
        </div>
      </div>
      <ErrorLine error={error} />
      <div className="flex justify-end gap-2">
        <button
          className="btn btn-primary"
          disabled={busy || !f.projectId || !f.drawingName.trim()}
          onClick={() =>
            run(
              () =>
                send('/api/drawings', 'POST', {
                  projectId: f.projectId,
                  drawingNumber: nul(f.drawingNumber),
                  drawingName: f.drawingName.trim(),
                  phaseId: nul(f.phaseId),
                  disciplineId: nul(f.disciplineId),
                  location: nul(f.location),
                  batchCode: nul(f.batchCode),
                  batch: nul(f.batch),
                  revision: nul(f.revision),
                  expectedReleaseDate: f.expectedReleaseDate || null,
                  responsibleUserId: nul(f.responsibleUserId),
                  remarks: nul(f.remarks),
                }),
              () => setOpen(false),
            )
          }
        >
          {busy ? 'Saving…' : 'Add drawing'}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

export interface EditableDrawing {
  id: string;
  label: string;
  projectId: string;
  numberStatus: string;
  drawingCode: string;
  drawingName: string;
  phaseId: string | null;
  packageId: string | null;
  disciplineId: string | null;
  location: string | null;
  areaOfWorks: string | null;
  batchCode: string | null;
  batch: string | null;
  responsibleUserId: string | null;
  responsibleText: string | null;
  remarks: string | null;
}

export function EditDrawingButton({
  drawing,
  phases,
  packages = [],
  disciplines,
  users,
  small = true,
}: {
  drawing: EditableDrawing;
  phases: (Option & { projectId: string })[];
  packages?: (Option & { projectId: string })[];
  disciplines: Option[];
  users: Option[];
  small?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { busy, error, run } = useAction();
  const initial = {
    drawingNumber: drawing.numberStatus === 'NOT_YET_NUMBERED' ? '' : drawing.drawingCode,
    drawingName: drawing.drawingName,
    phaseId: drawing.phaseId ?? '',
    packageId: drawing.packageId ?? '',
    disciplineId: drawing.disciplineId ?? '',
    location: drawing.location ?? '',
    areaOfWorks: drawing.areaOfWorks ?? '',
    batchCode: drawing.batchCode ?? '',
    batch: drawing.batch ?? '',
    responsibleUserId: drawing.responsibleUserId ?? '',
    responsibleText: drawing.responsibleText ?? '',
    remarks: drawing.remarks ?? '',
  };
  const [f, setF] = useState(initial);
  const [reason, setReason] = useState('');
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });
  if (!open) {
    return (
      <button className={small ? 'btn btn-sm' : 'btn'} onClick={() => setOpen(true)}>
        Edit
      </button>
    );
  }
  const patch: Record<string, unknown> = {};
  for (const k of Object.keys(f) as (keyof typeof f)[]) {
    if (f[k] !== initial[k]) patch[k] = k === 'drawingNumber' ? f[k].trim() : f[k].trim() === '' ? null : f[k];
  }
  if (patch.drawingNumber === '') delete patch.drawingNumber;
  return (
    <Modal
      title="Edit drawing"
      subtitle={`${drawing.label} · dates, release and revision have their own controls`}
      onClose={() => setOpen(false)}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Drawing number"
          hint={drawing.numberStatus === 'NOT_YET_NUMBERED' ? 'Assigning a number updates this drawing; it does not create a new one.' : undefined}
        >
          <input className="input" value={f.drawingNumber} onChange={(e) => set('drawingNumber', e.target.value)} placeholder="Not yet numbered" />
        </Field>
        <Field label="Phase">
          <select className="select" value={f.phaseId} onChange={(e) => set('phaseId', e.target.value)}>
            <option value="">—</option>
            {phases
              .filter((p) => p.projectId === drawing.projectId)
              .map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
          </select>
        </Field>
        <div className="col-span-2">
          <Field label="Title">
            <input className="input w-full" value={f.drawingName} onChange={(e) => set('drawingName', e.target.value)} />
          </Field>
        </div>
        <Field label="Discipline">
          <select className="select" value={f.disciplineId} onChange={(e) => set('disciplineId', e.target.value)}>
            <option value="">—</option>
            {disciplines.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Package (DFS / billing)">
          <select className="select" value={f.packageId} onChange={(e) => set('packageId', e.target.value)}>
            <option value="">— (grouped by batch)</option>
            {packages
              .filter((p) => p.projectId === drawing.projectId)
              .map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Location">
          <input className="input" value={f.location} onChange={(e) => set('location', e.target.value)} />
        </Field>
        <Field label="Batch code">
          <input className="input" value={f.batchCode} onChange={(e) => set('batchCode', e.target.value)} />
        </Field>
        <Field label="Batch">
          <input className="input" value={f.batch} onChange={(e) => set('batch', e.target.value)} />
        </Field>
        <Field label="Responsible">
          <select className="select" value={f.responsibleUserId} onChange={(e) => set('responsibleUserId', e.target.value)}>
            <option value="">—</option>
            {users.map((u) => (
              <option key={u.value} value={u.value}>
                {u.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Responsible (text)">
          <input className="input" value={f.responsibleText} onChange={(e) => set('responsibleText', e.target.value)} />
        </Field>
        <div className="col-span-2">
          <Field label="Remarks">
            <textarea className="input w-full" rows={2} value={f.remarks} onChange={(e) => set('remarks', e.target.value)} />
          </Field>
        </div>
        <div className="col-span-2">
          <Field label="Reason (recorded in the audit trail)">
            <input className="input w-full" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
      </div>
      <p className="text-2xs text-ink-mute">Edited fields are protected: a later import will not overwrite them.</p>
      <ErrorLine error={error} />
      <div className="flex justify-end">
        <button
          className="btn btn-primary"
          disabled={busy || Object.keys(patch).length === 0}
          onClick={() => run(() => send(`/api/drawings/${drawing.id}`, 'PATCH', { ...patch, reason: reason || undefined }), () => setOpen(false))}
        >
          {busy ? 'Saving…' : `Save ${Object.keys(patch).length || ''} change(s)`}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Mark as Released / withdraw
// ---------------------------------------------------------------------------

export function ReleaseButton({
  id,
  label,
  revision,
  released,
  revisionReleased,
  small = true,
}: {
  id: string;
  label: string;
  revision: string | null;
  released: boolean;
  revisionReleased: boolean;
  small?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { busy, error, run } = useAction();
  const [date, setDate] = useState(todayIso());
  const [rev, setRev] = useState('');
  const [remarks, setRemarks] = useState('');
  if (released && revisionReleased) return null;
  const text = released ? `Release ${revision ?? 'revision'}` : 'Mark as Released';
  if (!open) {
    return (
      <button className={small ? 'btn btn-sm btn-primary' : 'btn btn-primary'} onClick={() => setOpen(true)}>
        {text}
      </button>
    );
  }
  return (
    <Modal
      title={text}
      subtitle={`${label} · records the actual release date, who released it, the revision and an audit entry. The baseline is not changed.`}
      onClose={() => setOpen(false)}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Actual release date *">
          <input type="date" className="input" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} />
        </Field>
        {!released && (
          <Field label="Revision released" hint={`Current: ${revision ?? '—'}. Enter a new one only if a different revision is being issued.`}>
            <input className="input" value={rev} onChange={(e) => setRev(e.target.value)} placeholder={revision ?? 'R0'} />
          </Field>
        )}
        <div className="col-span-2">
          <Field label="Remarks">
            <textarea className="input w-full" rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </Field>
        </div>
      </div>
      <ErrorLine error={error} />
      <div className="flex justify-end">
        <button
          className="btn btn-primary"
          disabled={busy || !date}
          onClick={() =>
            run(
              () =>
                send(`/api/drawings/${id}/release`, 'POST', {
                  actualReleaseDate: date,
                  revision: rev.trim() || undefined,
                  remarks: remarks.trim() || undefined,
                }),
              () => setOpen(false),
            )
          }
        >
          {busy ? 'Releasing…' : 'Confirm release'}
        </button>
      </div>
    </Modal>
  );
}

export function WithdrawReleaseButton({ id, label }: { id: string; label: string }) {
  const [open, setOpen] = useState(false);
  const { busy, error, run } = useAction();
  const [reason, setReason] = useState('');
  if (!open) {
    return (
      <button className="btn btn-sm btn-danger" onClick={() => setOpen(true)}>
        Withdraw release
      </button>
    );
  }
  return (
    <Modal title="Withdraw release" subtitle={`${label} · admin only; the withdrawn release stays in the revision history and audit trail.`} onClose={() => setOpen(false)}>
      <Field label="Reason *">
        <input className="input w-full" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <ErrorLine error={error} />
      <div className="flex justify-end">
        <button className="btn btn-danger" disabled={busy || reason.trim().length < 3} onClick={() => run(() => send(`/api/drawings/${id}/unrelease`, 'POST', { reason }), () => setOpen(false))}>
          {busy ? 'Working…' : 'Withdraw release'}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Revisions
// ---------------------------------------------------------------------------

export function AddRevisionButton({ id, label, current, small = true }: { id: string; label: string; current: string | null; small?: boolean }) {
  const [open, setOpen] = useState(false);
  const { busy, error, run } = useAction();
  const next = (() => {
    const m = /^(\D*)(\d+)$/.exec(current ?? '');
    return m ? `${m[1]}${Number(m[2]) + 1}` : current ? '' : 'R0';
  })();
  const [rev, setRev] = useState(next);
  const [date, setDate] = useState('');
  const [remarks, setRemarks] = useState('');
  if (!open) {
    return (
      <button className={small ? 'btn btn-sm' : 'btn'} onClick={() => setOpen(true)}>
        Add Revision
      </button>
    );
  }
  return (
    <Modal title="Add revision" subtitle={`${label} · current ${current ?? '—'}. Earlier revisions stay in the history; nothing is overwritten.`} onClose={() => setOpen(false)}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="New revision *">
          <input className="input" value={rev} onChange={(e) => setRev(e.target.value)} />
        </Field>
        <Field label="Planned release of this revision">
          <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <div className="col-span-2">
          <Field label="Remarks">
            <textarea className="input w-full" rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </Field>
        </div>
      </div>
      <ErrorLine error={error} />
      <div className="flex justify-end">
        <button
          className="btn btn-primary"
          disabled={busy || !rev.trim()}
          onClick={() =>
            run(
              () => send(`/api/drawings/${id}/revisions`, 'POST', { revision: rev.trim(), expectedReleaseDate: date || null, remarks: remarks.trim() || undefined }),
              () => setOpen(false),
            )
          }
        >
          {busy ? 'Saving…' : 'Add revision'}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Department / task dependencies
// ---------------------------------------------------------------------------

export function AddDependencyButton({ drawingId, users, small = true }: { drawingId: string; users: Option[]; small?: boolean }) {
  const [open, setOpen] = useState(false);
  const { busy, error, run } = useAction();
  const [f, setF] = useState({ department: '', ownerUserId: '', ownerText: '', description: '', targetDate: '', remarks: '' });
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });
  if (!open) {
    return (
      <button className={small ? 'btn btn-sm' : 'btn'} onClick={() => setOpen(true)}>
        Add Dependency
      </button>
    );
  }
  return (
    <Modal title="Add dependency" subtitle="A department / task dependency for coordinating this drawing (not a scheduling link)." onClose={() => setOpen(false)}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Department *">
          <input className="input" value={f.department} onChange={(e) => set('department', e.target.value)} placeholder="PHE, STR, HVAC…" />
        </Field>
        <Field label="Target date">
          <input type="date" className="input" value={f.targetDate} onChange={(e) => set('targetDate', e.target.value)} />
        </Field>
        <div className="col-span-2">
          <Field label="Description *">
            <textarea className="input w-full" rows={2} value={f.description} onChange={(e) => set('description', e.target.value)} />
          </Field>
        </div>
        <Field label="Owner">
          <select className="select" value={f.ownerUserId} onChange={(e) => set('ownerUserId', e.target.value)}>
            <option value="">—</option>
            {users.map((u) => (
              <option key={u.value} value={u.value}>
                {u.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Owner (text)">
          <input className="input" value={f.ownerText} onChange={(e) => set('ownerText', e.target.value)} />
        </Field>
        <div className="col-span-2">
          <Field label="Remarks">
            <input className="input w-full" value={f.remarks} onChange={(e) => set('remarks', e.target.value)} />
          </Field>
        </div>
      </div>
      <ErrorLine error={error} />
      <div className="flex justify-end">
        <button
          className="btn btn-primary"
          disabled={busy || !f.department.trim() || !f.description.trim()}
          onClick={() =>
            run(
              () =>
                send(`/api/drawings/${drawingId}/dependencies`, 'POST', {
                  department: f.department.trim(),
                  description: f.description.trim(),
                  ownerUserId: f.ownerUserId || null,
                  ownerText: f.ownerText.trim() || null,
                  targetDate: f.targetDate || null,
                  remarks: f.remarks.trim() || null,
                }),
              () => setOpen(false),
            )
          }
        >
          {busy ? 'Saving…' : 'Add dependency'}
        </button>
      </div>
    </Modal>
  );
}

export function DependencyActions({ dep }: { dep: { id: string; status: string; isManual: boolean; closureDate: string | null } }) {
  const { busy, error, run } = useAction();
  const [date, setDate] = useState(todayIso());
  return (
    <div className="flex flex-wrap items-center gap-1">
      {dep.status === 'OPEN' ? (
        <>
          <input type="date" className="input h-7 w-32 py-0 text-[11px]" value={date} onChange={(e) => setDate(e.target.value)} />
          <button className="btn btn-sm" disabled={busy} onClick={() => run(() => send(`/api/drawing-dependencies/${dep.id}`, 'PATCH', { status: 'CLOSED', closureDate: date }))}>
            Close
          </button>
        </>
      ) : (
        <button className="btn btn-sm" disabled={busy} onClick={() => run(() => send(`/api/drawing-dependencies/${dep.id}`, 'PATCH', { status: 'OPEN' }))}>
          Reopen
        </button>
      )}
      {dep.isManual && (
        <button
          className="btn btn-sm btn-danger"
          disabled={busy}
          onClick={() => {
            if (window.confirm('Delete this dependency? The deletion is recorded in the audit trail.')) run(() => send(`/api/drawing-dependencies/${dep.id}`, 'DELETE'));
          }}
        >
          Delete
        </button>
      )}
      {error && <span className="text-2xs text-rag-red">{error}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export function DeleteDrawingButton({ id, label }: { id: string; label: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { busy, error, run } = useAction();
  const [reason, setReason] = useState('');
  if (!open) {
    return (
      <button className="btn btn-sm btn-danger" onClick={() => setOpen(true)}>
        Delete
      </button>
    );
  }
  return (
    <Modal title="Delete drawing" subtitle={`${label} · only manually added drawings that were never released can be deleted.`} onClose={() => setOpen(false)}>
      <Field label="Reason *">
        <input className="input w-full" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <ErrorLine error={error} />
      <div className="flex justify-end">
        <button
          className="btn btn-danger"
          disabled={busy || reason.trim().length < 3}
          onClick={() => run(() => send(`/api/drawings/${id}`, 'DELETE', { reason }), () => router.push('/drawing-control'))}
        >
          {busy ? 'Deleting…' : 'Delete drawing'}
        </button>
      </div>
    </Modal>
  );
}

export function ConflictActions({ id, candidates }: { id: string; candidates: { label: string }[] }) {
  const { busy, error, run } = useAction();
  const [pick, setPick] = useState('0');
  const [note, setNote] = useState('');
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <select className="select h-7 max-w-[22rem] py-0 text-[11px]" value={pick} onChange={(e) => setPick(e.target.value)}>
          {candidates.map((c, i) => (
            <option key={i} value={i}>
              {i + 1}. {c.label}
            </option>
          ))}
        </select>
        <input className="input h-7 w-56 py-0 text-[11px]" placeholder="Decision note (required)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn btn-sm btn-primary" disabled={busy || note.trim().length < 3} onClick={() => run(() => send(`/api/drawing-conflicts/${id}`, 'POST', { action: 'RESOLVE', candidateIndex: Number(pick), note }))}>
          Use this record
        </button>
        <button className="btn btn-sm" disabled={busy || note.trim().length < 3} onClick={() => run(() => send(`/api/drawing-conflicts/${id}`, 'POST', { action: 'DISMISS', note }))}>
          Dismiss
        </button>
      </div>
      {error && <p className="text-2xs text-rag-red">{error}</p>}
    </div>
  );
}

interface ImportSummary {
  mode: string;
  batchId: string;
  valid: boolean;
  validation: string[];
  counts: { total: Record<string, number>; projects: Record<string, Record<string, number>>; historicalSnapshotRows: Record<string, number> };
  changes: Record<string, number>;
  issueCounts: Record<string, number>;
  durationMs: number;
}

export function DrawingImportPanel() {
  const { busy, error, run } = useAction();
  const [result, setResult] = useState<ImportSummary | null>(null);
  const go = (apply: boolean) =>
    run(async () => {
      setResult(null);
      setResult((await send('/api/drawings/import', 'POST', { apply })) as ImportSummary);
    });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <button className="btn" disabled={busy} onClick={() => go(false)}>
          {busy ? 'Working…' : '1. Preview import'}
        </button>
        <button
          className="btn btn-primary"
          disabled={busy || !result || result.mode !== 'PREVIEW' || !result.valid}
          onClick={() => {
            if (window.confirm('Apply the drawing import? It runs in one transaction and is refused unless every validation target matches.')) go(true);
          }}
        >
          2. Apply import
        </button>
      </div>
      <p className="text-2xs text-ink-mute">Take a backup first (Settings → Backup). The preview writes no drawing data.</p>
      <ErrorLine error={error} />
      {result && (
        <div className="space-y-2 text-[12px]">
          <p>
            <b>{result.mode}</b> · batch {result.batchId} · {(result.durationMs / 1000).toFixed(1)}s ·{' '}
            {result.valid ? <span className="text-rag-green">all validation targets matched</span> : <span className="text-rag-red">validation failed</span>}
          </p>
          {!result.valid && (
            <ul className="list-disc pl-5 text-rag-red">
              {result.validation.map((v) => (
                <li key={v}>{v}</li>
              ))}
            </ul>
          )}
          <table className="table">
            <thead>
              <tr>
                <th>Project</th>
                <th>Drawings</th>
                <th>Released</th>
                <th>Not released</th>
                <th>Not yet numbered</th>
                <th>Conflicts</th>
                <th>ACC-only</th>
                <th>Actual dates</th>
              </tr>
            </thead>
            <tbody>
              {[...Object.entries(result.counts.projects), ['TOTAL', result.counts.total] as const].map(([k, c]) => (
                <tr key={k}>
                  <td className="font-medium">{k}</td>
                  <td>{c.drawings}</td>
                  <td>{c.released}</td>
                  <td>{c.notReleased}</td>
                  <td>{c.notYetNumbered}</td>
                  <td>{c.numberConflicts}</td>
                  <td>{c.accOnlyConflicts}</td>
                  <td>{c.actualDates}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            Against the database:{' '}
            {Object.entries(result.changes)
              .map(([k, v]) => `${k} ${v}`)
              .join(' · ')}
          </p>
          <p>
            Historical snapshot rows: {result.counts.historicalSnapshotRows.total} · Issues:{' '}
            {Object.entries(result.issueCounts)
              .map(([k, v]) => `${k} ${v}`)
              .join(' · ')}
          </p>
        </div>
      )}
    </div>
  );
}
