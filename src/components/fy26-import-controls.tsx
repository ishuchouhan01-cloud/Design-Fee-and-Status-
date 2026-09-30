'use client';

/**
 * Admin-only import controls. Preview first; apply is a separate, explicit
 * action that sends `confirm: true` — the API refuses to write without it.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface ValidationRow {
  metric: string;
  expected: number;
  actual: number;
  difference: number;
  status: 'PASS' | 'FAIL';
}

export function ImportControls() {
  const router = useRouter();
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewed, setPreviewed] = useState<{ valid: boolean; validation: ValidationRow[] } | null>(null);
  const [confirming, setConfirming] = useState(false);

  const run = async (confirm: boolean) => {
    setBusy(confirm ? 'apply' : 'preview');
    setError(null);
    const res = await fetch('/api/fy26/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(null);
    setConfirming(false);
    if (!res.ok) {
      setError(json.error ?? 'Import failed');
      return;
    }
    if (!confirm) setPreviewed({ valid: json.valid, validation: json.validation });
    else setPreviewed(null);
    router.refresh();
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-sm" disabled={busy !== null} onClick={() => run(false)}>
          {busy === 'preview' ? 'Reading workbooks…' : 'Run preview (writes nothing)'}
        </button>
        {previewed?.valid ? (
          confirming ? (
            <>
              <span className="text-[12px] text-slate-700">
                Apply the import? Fields edited in the application will not be overwritten.
              </span>
              <button className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => run(true)}>
                {busy === 'apply' ? 'Importing…' : 'Yes, apply'}
              </button>
              <button className="btn btn-sm" disabled={busy !== null} onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button className="btn btn-primary btn-sm" onClick={() => setConfirming(true)}>
              Apply import…
            </button>
          )
        ) : null}
      </div>
      {previewed && !previewed.valid ? (
        <p className="text-[12px] text-rose-700">
          The preview did not validate — apply is withheld. Differences:{' '}
          {previewed.validation
            .filter((v) => v.status === 'FAIL')
            .map((v) => `${v.metric} expected ${v.expected}, got ${v.actual} (${v.difference > 0 ? '+' : ''}${v.difference})`)
            .join('; ')}
        </p>
      ) : null}
      {error ? <p className="text-[12px] text-rose-600">{error}</p> : null}
    </div>
  );
}
