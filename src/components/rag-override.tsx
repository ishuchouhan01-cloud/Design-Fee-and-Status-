'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { RAG_LABEL } from '@/lib/labels';

export function RagOverrideControl({
  entityId,
  calculated,
  current,
  overridden,
}: {
  entityId: string;
  calculated: string;
  current: string;
  overridden: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rag, setRag] = useState(current);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    const res = await fetch('/api/rag-override', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entityType: 'PROJECT', entityId, overrideRag: rag, reason }),
    });
    if (!res.ok) setError((await res.json().catch(() => ({}))).error ?? 'Failed');
    else {
      setOpen(false);
      router.refresh();
    }
    setBusy(false);
  };

  const clear = async () => {
    setBusy(true);
    const res = await fetch(`/api/rag-override?entityId=${entityId}`, { method: 'DELETE' });
    if (!res.ok) setError((await res.json().catch(() => ({}))).error ?? 'Failed');
    else router.refresh();
    setBusy(false);
  };

  if (!open) {
    return (
      <div className="flex items-center gap-1.5">
        <button className="btn btn-sm" onClick={() => setOpen(true)}>
          Override status
        </button>
        {overridden && (
          <button className="btn btn-sm" onClick={clear} disabled={busy}>
            Use calculated ({RAG_LABEL[calculated] ?? calculated})
          </button>
        )}
        {error && <span className="text-2xs text-rag-red">{error}</span>}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-end gap-2 rounded border border-line bg-surface-alt p-2">
      <div>
        <label className="label" htmlFor="rag-value">
          Management status
        </label>
        <select id="rag-value" className="select w-28" value={rag} onChange={(e) => setRag(e.target.value)}>
          {['GREEN', 'AMBER', 'RED', 'GREY'].map((r) => (
            <option key={r} value={r}>
              {RAG_LABEL[r]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="rag-reason">
          Reason (required)
        </label>
        <input id="rag-reason" className="input w-64" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <button className="btn btn-primary" disabled={busy || reason.trim().length < 3} onClick={save}>
        Save override
      </button>
      <button className="btn" onClick={() => setOpen(false)}>
        Cancel
      </button>
      <p className="w-full text-2xs text-ink-mute">
        The calculated value ({RAG_LABEL[calculated] ?? calculated}) is kept and shown alongside the override, together with who set it and when.
      </p>
      {error && <p className="w-full text-2xs text-rag-red">{error}</p>}
    </div>
  );
}
