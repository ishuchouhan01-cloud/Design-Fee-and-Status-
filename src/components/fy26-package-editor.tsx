'use client';

/**
 * Package editor for Design Goals FY 26.
 *
 * Two things are deliberately absent:
 *   - any billing *date* field — the source workbooks have billing amounts and
 *     one release date, and a billing date is never derived from either;
 *   - the original (baseline) release date as an input — it is shown read-only,
 *     and the API rejects it outright.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface PackageEditable {
  id: string;
  packageDescription: string;
  fy26PhaseId: string | null;
  disciplineId: string | null;
  responsibleUserId: string | null;
  baselineReleaseDate: string | null;
  currentExpectedReleaseDate: string | null;
  actualReleaseDate: string | null;
  planBillingCr: number | null;
  actualBillingCr: number | null;
  plannedPackageQuantity: number | null;
  actualPackageQuantity: number | null;
  remarks: string | null;
  completionStatus: string;
}

export interface Option {
  value: string;
  label: string;
}

function dateInput(v: string | null): string {
  return v ? v.slice(0, 10) : '';
}

function numInput(v: number | null): string {
  return v == null ? '' : String(v);
}

export function PackageEditor({
  pkg,
  phases,
  disciplines,
  responsibles,
  canWrite,
}: {
  pkg: PackageEditable;
  phases: Option[];
  disciplines: Option[];
  responsibles: Option[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [form, setForm] = useState({
    packageDescription: pkg.packageDescription,
    fy26PhaseId: pkg.fy26PhaseId ?? '',
    disciplineId: pkg.disciplineId ?? '',
    responsibleUserId: pkg.responsibleUserId ?? '',
    currentExpectedReleaseDate: dateInput(pkg.currentExpectedReleaseDate),
    actualReleaseDate: dateInput(pkg.actualReleaseDate),
    planBillingCr: numInput(pkg.planBillingCr),
    actualBillingCr: numInput(pkg.actualBillingCr),
    plannedPackageQuantity: numInput(pkg.plannedPackageQuantity),
    actualPackageQuantity: numInput(pkg.actualPackageQuantity),
    remarks: pkg.remarks ?? '',
  });

  const set = (k: keyof typeof form, v: string) => setForm({ ...form, [k]: v });

  const save = async () => {
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = {
      packageDescription: form.packageDescription.trim(),
      fy26PhaseId: form.fy26PhaseId || null,
      disciplineId: form.disciplineId || null,
      responsibleUserId: form.responsibleUserId || null,
      currentExpectedReleaseDate: form.currentExpectedReleaseDate || null,
      actualReleaseDate: form.actualReleaseDate || null,
      planBillingCr: form.planBillingCr === '' ? null : Number(form.planBillingCr),
      actualBillingCr: form.actualBillingCr === '' ? null : Number(form.actualBillingCr),
      plannedPackageQuantity: form.plannedPackageQuantity === '' ? null : Number(form.plannedPackageQuantity),
      actualPackageQuantity: form.actualPackageQuantity === '' ? null : Number(form.actualPackageQuantity),
      remarks: form.remarks.trim() || null,
    };
    if (reason.trim()) body.reason = reason.trim();

    const res = await fetch(`/api/fy26/packages/${pkg.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setError(json.error ?? 'Update failed');
      return;
    }
    setOpen(false);
    setReason('');
    router.refresh();
  };

  const toggleCompletion = async () => {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/fy26/packages/${pkg.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        completionStatus: pkg.completionStatus === 'COMPLETED' ? 'NOT_COMPLETED' : 'COMPLETED',
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setError(json.error ?? 'Update failed');
      return;
    }
    router.refresh();
  };

  if (!canWrite) return null;

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
          Edit package
        </button>
        <button className="btn btn-sm" disabled={busy} onClick={toggleCompletion}>
          {pkg.completionStatus === 'COMPLETED' ? 'Mark NOT completed' : 'Mark completed'}
        </button>
        {error ? <span className="text-[12px] text-rose-600">{error}</span> : null}
      </div>
    );
  }

  return (
    <div className="rounded border border-brand-200 bg-brand-50/40 px-4 py-3">
      <div className="grid gap-2.5 md:grid-cols-12">
        <label className="md:col-span-6">
          <span className="label">Description</span>
          <input
            className="input w-full"
            value={form.packageDescription}
            onChange={(e) => set('packageDescription', e.target.value)}
          />
        </label>
        <label className="md:col-span-3">
          <span className="label">Phase</span>
          <select className="select w-full" value={form.fy26PhaseId} onChange={(e) => set('fy26PhaseId', e.target.value)}>
            <option value="">— none —</option>
            {phases.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="md:col-span-3">
          <span className="label">Discipline</span>
          <select
            className="select w-full"
            value={form.disciplineId}
            onChange={(e) => set('disciplineId', e.target.value)}
          >
            <option value="">— none —</option>
            {disciplines.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </label>

        <label className="md:col-span-3">
          <span className="label">Responsible</span>
          <select
            className="select w-full"
            value={form.responsibleUserId}
            onChange={(e) => set('responsibleUserId', e.target.value)}
          >
            <option value="">— none —</option>
            {responsibles.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <div className="md:col-span-3">
          <span className="label">Original release date</span>
          <p className="mt-1 rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-[12.5px] text-slate-600">
            {dateInput(pkg.baselineReleaseDate) || '—'}
            <span className="ml-1.5 text-[11px] text-slate-400">immutable</span>
          </p>
        </div>
        <label className="md:col-span-3">
          <span className="label">Current expected release</span>
          <input
            type="date"
            className="input w-full"
            value={form.currentExpectedReleaseDate}
            onChange={(e) => set('currentExpectedReleaseDate', e.target.value)}
          />
        </label>
        <label className="md:col-span-3">
          <span className="label">Actual release</span>
          <input
            type="date"
            className="input w-full"
            value={form.actualReleaseDate}
            onChange={(e) => set('actualReleaseDate', e.target.value)}
          />
        </label>

        <label className="md:col-span-3">
          <span className="label">Plan billing [Cr.]</span>
          <input
            type="number"
            step="0.0001"
            className="input w-full"
            value={form.planBillingCr}
            onChange={(e) => set('planBillingCr', e.target.value)}
          />
        </label>
        <label className="md:col-span-3">
          <span className="label">Actual billing [Cr.]</span>
          <input
            type="number"
            step="0.0001"
            className="input w-full"
            value={form.actualBillingCr}
            onChange={(e) => set('actualBillingCr', e.target.value)}
          />
        </label>
        <label className="md:col-span-3">
          <span className="label">Planned package qty</span>
          <input
            type="number"
            className="input w-full"
            value={form.plannedPackageQuantity}
            onChange={(e) => set('plannedPackageQuantity', e.target.value)}
          />
        </label>
        <label className="md:col-span-3">
          <span className="label">Actual package qty</span>
          <input
            type="number"
            className="input w-full"
            value={form.actualPackageQuantity}
            onChange={(e) => set('actualPackageQuantity', e.target.value)}
          />
        </label>

        <label className="md:col-span-12">
          <span className="label">Remarks</span>
          <input className="input w-full" value={form.remarks} onChange={(e) => set('remarks', e.target.value)} />
        </label>
        <label className="md:col-span-12">
          <span className="label">Reason for the audit trail</span>
          <input className="input w-full" value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
      </div>

      {error ? <p className="mt-2 text-[12px] text-rose-600">{error}</p> : null}

      <div className="mt-3 flex gap-2">
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
        <button className="btn btn-sm" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <p className="mt-2 text-[11.5px] text-slate-500">
        Every field you change is written to the audit trail, and the next Excel import will not overwrite it.
      </p>
    </div>
  );
}
