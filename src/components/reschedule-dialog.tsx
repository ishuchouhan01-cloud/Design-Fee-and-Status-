'use client';

/**
 * Reschedule dialog. Two-step by construction: the first request is a preview
 * that writes nothing, and APPLY is only enabled once the impact has been
 * fetched and shown (spec §13, §37, §43).
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';

type EntityType = 'GOAL' | 'DELIVERABLE' | 'DRAWING' | 'PACKAGE';

interface PlannedChange {
  entityType: EntityType;
  entityId: string;
  code: string;
  label: string;
  oldDate: string | null;
  newDate: string;
  shiftDays: number;
  cascaded: boolean;
  dependencyType?: string;
  lagDays?: number;
}

interface Impact {
  directChanges: PlannedChange[];
  cascadedChanges: PlannedChange[];
  skipped: { code: string; reason: string }[];
  affectedSuccessors: number;
  affectedGoalIds: string[];
  affectedPackageIds: string[];
  affectedProjectIds: string[];
  maxShiftDays: number;
  projectForecast: { projectId: string; beforeCompletion: string | null; afterCompletion: string | null; shiftDays: number }[];
  quarterImpact: { period: string; before: number; after: number; delta: number }[];
  totalRecords: number;
}

const SCOPES: { value: string; label: string; hint: string }[] = [
  { value: 'ITEM', label: 'Selected item(s)', hint: 'Only what you picked' },
  { value: 'SELECTION', label: 'Current selection', hint: 'Same as selected items' },
  { value: 'PACKAGE', label: 'Whole package', hint: 'Every incomplete item in the package' },
  { value: 'DISCIPLINE', label: 'Whole discipline', hint: 'Every incomplete item of that discipline in the project' },
  { value: 'GOAL', label: 'Whole goal', hint: 'Every incomplete item under the goal' },
  { value: 'PROJECT', label: 'Whole project', hint: 'Every incomplete item in the project' },
];

function fmt(d: string | null | undefined) {
  if (!d) return '—';
  const dt = new Date(d);
  return `${String(dt.getUTCDate()).padStart(2, '0')}-${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][dt.getUTCMonth()]}-${dt.getUTCFullYear()}`;
}

export function RescheduleButton({
  entityType,
  ids,
  currentExpected,
  projectId,
  packageId,
  disciplineId,
  goalId,
  label,
  className,
  buttonLabel,
  defaultScope,
}: {
  entityType: EntityType;
  ids: string[];
  currentExpected?: string | null;
  projectId?: string | null;
  packageId?: string | null;
  disciplineId?: string | null;
  goalId?: string | null;
  label?: string;
  className?: string;
  buttonLabel?: string;
  defaultScope?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // A scope target with no explicit ids means "everything in that scope", which
  // is resolved server-side; that mode is a uniform shift, not a single date.
  const scopeOnly = ids.length === 0;
  const initialScope = defaultScope ?? (scopeOnly ? (packageId ? 'PACKAGE' : disciplineId ? 'DISCIPLINE' : goalId ? 'GOAL' : 'PROJECT') : 'ITEM');
  const [mode, setMode] = useState<'DATE' | 'SHIFT'>(ids.length === 1 ? 'DATE' : 'SHIFT');
  const [newDate, setNewDate] = useState(() => {
    if (!currentExpected) return '';
    const d = new Date(currentExpected);
    d.setUTCDate(d.getUTCDate() + 14);
    return d.toISOString().slice(0, 10);
  });
  const [shiftDays, setShiftDays] = useState(7);
  const [reason, setReason] = useState('');
  const [scope, setScope] = useState(initialScope);
  const [options, setOptions] = useState({
    preserveCompletedDates: true,
    recalculateDependents: true,
    updateForecast: true,
    recordHistory: true,
  });
  const [impact, setImpact] = useState<Impact | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);

  const body = (confirm: boolean) => ({
    entityType,
    ids,
    newExpectedDate: mode === 'DATE' ? newDate : null,
    shiftDays: mode === 'SHIFT' ? shiftDays : null,
    reason,
    scope,
    projectId: projectId ?? null,
    packageId: packageId ?? null,
    disciplineId: disciplineId ?? null,
    goalId: goalId ?? null,
    options,
    confirm,
  });

  const run = async (confirm: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/reschedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body(confirm)),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? 'Request failed');
        setBusy(false);
        return;
      }
      if (json.mode === 'PREVIEW') {
        setImpact(json.impact);
      } else {
        setApplied(`${json.applied} item(s) moved, ${json.cascaded} dependent item(s) recalculated.`);
        setImpact(json.impact);
        router.refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  const reset = () => {
    setOpen(false);
    setImpact(null);
    setApplied(null);
    setError(null);
    setReason('');
  };

  const hasTarget = ids.length > 0 || Boolean(projectId || packageId || disciplineId || goalId);
  if (!open) {
    return (
      <button className={className ?? 'btn btn-sm'} onClick={() => setOpen(true)} disabled={!hasTarget}>
        {buttonLabel ?? 'Reschedule'}
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-slate-900/40 p-6">
      <div className="w-full max-w-3xl rounded-lg border border-line bg-surface shadow-xl">
        <header className="flex items-start justify-between border-b border-line px-5 py-3">
          <div>
            <h2 className="text-[15px] font-semibold">Reschedule</h2>
            <p className="mt-0.5 text-2xs text-ink-mute">
              {label ?? `${ids.length} ${entityType.toLowerCase()}(s) selected`} · baseline dates are never changed
            {scopeOnly ? ' · scope resolved when you calculate the impact' : ''}
            </p>
          </div>
          <button className="btn btn-sm" onClick={reset}>
            Close
          </button>
        </header>

        <div className="grid gap-4 px-5 py-4 md:grid-cols-2">
          <div className="space-y-3">
            <div>
              <span className="label">Move by</span>
              <div className="flex gap-2">
                <button
                  className={`btn btn-sm ${mode === 'DATE' ? 'btn-primary' : ''}`}
                  onClick={() => setMode('DATE')}
                  disabled={scopeOnly}
                  title={scopeOnly ? 'A scope-wide reschedule uses a uniform shift, not one shared date' : undefined}
                >
                  To a date
                </button>
                <button
                  className={`btn btn-sm ${mode === 'SHIFT' ? 'btn-primary' : ''}`}
                  onClick={() => setMode('SHIFT')}
                >
                  By days
                </button>
              </div>
            </div>

            {currentExpected && (
              <p className="text-[12px]">
                <span className="text-ink-mute">Current expected release:</span>{' '}
                <span className="font-mono font-semibold">{fmt(currentExpected)}</span>
              </p>
            )}

            {mode === 'DATE' ? (
              <div>
                <label className="label" htmlFor="rs-date">
                  New expected release
                </label>
                <input
                  id="rs-date"
                  type="date"
                  className="input"
                  value={newDate}
                  onChange={(e) => {
                    setNewDate(e.target.value);
                    setImpact(null);
                  }}
                />
              </div>
            ) : (
              <div>
                <label className="label" htmlFor="rs-shift">
                  Shift (days — negative pulls work earlier)
                </label>
                <input
                  id="rs-shift"
                  type="number"
                  className="input"
                  value={shiftDays}
                  onChange={(e) => {
                    setShiftDays(Number(e.target.value));
                    setImpact(null);
                  }}
                />
              </div>
            )}

            <div>
              <label className="label" htmlFor="rs-reason">
                Reason (required, recorded in the reschedule history)
              </label>
              <textarea
                id="rs-reason"
                className="input h-16"
                value={reason}
                placeholder="e.g. Client design information delayed"
                onChange={(e) => {
                  setReason(e.target.value);
                  setImpact(null);
                }}
              />
            </div>

            <div>
              <label className="label" htmlFor="rs-scope">
                Scope
              </label>
              <select
                id="rs-scope"
                className="select"
                value={scope}
                onChange={(e) => {
                  setScope(e.target.value);
                  setImpact(null);
                }}
              >
                {SCOPES.filter((s) => s.value !== 'GOAL' || entityType === 'DELIVERABLE').map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label} — {s.hint}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <span className="label">Options</span>
              <div className="space-y-1.5">
                {(
                  [
                    ['preserveCompletedDates', 'Preserve completed dates'],
                    ['recalculateDependents', 'Recalculate dependent dates'],
                    ['updateForecast', 'Update forecast'],
                    ['recordHistory', 'Record in reschedule history'],
                  ] as const
                ).map(([key, text]) => (
                  <label key={key} className="flex items-center gap-2 text-[12px]">
                    <input
                      type="checkbox"
                      checked={options[key]}
                      onChange={(e) => {
                        setOptions({ ...options, [key]: e.target.checked });
                        setImpact(null);
                      }}
                    />
                    {text}
                  </label>
                ))}
              </div>
            </div>

            <div className="rounded border border-line bg-surface-alt p-3">
              <p className="card-title">Reschedule impact</p>
              {!impact ? (
                <p className="mt-2 text-[12px] text-ink-mute">
                  Nothing has been changed. Fill in the reason and a date or shift, then calculate the impact.
                </p>
              ) : (
                <dl className="mt-2 space-y-1 text-[12px]">
                  <Row k="Items moved" v={String(impact.directChanges.length)} />
                  <Row k="Affected successors" v={String(impact.affectedSuccessors)} />
                  <Row k="Affected goals" v={String(impact.affectedGoalIds.length)} />
                  <Row k="Affected packages" v={String(impact.affectedPackageIds.length)} />
                  <Row k="Largest shift" v={`${impact.maxShiftDays >= 0 ? '+' : ''}${impact.maxShiftDays} days`} />
                  {impact.projectForecast.map((p) => (
                    <Row
                      key={p.projectId}
                      k="Project forecast"
                      v={`${fmt(p.beforeCompletion)} → ${fmt(p.afterCompletion)} (${p.shiftDays >= 0 ? '+' : ''}${p.shiftDays}d)`}
                    />
                  ))}
                  {impact.quarterImpact.map((q) => (
                    <Row
                      key={q.period}
                      k={`Quarter ${q.period}`}
                      v={`${q.before} → ${q.after} (${q.delta >= 0 ? '+' : ''}${q.delta})`}
                    />
                  ))}
                  {impact.skipped.length > 0 && (
                    <Row k="Not moved" v={`${impact.skipped.length} (completed or already on that date)`} />
                  )}
                </dl>
              )}
            </div>
          </div>
        </div>

        {impact && (impact.directChanges.length > 0 || impact.cascadedChanges.length > 0) && (
          <div className="max-h-56 overflow-auto border-t border-line px-5 py-3">
            <table className="table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>From</th>
                  <th>To</th>
                  <th className="num">Shift</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {[...impact.directChanges, ...impact.cascadedChanges].slice(0, 200).map((c) => (
                  <tr key={`${c.entityType}-${c.entityId}`}>
                    <td className="max-w-[260px] truncate" title={`${c.code} — ${c.label}`} data-record>
                      {c.code} — {c.label}
                    </td>
                    <td className="font-mono">{fmt(c.oldDate)}</td>
                    <td className="font-mono font-semibold">{fmt(c.newDate)}</td>
                    <td className="num">
                      {c.shiftDays >= 0 ? '+' : ''}
                      {c.shiftDays}d
                    </td>
                    <td className="text-ink-mute">
                      {c.cascaded ? `dependency ${c.dependencyType ?? 'FS'}${c.lagDays ? ` ${c.lagDays}d lag` : ''}` : 'selected'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {impact && impact.skipped.length > 0 && (
          <div className="border-t border-line bg-amber-50 px-5 py-2.5 text-[12px] text-amber-900">
            <strong>{impact.skipped.length} item(s) will not move.</strong>{' '}
            {impact.skipped
              .slice(0, 4)
              .map((s) => `${s.code}: ${s.reason}`)
              .join(' · ')}
            {impact.skipped.length > 4 && ' …'}
          </div>
        )}

        {error && <div className="border-t border-line bg-red-50 px-5 py-2.5 text-[12px] text-rag-red">{error}</div>}
        {applied && (
          <div className="border-t border-line bg-emerald-50 px-5 py-2.5 text-[12px] text-rag-green">{applied}</div>
        )}

        <footer className="flex items-center justify-end gap-2 border-t border-line bg-surface-alt px-5 py-3">
          <button className="btn" onClick={reset}>
            {applied ? 'Done' : 'Cancel'}
          </button>
          {!applied && (
            <>
              <button
                className="btn"
                disabled={busy || reason.trim().length < 3 || (mode === 'DATE' && !newDate)}
                onClick={() => run(false)}
              >
                {busy ? 'Calculating…' : 'Calculate impact'}
              </button>
              <button className="btn btn-primary" disabled={busy || !impact || impact.totalRecords === 0} onClick={() => run(true)}>
                Apply reschedule
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-mute">{k}</dt>
      <dd className="font-mono font-semibold tabular-nums">{v}</dd>
    </div>
  );
}
