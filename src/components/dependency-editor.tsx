'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function DependencyEditor({ options }: { options: { value: string; label: string }[] }) {
  const router = useRouter();
  const [pre, setPre] = useState('');
  const [suc, setSuc] = useState('');
  const [type, setType] = useState('FS');
  const [lag, setLag] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const add = async () => {
    setBusy(true);
    setError(null);
    setDone(false);
    const [predecessorType, predecessorId] = pre.split(':');
    const [successorType, successorId] = suc.split(':');
    const res = await fetch('/api/dependencies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ predecessorType, predecessorId, successorType, successorId, dependencyType: type, lagDays: lag }),
    });
    if (!res.ok) setError((await res.json().catch(() => ({}))).error ?? 'Could not add the link');
    else {
      setDone(true);
      router.refresh();
    }
    setBusy(false);
  };

  return (
    <div className="grid gap-2 md:grid-cols-5">
      <div className="md:col-span-2">
        <label className="label" htmlFor="dep-pre">
          Predecessor
        </label>
        <select id="dep-pre" className="select" value={pre} onChange={(e) => setPre(e.target.value)}>
          <option value="">Select…</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="dep-type">
          Type
        </label>
        <select id="dep-type" className="select" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="FS">Finish → Start</option>
          <option value="SS">Start → Start</option>
          <option value="FF">Finish → Finish</option>
        </select>
      </div>
      <div>
        <label className="label" htmlFor="dep-lag">
          Lag (days)
        </label>
        <input id="dep-lag" type="number" className="input" value={lag} onChange={(e) => setLag(Number(e.target.value))} />
      </div>
      <div className="md:col-span-2">
        <label className="label" htmlFor="dep-suc">
          Successor
        </label>
        <select id="dep-suc" className="select" value={suc} onChange={(e) => setSuc(e.target.value)}>
          <option value="">Select…</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-end gap-2 md:col-span-3">
        <button className="btn btn-primary" disabled={busy || !pre || !suc || pre === suc} onClick={add}>
          {busy ? 'Adding…' : 'Add link'}
        </button>
        {done && <span className="text-[12px] text-rag-green">Link added.</span>}
        {error && <span className="text-[12px] text-rag-red">{error}</span>}
      </div>
    </div>
  );
}
