'use client';

/**
 * Dependency list for one FY26 package: add, edit, complete, delete.
 *
 * Every write here targets `/api/fy26/dependencies` only — editing a
 * dependency never touches its parent package row.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Local copy of the shared CompletionBadge markup.
 *
 * `components/ui.tsx` reaches `lib/config.ts` through `lib/periods.ts`, which
 * imports `node:path` — fine on the server, unbundlable in a client component.
 * No other client component imports from ui.tsx for the same reason.
 */
function CompletionBadge({ status }: { status: string }) {
  const done = status === 'COMPLETED';
  return (
    <span className={`pill ${done ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-700'}`}>
      {done ? 'COMPLETED' : 'NOT COMPLETED'}
    </span>
  );
}

export interface DependencyItem {
  id: string;
  sequence: number;
  stepLabel: string | null;
  description: string;
  targetDate: string | null;
  responsibleText: string | null;
  remarks: string | null;
  completionStatus: string;
  isManual: boolean;
  sourceWorkbook: string | null;
  sourceSheet: string | null;
  sourceRow: number | null;
}

const EMPTY = {
  stepLabel: '',
  description: '',
  targetDate: '',
  responsibleText: '',
  remarks: '',
};

type Draft = typeof EMPTY;

function toDraft(d: DependencyItem): Draft {
  return {
    stepLabel: d.stepLabel ?? '',
    description: d.description,
    targetDate: d.targetDate ? d.targetDate.slice(0, 10) : '',
    responsibleText: d.responsibleText ?? '',
    remarks: d.remarks ?? '',
  };
}

function payloadOf(draft: Draft, reason: string) {
  return {
    stepLabel: draft.stepLabel.trim() || null,
    description: draft.description.trim(),
    targetDate: draft.targetDate || null,
    responsibleText: draft.responsibleText.trim() || null,
    remarks: draft.remarks.trim() || null,
    ...(reason.trim() ? { reason: reason.trim() } : {}),
  };
}

