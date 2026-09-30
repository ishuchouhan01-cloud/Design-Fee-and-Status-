'use client';

/**
 * Update Centre grid: multi-select rows, then apply one bulk action. Bulk
 * requests are validated as a whole server-side before anything is written.
 */
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { RescheduleButton } from './reschedule-dialog';

export interface UpdateRow {
  id: string;
  code: string;
  description: string;
  projectName: string | null;
  packageCode: string | null;
  disciplineName: string | null;
  baseline: string | null;
  expected: string | null;
  actual: string | null;
  completionStatus: string;
  scheduleStatus: string;
  revision: string | null;
  owner: string | null;
  remarks: string | null;
}

type Action =
  | 'MARK_COMPLETED'
  | 'MARK_NOT_COMPLETED'
  | 'CHANGE_EXPECTED_DATE'
  | 'CHANGE_OWNER'
  | 'ADD_REMARK'
  | 'CHANGE_REVISION';

const ACTIONS: { value: Action; label: string; needs?: 'date' | 'owner' | 'remark' | 'revision' | 'actual' }[] = [
  { value: 'MARK_COMPLETED', label: 'Mark COMPLETED', needs: 'actual' },
  { value: 'MARK_NOT_COMPLETED', label: 'Mark NOT COMPLETED' },
  { value: 'CHANGE_EXPECTED_DATE', label: 'Change expected date', needs: 'date' },
  { value: 'CHANGE_OWNER', label: 'Change owner', needs: 'owner' },
  { value: 'ADD_REMARK', label: 'Add remark', needs: 'remark' },
  { value: 'CHANGE_REVISION', label: 'Change revision', needs: 'revision' },
];

function fmt(d: string | null) {
  if (!d) return '—';
  const dt = new Date(d);
  return `${String(dt.getUTCDate()).padStart(2, '0')}-${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][dt.getUTCMonth()]}-${String(dt.getUTCFullYear()).slice(2)}`;
}

export function UpdateGrid({
  entityType,
  rows,
  owners,
}: {
  entityType: 'DELIVERABLE' | 'DRAWING';
  rows: UpdateRow[];
  owners: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [action, setAction] = useState<Action>('MARK_COMPLETED');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [ownerId, setOwnerId] = useState('');
  const [remark, setRemark] = useState('');
  const [revision, setRevision] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const def = ACTIONS.find((a) => a.value === action)!;
  const ids = useMemo(() => [...selected], [selected]);
  const allSelected = rows.length > 0 && ids.length === rows.length;

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    const payload: Record<string, unknown> = { entityType, ids, action, reason: reason || undefined };
    if (def.needs === 'date') payload.expectedDate = date;
    if (def.needs === 'actual') payload.actualReleaseDate = date;
    if (def.needs === 'owner') payload.ownerId = ownerId || null;
    if (def.needs === 'remark') payload.remark = remark;
    if (def.needs === 'revision') payload.revision = revision;
    const res = await fetch('/api/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!res.ok) {
      setError(json.validation?.join(' ') ?? json.error ?? 'Bulk update failed');
    } else {
      setResult(
        `${json.applied} record(s) updated, ${json.unchanged} already in that state, ${json.rejected.length} rejected.`,
      );
      setSelected(new Set());
      router.refresh();
    }
    setBusy(false);
  };

  return (
    <>
      <div className="card sticky top-0 z-20 mb-3 flex flex-wrap items-end gap-2.5 px-4 py-3">
        <p className="mr-2 text-[12px]">
          <span className="font-mono text-[15px] font-semibold">{ids.length}</span>
          <span className="ml-1 text-ink-mute">selected</span>
        </p>
        <div>
          <label className="label" htmlFor="bulk-action">
            Bulk action
          </label>
          <select
            id="bulk-action"
            className="select w-56"
            value={action}
            onChange={(e) => setAction(e.target.value as Action)}
          >
            {ACTIONS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
        {(def.needs === 'date' || def.needs === 'actual') && (
          <div>
            <label className="label" htmlFor="bulk-date">
              {def.needs === 'actual' ? 'Actual release date' : 'New expected date'}
            </label>
            <input id="bulk-date" type="date" className="input w-40" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        )}
        {def.needs === 'owner' && (
          <div>
            <label className="label" htmlFor="bulk-owner">
              Owner
            </label>
            <select id="bulk-owner" className="select w-44" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
              <option value="">(clear owner)</option>
              {owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {def.needs === 'remark' && (
          <div>
            <label className="label" htmlFor="bulk-remark">
              Remark
            </label>
            <input id="bulk-remark" className="input w-64" value={remark} onChange={(e) => setRemark(e.target.value)} />
          </div>
        )}
        {def.needs === 'revision' && (
          <div>
            <label className="label" htmlFor="bulk-rev">
              Revision
            </label>
            <input id="bulk-rev" className="input w-24" value={revision} onChange={(e) => setRevision(e.target.value)} />
          </div>
        )}
        <div>
          <label className="label" htmlFor="bulk-reason">
            Reason (optional, goes to the audit trail)
          </label>
          <input id="bulk-reason" className="input w-56" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <button className="btn btn-primary" disabled={busy || ids.length === 0} onClick={submit}>
          {busy ? 'Applying…' : `Apply to ${ids.length}`}
        </button>
        <RescheduleButton entityType={entityType} ids={ids} label={`${ids.length} selected`} buttonLabel="Reschedule selected" />
        {result && <p className="w-full text-[12px] text-rag-green">{result}</p>}
        {error && <p className="w-full text-[12px] text-rag-red">{error}</p>}
      </div>

      <div className="card" >
        <div className="overflow-auto" style={{ maxHeight: '62vh' }}>
          <table className="table">
            <thead>
              <tr>
                <th className="w-8">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
                    aria-label="Select all rows on this page"
                  />
                </th>
                <th>Code</th>
                <th>Description</th>
                <th>Project</th>
                <th>Package</th>
                <th>Discipline</th>
                <th>Baseline</th>
                <th>Expected</th>
                <th>Actual</th>
                <th>Completion</th>
                <th>Revision</th>
                <th>Owner</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={selected.has(r.id) ? 'bg-brand-50' : undefined}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={() => toggle(r.id)}
                      aria-label={`Select ${r.code}`}
                    />
                  </td>
                  <td className="font-mono text-[11px]">{r.code}</td>
                  <td className="max-w-[300px] truncate" title={r.description}>
                    {r.description}
                  </td>
                  <td className="text-ink-mute">{r.projectName ?? '—'}</td>
                  <td className="text-ink-mute">{r.packageCode ?? '—'}</td>
                  <td className="text-ink-mute">{r.disciplineName ?? '—'}</td>
                  <td className="font-mono text-[11px] text-ink-mute">{fmt(r.baseline)}</td>
                  <td className="font-mono text-[11px] font-semibold">{fmt(r.expected)}</td>
                  <td className="font-mono text-[11px]">{fmt(r.actual)}</td>
                  <td>
                    <span
                      className={`pill ${r.completionStatus === 'COMPLETED' ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-700'}`}
                    >
                      {r.completionStatus === 'COMPLETED' ? 'COMPLETED' : 'NOT COMPLETED'}
                    </span>
                  </td>
                  <td className="font-mono text-[11px]">{r.revision ?? '—'}</td>
                  <td className="text-ink-mute">{r.owner ?? '—'}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={12} className="py-6 text-center text-ink-mute">
                    No records match the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
