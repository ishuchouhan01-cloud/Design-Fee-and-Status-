'use client';

import { useState } from 'react';

interface BackupInfo {
  name: string;
  bytes: number;
  createdAt: string;
}

export function BackupPanel({
  initial,
  info,
  toolVersion,
}: {
  initial: BackupInfo[];
  info: { directory: string; retention: number; databaseName: string; host: string };
  toolVersion?: string | null;
}) {
  const [backups, setBackups] = useState(initial);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    const res = await fetch('/api/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: label || undefined }),
    });
    const json = await res.json();
    if (!res.ok) setError(json.error ?? 'Backup failed');
    else {
      setMessage(`Created ${json.created.name} (${(json.created.bytes / 1024).toFixed(0)} KB)`);
      setBackups(
        json.backups.map((b: { name: string; bytes: number; createdAt: string }) => ({
          name: b.name,
          bytes: b.bytes,
          createdAt: b.createdAt,
        })),
      );
      setLabel('');
    }
    setBusy(false);
  };

  return (
    <div>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label className="label" htmlFor="backup-label">
            Label (optional)
          </label>
          <input
            id="backup-label"
            className="input"
            value={label}
            placeholder="e.g. before-q3-reforecast"
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <button className="btn btn-primary" onClick={run} disabled={busy || toolVersion === null}>
          {busy ? 'Backing up…' : 'Back up now'}
        </button>
      </div>
      <p className="mt-2 text-2xs leading-relaxed text-ink-mute">
        Dumps <span className="font-mono">{info.databaseName}</span> on{' '}
        <span className="font-mono">{info.host}</span> to <span className="font-mono">{info.directory}</span>; the
        newest {info.retention} are kept. Restore with{' '}
        <span className="font-mono">npm run restore -- --latest</span>.
        {toolVersion && <> Using <span className="font-mono">{toolVersion}</span>.</>}
      </p>
      {message && <p className="mt-2 text-[12px] text-rag-green">{message}</p>}
      {error && <p className="mt-2 text-[12px] text-rag-red">{error}</p>}
      <div className="mt-3 max-h-40 overflow-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Created</th>
              <th className="num">Size</th>
              <th>File</th>
            </tr>
          </thead>
          <tbody>
            {backups.map((b) => (
              <tr key={b.name}>
                <td className="whitespace-nowrap font-mono text-[11px]">{b.createdAt.slice(0, 19).replace('T', ' ')}</td>
                <td className="num">{(b.bytes / 1024).toFixed(0)} KB</td>
                <td className="max-w-[260px] truncate font-mono text-[11px]">{b.name}</td>
              </tr>
            ))}
            {backups.length === 0 && (
              <tr>
                <td colSpan={3} className="py-4 text-center text-ink-mute">
                  No backups yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