export function DependencyList({
  packageId,
  dependencies,
  canWrite,
}: {
  packageId: string;
  dependencies: DependencyItem[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setAdding(false);
    setEditingId(null);
    setConfirmDelete(null);
    setDraft(EMPTY);
    setReason('');
    setError(null);
  };

  const send = async (url: string, method: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    setBusy(false);
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setError(json.error ?? `${method} failed`);
      return false;
    }
    reset();
    router.refresh();
    return true;
  };

  const create = () => {
    if (!draft.description.trim()) {
      setError('A dependency needs a description.');
      return;
    }
    void send('/api/fy26/dependencies', 'POST', { fy26PackageId: packageId, ...payloadOf(draft, reason) });
  };

  const save = (id: string) => {
    if (!draft.description.trim()) {
      setError('A dependency needs a description.');
      return;
    }
    void send(`/api/fy26/dependencies/${id}`, 'PATCH', payloadOf(draft, reason));
  };

  const toggle = (d: DependencyItem) =>
    void send(`/api/fy26/dependencies/${d.id}`, 'PATCH', {
      completionStatus: d.completionStatus === 'COMPLETED' ? 'NOT_COMPLETED' : 'COMPLETED',
    });

  const remove = (id: string) =>
    void send(`/api/fy26/dependencies/${id}${reason.trim() ? `?reason=${encodeURIComponent(reason.trim())}` : ''}`, 'DELETE');

  const fields = (
    <div className="grid gap-2 md:grid-cols-12">
      <label className="md:col-span-2">
        <span className="label">Step</span>
        <input
          className="input w-full"
          placeholder="Step 1 (optional)"
          value={draft.stepLabel}
          onChange={(e) => setDraft({ ...draft, stepLabel: e.target.value })}
        />
      </label>
      <label className="md:col-span-4">
        <span className="label">Description</span>
        <input
          className="input w-full"
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
      </label>
      <label className="md:col-span-2">
        <span className="label">Target date</span>
        <input
          type="date"
          className="input w-full"
          value={draft.targetDate}
          onChange={(e) => setDraft({ ...draft, targetDate: e.target.value })}
        />
      </label>
      <label className="md:col-span-2">
        <span className="label">Responsible</span>
        <input
          className="input w-full"
          placeholder="free text"
          value={draft.responsibleText}
          onChange={(e) => setDraft({ ...draft, responsibleText: e.target.value })}
        />
      </label>
      <label className="md:col-span-2">
        <span className="label">Remarks</span>
        <input
          className="input w-full"
          value={draft.remarks}
          onChange={(e) => setDraft({ ...draft, remarks: e.target.value })}
        />
      </label>
      <label className="md:col-span-12">
        <span className="label">Reason for the audit trail (optional)</span>
        <input className="input w-full" value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
    </div>
  );

  return (
    <div>
      {error ? <p className="mb-2 text-[12px] text-rose-600">{error}</p> : null}

      {dependencies.length === 0 && !adding ? (
        <p className="mb-3 text-[12.5px] text-slate-500">
          No dependencies recorded for this package.
        </p>
      ) : null}

      <ul className="space-y-1.5">
        {dependencies.map((d) => (
          <li key={d.id} className="rounded border border-slate-200 px-3 py-2">
            {editingId === d.id ? (
              <div className="space-y-2">
                {fields}
                <div className="flex gap-2">
                  <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => save(d.id)}>
                    {busy ? 'Saving…' : 'Save'}
                  </button>
                  <button className="btn btn-sm" disabled={busy} onClick={reset}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-slate-800">
                    {d.stepLabel ? (
                      <span className="mr-2 font-medium text-slate-500">{d.stepLabel}</span>
                    ) : (
                      <span
                        className="mr-2 text-[11px] uppercase tracking-wide text-slate-400"
                        title="This dependency has no Step label in the source workbook. 65 imported dependencies are like this — they are real, not blank rows."
                      >
                        no step
                      </span>
                    )}
                    {d.description}
                  </p>
                  <p className="mt-0.5 text-[11.5px] text-slate-500">
                    {d.targetDate ? new Date(d.targetDate).toISOString().slice(0, 10) : 'no date'}
                    {d.responsibleText ? ` · ${d.responsibleText}` : ''}
                    {d.isManual
                      ? ' · added here'
                      : d.sourceWorkbook
                        ? ` · ${d.sourceWorkbook} › ${d.sourceSheet} › row ${d.sourceRow}`
                        : ''}
                  </p>
                  {d.remarks ? <p className="mt-0.5 text-[11.5px] text-amber-700">{d.remarks}</p> : null}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <CompletionBadge status={d.completionStatus} />
                  {canWrite ? (
                    <>
                      <button className="btn btn-sm" disabled={busy} onClick={() => toggle(d)}>
                        {d.completionStatus === 'COMPLETED' ? 'Undo' : 'Complete'}
                      </button>
                      <button
                        className="btn btn-sm"
                        disabled={busy}
                        onClick={() => {
                          reset();
                          setEditingId(d.id);
                          setDraft(toDraft(d));
                        }}
                      >
                        Edit
                      </button>
                      <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => setConfirmDelete(d.id)}>
                        Delete
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            )}

            {confirmDelete === d.id ? (
              <div className="mt-2 rounded border border-rose-200 bg-rose-50 px-3 py-2">
                <p className="text-[12.5px] text-rose-800">
                  Delete “{d.description}”? This cannot be undone. The deletion is recorded in the audit trail.
                </p>
                <input
                  className="input mt-1.5 w-full"
                  placeholder="Reason (optional)"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                <div className="mt-1.5 flex gap-2">
                  <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => remove(d.id)}>
                    {busy ? 'Deleting…' : 'Delete'}
                  </button>
                  <button className="btn btn-sm" disabled={busy} onClick={reset}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {canWrite ? (
        adding ? (
          <div className="mt-3 rounded border border-brand-200 bg-brand-50/40 px-3 py-2.5">
            <p className="mb-1.5 text-[12px] font-medium text-slate-700">New dependency</p>
            {fields}
            <div className="mt-2 flex gap-2">
              <button className="btn btn-primary btn-sm" disabled={busy} onClick={create}>
                {busy ? 'Adding…' : 'Add dependency'}
              </button>
              <button className="btn btn-sm" disabled={busy} onClick={reset}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            className="btn btn-sm mt-3"
            onClick={() => {
              reset();
              setAdding(true);
            }}
          >
            + Add dependency
          </button>
        )
      ) : null}
    </div>
  );
}
