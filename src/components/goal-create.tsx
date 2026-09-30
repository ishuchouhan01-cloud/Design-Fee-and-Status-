'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PRIORITY_LABEL, quarterLabel, yearLabel } from '@/lib/labels';

export function GoalCreateForm({
  projects,
  disciplines,
  leads,
  years,
}: {
  projects: { id: string; name: string }[];
  disciplines: { id: string; name: string }[];
  leads: { id: string; name: string }[];
  years: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    projectId: projects[0]?.id ?? '',
    disciplineId: '',
    designLeadId: '',
    goalDescription: '',
    fiscalYear: years[0] ?? 'FY26-27',
    quarter: 1,
    plannedQuantity: 1,
    plannedValue: 0,
    priority: 'MEDIUM',
    remarks: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button className="btn" onClick={() => setOpen(true)}>
        + New goal
      </button>
    );
  }

  const submit = async () => {
    setBusy(true);
    setError(null);
    const res = await fetch('/api/goals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        disciplineId: form.disciplineId || null,
        designLeadId: form.designLeadId || null,
        quarter: Number(form.quarter),
        plannedQuantity: Number(form.plannedQuantity),
        plannedValue: Number(form.plannedValue),
        remarks: form.remarks || undefined,
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? j.issues?.[0]?.message ?? 'Could not create the goal');
    } else {
      setOpen(false);
      router.refresh();
    }
    setBusy(false);
  };

  return (
    <div className="card card-pad">
      <p className="card-title mb-3">New goal</p>
      <div className="grid gap-2.5 md:grid-cols-4">
        <Field label="Project">
          <select className="select" value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Discipline">
          <select className="select" value={form.disciplineId} onChange={(e) => setForm({ ...form, disciplineId: e.target.value })}>
            <option value="">—</option>
            {disciplines.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Design lead">
          <select className="select" value={form.designLeadId} onChange={(e) => setForm({ ...form, designLeadId: e.target.value })}>
            <option value="">—</option>
            {leads.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Priority">
          <select className="select" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
            {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Description" className="md:col-span-2">
          <input
            className="input"
            value={form.goalDescription}
            onChange={(e) => setForm({ ...form, goalDescription: e.target.value })}
            placeholder="e.g. LoD 350 - Master Plan - Site Services"
          />
        </Field>
        <Field label="Period">
          <select className="select" value={form.fiscalYear} onChange={(e) => setForm({ ...form, fiscalYear: e.target.value })}>
            {years.map((y) => (
              <option key={y} value={y}>
                {yearLabel(y)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Quarter">
          <select className="select" value={form.quarter} onChange={(e) => setForm({ ...form, quarter: Number(e.target.value) })}>
            {[1, 2, 3, 4].map((q) => (
              <option key={q} value={q}>
                {quarterLabel(q)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Planned packages">
          <input
            type="number"
            className="input"
            value={form.plannedQuantity}
            onChange={(e) => setForm({ ...form, plannedQuantity: Number(e.target.value) })}
          />
        </Field>
        <Field label="Planned billing (₹ Cr)">
          <input
            type="number"
            step="0.01"
            className="input"
            value={form.plannedValue}
            onChange={(e) => setForm({ ...form, plannedValue: Number(e.target.value) })}
          />
        </Field>
        <Field label="Remarks" className="md:col-span-2">
          <input className="input" value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
        </Field>
      </div>
      <p className="mt-2 text-2xs text-ink-mute">
        The baseline target date is set to the end of the selected quarter and is then immutable. Completion follows
        from the delivered quantity, so there is no completion field here.
      </p>
      {error && <p className="mt-2 text-[12px] text-rag-red">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button className="btn btn-primary" disabled={busy || form.goalDescription.trim().length < 2} onClick={submit}>
          {busy ? 'Saving…' : 'Create goal'}
        </button>
        <button className="btn" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <span className="label">{label}</span>
      {children}
    </div>
  );
}
