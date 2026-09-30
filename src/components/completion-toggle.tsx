'use client';

/**
 * The only completion control in the application: two states, no slider, no
 * percentage field. Marking complete defaults the actual release date to today
 * and lets the user override it.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function CompletionToggle({
  entityType,
  id,
  status,
  actualDate,
  compact,
}: {
  entityType: 'DELIVERABLE' | 'DRAWING';
  id: string;
  status: string;
  actualDate?: string | null;
  compact?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDate, setShowDate] = useState(false);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));

  const endpoint = entityType === 'DELIVERABLE' ? '/api/deliverables' : '/api/drawings';

  const send = async (payload: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    const res = await fetch(`${endpoint}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setError(json.error ?? 'Update failed');
    } else {
      setShowDate(false);
      router.refresh();
    }
    setBusy(false);
  };

  if (status === 'COMPLETED') {
    return (
      <div className="flex flex-col gap-1">
        <button
          className="btn btn-sm"
          disabled={busy}
          onClick={() => send({ completionStatus: 'NOT_COMPLETED' })}
          title={`Actual release ${actualDate?.slice(0, 10) ?? '—'} — reverting clears it and is recorded in the audit trail`}
        >
          {busy ? '…' : 'Mark pending'}
        </button>
        {error && <span className="text-2xs text-rag-red">{error}</span>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {showDate ? (
        <div className="flex items-center gap-1">
          <input type="date" className="input w-32" value={date} onChange={(e) => setDate(e.target.value)} />
          <button
            className="btn btn-sm btn-primary"
            disabled={busy}
            onClick={() => send({ completionStatus: 'COMPLETED', actualReleaseDate: date })}
          >
            Save
          </button>
          <button className="btn btn-sm" onClick={() => setShowDate(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <button
            className="btn btn-sm btn-primary"
            disabled={busy}
            onClick={() => send({ completionStatus: 'COMPLETED' })}
          >
            {busy ? '…' : 'Mark completed'}
          </button>
          {!compact && (
            <button className="btn btn-sm" onClick={() => setShowDate(true)} title="Choose the actual release date">
              date…
            </button>
          )}
        </div>
      )}
      {error && <span className="text-2xs text-rag-red">{error}</span>}
    </div>
  );
}
