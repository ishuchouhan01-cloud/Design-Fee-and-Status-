'use client';

/**
 * The Project Drawing Status table.
 *
 *   Name | Responsible Person | Package Status | Release Date | Packages Complete | Drawings Released | Total · Billed · Unbilled
 *
 * Rows load when opened (counted in SQL, so every figure is current). A
 * discipline row opens into its drawings, in the same column grid. In Edit
 * Mode cells become editable in place (Save / Cancel) and each row has an
 * actions menu (add, dependencies, archive). Every save goes through the
 * existing APIs; afterwards the open part of the table is loaded again, so
 * status, roll-ups and billing are recomputed at once.
 * Keyboard: Enter / Space toggle a row, → opens, ← closes.
 */
import clsx from 'clsx';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DFS_LABEL, DFS_TOOLTIP, packageStatusLabel, releaseLabel } from '@/lib/labels';
import { formatCrore, formatDate, formatNumber, formatOf } from '@/lib/format';
import type { DfsRow } from '@/lib/services/dfs';
import { markDirty } from '@/components/edit-state';

// ---------------------------------------------------------------------------
// Types and fetching
// ---------------------------------------------------------------------------

interface DrawingLine {
  id: string;
  drawingName: string;
  drawingCode: string;
  numberStatus: string;
  partialNumber: string | null;
  revision: string | null;
  disciplineId: string | null;
  disciplineName: string | null;
  projectId: string;
  packageId: string | null;
  responsible: string | null;
  expectedDate: string | null;
  updatedOnText: string;
  completionStatus: string;
}

interface DrawingPage {
  rows: DrawingLine[];
  total: number;
  page: number;
  pageCount: number;
}

type Billing = { total: number; billed: number; unbilled: number } | null;
export type StatusTotals = { packagesComplete: number; packagesPending: number; packagesNa: number; packagesTotal: number; drawingsReleased: number; drawingsTotal: number; billing?: Billing };

interface Reference {
  disciplines: { id: string; code: string; name: string; group: string | null }[];
  people: string[];
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as T;
}

/** A write through the existing APIs; the server's plain message on failure. */
async function send(url: string, method: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as { error?: string; issues?: { message?: string }[] };
  if (!res.ok) throw new Error(data.error ?? `The change could not be saved (${res.status}).`);
  return data;
}

const today = () => new Date().toISOString().slice(0, 10);
const isoDay = (v: string | null) => (v ? v.slice(0, 10) : '');

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

const CHIP = {
  COMPLETE: 'bg-emerald-50 text-emerald-800 ring-emerald-300',
  NOT_COMPLETE: 'bg-amber-50 text-amber-900 ring-amber-300',
  NA: 'bg-slate-100 text-slate-600 ring-slate-300',
} as const;

function Chip({ status }: { status: string }) {
  const tone = status === 'COMPLETE' || status === 'COMPLETED' ? CHIP.COMPLETE : status === 'NA' ? CHIP.NA : CHIP.NOT_COMPLETE;
  const label = status === 'COMPLETED' || status === 'NOT_COMPLETED' ? releaseLabel(status) : packageStatusLabel(status);
  return <span className={clsx('inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-2xs font-medium ring-1', tone)}>{label}</span>;
}

/** Project and tower rows: complete and pending only (Not Applicable is not counted there). */
export function aggregateStatus(r: Pick<DfsRow, 'packagesComplete' | 'packagesPending'>) {
  return `${formatNumber(r.packagesComplete)} complete · ${formatNumber(r.packagesPending)} pending`;
}

const INDENT = 1.25;
const padFor = (depth: number) => `${0.75 + depth * INDENT}rem`;

/** Row tint by level: projects, towers and headings are shaded; packages and below are plain. */
function tintOf(r: DfsRow) {
  if (r.kind === 'PROJECT' && r.depth === 0) return 'bg-slate-100';
  if (r.kind === 'PROJECT') return 'bg-slate-50';
  if (r.kind === 'NODE') return 'bg-slate-50/60';
  return 'bg-white';
}

const CELL = 'border-b border-r border-line/80 px-2.5 py-1.5 align-top';
const NUM = 'text-right tabular-nums whitespace-nowrap';

function Guides({ depth }: { depth: number }) {
  return (
    <>
      {Array.from({ length: depth }, (_, i) => (
        <span key={i} aria-hidden="true" className="pointer-events-none absolute inset-y-0 border-l border-slate-200" style={{ left: `${0.75 + i * INDENT + 0.3}rem` }} />
      ))}
    </>
  );
}

function money(v: number | undefined) {
  return v == null ? '—' : formatCrore(v, { symbol: false });
}

// ---------------------------------------------------------------------------
// Inline editing
// ---------------------------------------------------------------------------

type Field = { key: string; label: string; type?: 'text' | 'date' | 'number' | 'select'; value: string; options?: { value: string; label: string }[]; list?: string; required?: boolean; width?: string };

/**
 * A value that becomes a small form in Edit Mode: click, change, Save / Cancel.
 * Outside Edit Mode it is plain text.
 */
function Editable({
  enabled,
  display,
  fields,
  onSave,
  label,
  align = 'left',
}: {
  enabled: boolean;
  display: ReactNode;
  fields: Field[];
  onSave: (values: Record<string, string>) => Promise<void>;
  label: string;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const start = () => {
    setValues(Object.fromEntries(fields.map((f) => [f.key, f.value])));
    setError(null);
    setOpen(true);
  };
  const close = () => setOpen(false);
  // An open editor counts as unsaved until it is saved or cancelled.
  useEffect(() => {
    if (!open) return;
    markDirty(true);
    return () => markDirty(false);
  }, [open]);
  if (!enabled) return <>{display}</>;
  if (!open) {
    return (
      <button
        type="button"
        onClick={start}
        className={clsx('w-full rounded-sm border-b border-dashed border-slate-300 hover:border-brand-500 hover:bg-brand-50/60', align === 'right' ? 'text-right' : 'text-left')}
        aria-label={`Edit ${label}`}
        title={`Edit ${label}`}
      >
        {display}
      </button>
    );
  }
  return (
    <form
      className="flex flex-wrap items-center gap-1"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await onSave(values);
          close();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') close();
      }}
    >
      {fields.map((f, i) =>
        f.type === 'select' ? (
          <select
            key={f.key}
            aria-label={f.label}
            className="select h-7 py-0.5"
            style={{ width: f.width }}
            value={values[f.key] ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            autoFocus={i === 0}
          >
            {f.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            key={f.key}
            aria-label={f.label}
            placeholder={f.label}
            type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
            step={f.type === 'number' ? '0.0001' : undefined}
            min={f.type === 'number' ? '0' : undefined}
            list={f.list}
            required={f.required}
            className="input h-7 py-0.5"
            style={{ width: f.width ?? '100%' }}
            value={values[f.key] ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            autoFocus={i === 0}
          />
        ),
      )}
      <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
        {busy ? 'Saving…' : 'Save'}
      </button>
      <button type="button" className="btn btn-sm" onClick={close} disabled={busy}>
        Cancel
      </button>
      {error && (
        <p className="w-full text-2xs text-rag-red" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** A panel opened under a row (add, dependencies, archive, dates). */
function Panel({ colSpan, depth, title, children, onClose }: { colSpan: number; depth: number; title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    markDirty(true);
    return () => markDirty(false);
  }, []);
  return (
    <tr>
      <td colSpan={colSpan} className="border-b border-line bg-brand-50/40 py-2 pr-3" style={{ paddingLeft: padFor(depth + 1) }}>
        <div className="flex items-center gap-2">
          <p className="text-[12px] font-medium text-ink">{title}</p>
          <button type="button" className="link ml-auto text-2xs" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="mt-1.5">{children}</div>
      </td>
    </tr>
  );
}

function FormLine({ fields, submit, onDone, confirmLabel = 'Save', danger }: { fields: Field[]; submit: (v: Record<string, string>) => Promise<void>; onDone: () => void; confirmLabel?: string; danger?: boolean }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, f.value])));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await submit(values);
          onDone();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {fields.map((f, i) => (
        <label key={f.key} className="block" style={{ width: f.width ?? '12rem' }}>
          <span className="label">{f.label}</span>
          {f.type === 'select' ? (
            <select className="select" value={values[f.key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} autoFocus={i === 0}>
              {f.options?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="input"
              type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
              list={f.list}
              required={f.required}
              value={values[f.key] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              autoFocus={i === 0}
            />
          )}
        </label>
      ))}
      <button type="submit" className={clsx('btn', danger ? 'btn-danger' : 'btn-primary')} disabled={busy}>
        {busy ? 'Saving…' : confirmLabel}
      </button>
      {error && (
        <p className="w-full text-[12px] text-rag-red" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Dependencies (package or drawing): the list, then an empty row to add one
// ---------------------------------------------------------------------------

interface Dep {
  id: string;
  department: string;
  ownerText: string | null;
  description: string;
  targetDate: string | null;
  status: string;
  closureDate: string | null;
}

function Dependencies({ kind, id }: { kind: 'PACKAGE' | 'DRAWING'; id: string }) {
  const base = kind === 'PACKAGE' ? `/api/status/packages/${id}/dependencies` : `/api/drawings/${id}/dependencies`;
  const itemUrl = (depId: string) => (kind === 'PACKAGE' ? `/api/status/package-dependencies/${depId}` : `/api/drawing-dependencies/${depId}`);
  const [rows, setRows] = useState<Dep[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ department: '', ownerText: '', description: '', targetDate: '' });
  const load = useCallback(async () => {
    try {
      const r = await getJson<{ rows?: Dep[]; dependencies?: Dep[] } | Dep[]>(base);
      setRows(Array.isArray(r) ? r : (r.rows ?? r.dependencies ?? []));
    } catch {
      setError(DFS_LABEL.errorLoad);
    }
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);
  const add = async () => {
    setError(null);
    try {
      await send(base, 'POST', { department: draft.department, description: draft.description, ownerText: draft.ownerText || null, targetDate: draft.targetDate || null });
      setDraft({ department: '', ownerText: '', description: '', targetDate: '' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const close = async (d: Dep) => {
    setError(null);
    try {
      await send(itemUrl(d.id), 'PATCH', d.status === 'CLOSED' ? { status: 'OPEN' } : { status: 'CLOSED', closureDate: today() });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="max-w-5xl">
      <table className="w-full table-fixed border-separate border-spacing-0 text-[12px]">
        <colgroup>
          <col style={{ width: '9rem' }} />
          <col />
          <col style={{ width: '10rem' }} />
          <col style={{ width: '8.5rem' }} />
          <col style={{ width: '9rem' }} />
        </colgroup>
        <thead>
          <tr className="text-left text-2xs uppercase tracking-wide text-ink-mute">
            <th className="py-1 pr-2 font-semibold">Department</th>
            <th className="py-1 pr-2 font-semibold">Dependency</th>
            <th className="py-1 pr-2 font-semibold">{DFS_LABEL.colResponsible}</th>
            <th className="py-1 pr-2 font-semibold">Target date</th>
            <th className="py-1 font-semibold">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows === null && (
            <tr>
              <td colSpan={5} className="py-1 text-ink-mute">
                Loading…
              </td>
            </tr>
          )}
          {rows?.map((d) => (
            <tr key={d.id}>
              <td className="py-1 pr-2">{d.department}</td>
              <td className="py-1 pr-2">{d.description}</td>
              <td className="py-1 pr-2">{d.ownerText ?? '—'}</td>
              <td className="py-1 pr-2 tabular-nums">{formatDate(d.targetDate)}</td>
              <td className="py-1">
                <button type="button" className="link" onClick={() => void close(d)} title={d.status === 'CLOSED' ? 'Open again' : 'Close this dependency'}>
                  {d.status === 'CLOSED' ? `Closed ${formatDate(d.closureDate)}` : 'Open'}
                </button>
              </td>
            </tr>
          ))}
          {/* The empty row: fill it in to add a dependency. */}
          <tr>
            <td className="py-1 pr-2">
              <input className="input h-7" aria-label="New dependency: department" placeholder="Department" value={draft.department} onChange={(e) => setDraft({ ...draft, department: e.target.value })} />
            </td>
            <td className="py-1 pr-2">
              <input className="input h-7" aria-label="New dependency: description" placeholder="What is needed" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </td>
            <td className="py-1 pr-2">
              <input className="input h-7" aria-label="New dependency: responsible person" placeholder="Name" list="pds-people" value={draft.ownerText} onChange={(e) => setDraft({ ...draft, ownerText: e.target.value })} />
            </td>
            <td className="py-1 pr-2">
              <input className="input h-7" type="date" aria-label="New dependency: target date" value={draft.targetDate} onChange={(e) => setDraft({ ...draft, targetDate: e.target.value })} />
            </td>
            <td className="py-1">
              <button type="button" className="btn btn-sm btn-primary" disabled={!draft.department.trim() || !draft.description.trim()} onClick={() => void add()}>
                Add
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      {error && (
        <p className="mt-1 text-[12px] text-rag-red" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row actions (Edit Mode)
// ---------------------------------------------------------------------------

type Action = { key: string; label: string };

function actionsFor(r: DfsRow, o: { canAddTower: boolean; canMarkNa: boolean }): Action[] {
  const a: Action[] = [];
  if (r.kind === 'PROJECT') {
    if (r.depth === 0 && o.canAddTower) a.push({ key: 'addTower', label: 'Add Tower / Product' });
    a.push({ key: 'addPackage', label: 'Add Package' });
    if (r.parentKey) a.push({ key: 'archive', label: 'Archive' });
  } else if (r.kind === 'NODE') {
    a.push({ key: 'addPackage', label: 'Add Package' });
  } else if (r.kind === 'PACKAGE') {
    a.push({ key: 'addDiscipline', label: 'Add Discipline' });
    a.push({ key: 'reschedule', label: 'Move expected release date' });
    a.push({ key: 'dependencies', label: 'Dependencies' });
    a.push({ key: 'archive', label: 'Archive' });
  } else if (r.kind === 'DISCIPLINE') {
    a.push({ key: 'addDrawing', label: 'Add Drawing' });
    if (o.canMarkNa && r.packageId && r.group && ['AR', 'ST', 'MEP', 'LS'].includes(r.group)) {
      a.push({ key: 'applicability', label: r.status === 'NA' ? 'Mark Applicable' : 'Mark Not Applicable' });
    }
  }
  return a;
}

function RowMenu({ actions, onPick, label }: { actions: Action[]; onPick: (k: string) => void; label: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, [open]);
  if (!actions.length) return null;
  return (
    <div ref={ref} className="relative ml-auto shrink-0">
      <button type="button" className="rounded px-1.5 text-ink-mute hover:bg-slate-200 hover:text-ink" aria-haspopup="menu" aria-expanded={open} aria-label={`Actions for ${label}`} onClick={() => setOpen((v) => !v)}>
        ⋯
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-30 mt-1 w-56 rounded border border-line bg-white py-1 shadow-card">
          {actions.map((a) => (
            <button
              key={a.key}
              type="button"
              role="menuitem"
              className={clsx('block w-full px-3 py-1.5 text-left text-[12px] hover:bg-brand-50', a.key === 'archive' ? 'text-rag-red' : 'text-ink')}
              onClick={() => {
                setOpen(false);
                onPick(a.key);
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drawings of a discipline row, in the same grid
// ---------------------------------------------------------------------------

function DrawingRows({
  unit,
  query,
  cols,
  billing,
  editMode,
  version,
  reference,
  onChanged,
}: {
  unit: DfsRow;
  query: string;
  cols: number;
  billing: boolean;
  editMode: boolean;
  version: number;
  reference: Reference | null;
  onChanged: () => void;
}) {
  const [pages, setPages] = useState<DrawingPage[]>([]);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [panel, setPanel] = useState<{ id: string; kind: string } | null>(null);
  const depth = unit.depth + 1;
  const load = useCallback(
    async (page: number) => {
      setLoading(true);
      setError(false);
      try {
        const p = await getJson<DrawingPage>(`/api/dfs/unit-drawings?key=${encodeURIComponent(unit.unitKey!)}&page=${page}&pageSize=50&${query}`);
        setPages((prev) => [...prev.filter((x) => x.page < page), p]);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    },
    [unit.unitKey, query],
  );
  useEffect(() => {
    setPages([]);
    void load(1);
  }, [load, version]);
  const rows = pages.flatMap((p) => p.rows);
  const last = pages[pages.length - 1];
  const patch = async (d: DrawingLine, body: Record<string, unknown>) => {
    await send(`/api/drawings/${d.id}`, 'PATCH', body);
    onChanged();
  };
  const disciplineOptions = (reference?.disciplines ?? []).map((x) => ({ value: x.id, label: x.name }));
  const blank = billing ? 3 : 0;
  const sub = 'border-b border-r border-line/80 px-2.5 py-1 text-2xs font-medium uppercase tracking-wide text-ink-mute bg-slate-50';

  if (error) {
    return (
      <tr>
        <td colSpan={cols} className={clsx(CELL, 'text-[12px] text-rag-red')} style={{ paddingLeft: padFor(depth) }} role="alert">
          {DFS_LABEL.errorLoad}{' '}
          <button type="button" className="link" onClick={() => void load((last?.page ?? 0) + 1)}>
            Try again
          </button>
        </td>
      </tr>
    );
  }
  if (!last && loading) {
    return (
      <tr aria-hidden="true">
        <td colSpan={cols} className={CELL} style={{ paddingLeft: padFor(depth) }} aria-label="Loading drawings">
          <span className="block h-3 w-72 animate-pulse rounded bg-slate-200" />
        </td>
      </tr>
    );
  }
  if (rows.length === 0) {
    return (
      <tr>
        <td colSpan={cols} className={clsx(CELL, 'text-[12px] text-ink-mute')} style={{ paddingLeft: padFor(depth) }}>
          {DFS_LABEL.emptyDrawings}
        </td>
      </tr>
    );
  }
  return (
    <>
      <tr data-drawing-header="">
        <td className={clsx(sub, 'relative sticky left-0 z-10')} style={{ paddingLeft: padFor(depth) }}>
          <Guides depth={depth} />
          {DFS_LABEL.colDrawingName} · {DFS_LABEL.colDrawingNumber}
        </td>
        <td className={sub}>{DFS_LABEL.colResponsible}</td>
        <td className={sub}>{DFS_LABEL.colReleaseStatus}</td>
        <td className={sub}>{DFS_LABEL.colUpdatedOn}</td>
        <td className={clsx(sub, 'text-right')}>{DFS_LABEL.colRevision}</td>
        <td className={clsx(sub, 'text-right')}>{DFS_LABEL.colDiscipline}</td>
        {Array.from({ length: blank }, (_, i) => (
          <td key={i} className={sub} />
        ))}
      </tr>
      {rows.map((d) => {
        const number = d.numberStatus === 'NOT_YET_NUMBERED' ? DFS_LABEL.notYetNumbered : d.drawingCode;
        const menu: Action[] = editMode
          ? [
              { key: 'expected', label: 'Move expected release date' },
              { key: 'dependencies', label: 'Dependencies' },
              { key: 'archive', label: 'Archive' },
            ]
          : [];
        return (
          <Fragment key={d.id}>
            <tr className="group" data-drawing-row="">
              <td className={clsx(CELL, 'relative bg-white group-hover:bg-brand-50 sticky left-0 z-10')} style={{ paddingLeft: padFor(depth) }}>
                <Guides depth={depth} />
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <Editable
                      enabled={editMode}
                      label={`drawing ${number}`}
                      display={
                        <span className="block">
                          <span className="block">{d.drawingName}</span>
                          <span className="block text-2xs tabular-nums text-ink-mute">{number}</span>
                        </span>
                      }
                      fields={[
                        { key: 'drawingName', label: DFS_LABEL.colDrawingName, value: d.drawingName, required: true },
                        { key: 'drawingNumber', label: DFS_LABEL.colDrawingNumber, value: d.numberStatus === 'NOT_YET_NUMBERED' ? '' : d.drawingCode, width: '10rem' },
                      ]}
                      onSave={async (v) => {
                        const body: Record<string, unknown> = {};
                        if (v.drawingName.trim() !== d.drawingName) body.drawingName = v.drawingName.trim();
                        if (v.drawingNumber.trim() && v.drawingNumber.trim() !== d.drawingCode) body.drawingNumber = v.drawingNumber.trim();
                        if (Object.keys(body).length) await patch(d, { ...body, reason: 'Project Drawing Status (Edit Mode)' });
                      }}
                    />
                  </div>
                  <RowMenu actions={menu} label={d.drawingName} onPick={(k) => setPanel({ id: d.id, kind: k })} />
                </div>
              </td>
              <td className={clsx(CELL, 'bg-white group-hover:bg-brand-50')}>
                <Editable
                  enabled={editMode}
                  label="Responsible Person"
                  display={d.responsible ?? '—'}
                  fields={[{ key: 'name', label: DFS_LABEL.colResponsible, value: d.responsible ?? '', list: 'pds-people' }]}
                  onSave={async (v) => {
                    await send('/api/status/responsible', 'PATCH', { kind: 'DRAWING', id: d.id, name: v.name.trim() || null });
                    onChanged();
                  }}
                />
              </td>
              <td className={clsx(CELL, 'bg-white group-hover:bg-brand-50')}>
                <Editable
                  enabled={editMode}
                  label="release status"
                  display={<Chip status={d.completionStatus} />}
                  fields={
                    d.completionStatus === 'COMPLETED'
                      ? [{ key: 'reason', label: 'Reason to withdraw the release', value: '', required: true, width: '14rem' }]
                      : [{ key: 'date', label: 'Release date', type: 'date', value: today(), required: true, width: '9.5rem' }]
                  }
                  onSave={async (v) => {
                    if (d.completionStatus === 'COMPLETED') await patch(d, { completionStatus: 'NOT_COMPLETED', reason: v.reason });
                    else await patch(d, { completionStatus: 'COMPLETED', actualReleaseDate: v.date });
                  }}
                />
              </td>
              <td className={clsx(CELL, 'bg-white tabular-nums group-hover:bg-brand-50')}>
                {d.updatedOnText}
                {editMode && d.completionStatus !== 'COMPLETED' && d.expectedDate && <span className="block text-2xs text-ink-mute">Expected {formatDate(d.expectedDate)}</span>}
              </td>
              <td className={clsx(CELL, NUM, 'bg-white group-hover:bg-brand-50')}>
                <Editable
                  enabled={editMode}
                  align="right"
                  label="revision"
                  display={d.revision ?? '—'}
                  fields={[{ key: 'revision', label: 'New revision', value: '', required: true, width: '6rem' }]}
                  onSave={async (v) => {
                    await send(`/api/drawings/${d.id}/revisions`, 'POST', { revision: v.revision.trim() });
                    onChanged();
                  }}
                />
              </td>
              <td className={clsx(CELL, 'bg-white text-right group-hover:bg-brand-50')}>
                <Editable
                  enabled={editMode && disciplineOptions.length > 0}
                  align="right"
                  label="discipline"
                  display={d.disciplineName ?? '—'}
                  fields={[{ key: 'disciplineId', label: DFS_LABEL.colDiscipline, type: 'select', value: d.disciplineId ?? '', options: disciplineOptions, width: '9rem' }]}
                  onSave={async (v) => {
                    if (v.disciplineId && v.disciplineId !== d.disciplineId) await patch(d, { disciplineId: v.disciplineId, reason: 'Project Drawing Status (Edit Mode)' });
                  }}
                />
              </td>
              {Array.from({ length: blank }, (_, i) => (
                <td key={i} className={clsx(CELL, 'bg-white group-hover:bg-brand-50')} />
              ))}
            </tr>
            {panel?.id === d.id && panel.kind === 'dependencies' && (
              <Panel colSpan={cols} depth={depth} title={`Dependencies — ${d.drawingName}`} onClose={() => setPanel(null)}>
                <Dependencies kind="DRAWING" id={d.id} />
              </Panel>
            )}
            {panel?.id === d.id && panel.kind === 'expected' && (
              <Panel colSpan={cols} depth={depth} title={`Move the expected release date — ${d.drawingName}`} onClose={() => setPanel(null)}>
                <FormLine
                  fields={[
                    { key: 'date', label: 'New expected date', type: 'date', value: isoDay(d.expectedDate), required: true, width: '10rem' },
                    { key: 'reason', label: 'Reason', value: '', required: true, width: '22rem' },
                  ]}
                  submit={async (v) => {
                    await send('/api/reschedule', 'POST', { entityType: 'DRAWING', ids: [d.id], newExpectedDate: v.date, reason: v.reason, scope: 'ITEM', confirm: true });
                  }}
                  onDone={() => {
                    setPanel(null);
                    onChanged();
                  }}
                />
              </Panel>
            )}
            {panel?.id === d.id && panel.kind === 'archive' && (
              <Panel colSpan={cols} depth={depth} title={`Archive ${number} — it is hidden everywhere and kept in the audit trail`} onClose={() => setPanel(null)}>
                <FormLine
                  danger
                  confirmLabel="Archive drawing"
                  fields={[{ key: 'reason', label: 'Reason', value: '', required: true, width: '24rem' }]}
                  submit={async (v) => {
                    await send('/api/status/archive', 'POST', { kind: 'DRAWING', id: d.id, reason: v.reason });
                  }}
                  onDone={() => {
                    setPanel(null);
                    onChanged();
                  }}
                />
              </Panel>
            )}
          </Fragment>
        );
      })}
      {last && last.page < last.pageCount && (
        <tr>
          <td colSpan={cols} className={CELL} style={{ paddingLeft: padFor(depth) }}>
            <span className="text-2xs text-ink-mute">{formatOf(rows.length, last.total)} drawings shown</span>{' '}
            <button type="button" className="link text-[12px]" disabled={loading} onClick={() => void load(last.page + 1)}>
              {loading ? 'Loading…' : DFS_LABEL.loadMore}
            </button>
          </td>
        </tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export function StatusTree({
  initialRows,
  totals: initialTotals,
  query,
  billing,
  billingView,
  canExport,
  editMode,
  canAddTower,
  canMarkNa,
}: {
  initialRows: DfsRow[];
  totals: StatusTotals;
  query: string;
  billing: boolean;
  billingView: boolean;
  canExport: boolean;
  editMode: boolean;
  canAddTower: boolean;
  canMarkNa: boolean;
}) {
  const [rows, setRows] = useState<Map<string, DfsRow>>(() => new Map(initialRows.map((r) => [r.key, r])));
  const [kids, setKids] = useState<Map<string | null, string[]>>(() => new Map([[null, initialRows.map((r) => r.key)]]));
  const [open, setOpen] = useState<Set<string>>(() => new Set(initialRows.length === 1 ? [initialRows[0].key] : []));
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [totals, setTotals] = useState(initialTotals);
  const [version, setVersion] = useState(0);
  const [panel, setPanel] = useState<{ key: string; kind: string } | null>(null);
  const [reference, setReference] = useState<Reference | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const cols = billing ? 9 : 6;

  useEffect(() => {
    if (!editMode) return;
    getJson<Reference>('/api/status/reference')
      .then(setReference)
      .catch(() => setReference({ disciplines: [], people: [] }));
  }, [editMode]);

  const flag = (set: typeof setLoading, key: string, on: boolean) =>
    set((prev) => {
      const n = new Set(prev);
      if (on) n.add(key);
      else n.delete(key);
      return n;
    });

  const merge = useCallback((list: DfsRow[], parents: string[]) => {
    setRows((prev) => {
      const n = new Map(prev);
      for (const r of list) n.set(r.key, r);
      return n;
    });
    setKids((prev) => {
      const n = new Map(prev);
      for (const p of parents) n.set(p, []);
      for (const r of list) n.set(r.parentKey, [...(n.get(r.parentKey) ?? []).filter((k) => k !== r.key), r.key]);
      return n;
    });
  }, []);

  const loadChildren = useCallback(
    async (key: string) => {
      flag(setLoading, key, true);
      flag(setFailed, key, false);
      try {
        const res = await getJson<{ rows: DfsRow[] }>(`/api/dfs?parent=${encodeURIComponent(key)}&${query}`);
        merge(res.rows, [key]);
      } catch {
        flag(setFailed, key, true);
      } finally {
        flag(setLoading, key, false);
      }
    },
    [query, merge],
  );

  // A single project opens on load.
  useEffect(() => {
    if (initialRows.length === 1 && initialRows[0].hasChildren) void loadChildren(initialRows[0].key);
  }, [initialRows, loadChildren]);

  /** After a save: load the root and every open row again, so status, roll-ups and billing are current. */
  const refresh = useCallback(async () => {
    try {
      const root = await getJson<{ rows: DfsRow[]; totals: StatusTotals }>(`/api/dfs?${query}`);
      const openKeys = [...open].filter((k) => !k.startsWith('U:'));
      const children = await Promise.all(openKeys.map((k) => getJson<{ rows: DfsRow[] }>(`/api/dfs?parent=${encodeURIComponent(k)}&${query}`).then((r) => [k, r.rows] as const)));
      const nextRows = new Map<string, DfsRow>();
      const nextKids = new Map<string | null, string[]>([[null, root.rows.map((r) => r.key)]]);
      for (const r of root.rows) nextRows.set(r.key, r);
      for (const [k, list] of children) {
        nextKids.set(k, list.map((r) => r.key));
        for (const r of list) nextRows.set(r.key, r);
      }
      setRows(nextRows);
      setKids(nextKids);
      setOpen((prev) => new Set([...prev].filter((k) => nextRows.has(k))));
      setTotals(root.totals);
      setVersion((v) => v + 1);
    } catch {
      setNotice(DFS_LABEL.errorLoad);
    }
  }, [open, query]);

  const toggle = (r: DfsRow, force?: boolean) => {
    const willOpen = force ?? !open.has(r.key);
    setOpen((prev) => {
      const n = new Set(prev);
      if (willOpen) n.add(r.key);
      else n.delete(r.key);
      return n;
    });
    if (willOpen && r.kind !== 'DISCIPLINE' && !kids.has(r.key)) void loadChildren(r.key);
  };

  const expandToPackages = async () => {
    setBusy(true);
    flag(setFailed, '__expand', false);
    try {
      const res = await getJson<{ rows: DfsRow[] }>(`/api/dfs?expand=packages&${query}`);
      const parents = res.rows.filter((r) => r.kind === 'PROJECT' || r.kind === 'NODE').map((r) => r.key);
      merge(res.rows, parents);
      setOpen(new Set(parents));
    } catch {
      flag(setFailed, '__expand', true);
    } finally {
      setBusy(false);
    }
  };

  const ordered = useMemo(() => {
    const out: DfsRow[] = [];
    const walk = (parent: string | null) => {
      for (const k of kids.get(parent) ?? []) {
        const r = rows.get(k);
        if (!r) continue;
        out.push(r);
        if (open.has(k) && r.kind !== 'DISCIPLINE') walk(k);
      }
    };
    walk(null);
    return out;
  }, [rows, kids, open]);

  const onKey = (e: React.KeyboardEvent, r: DfsRow) => {
    if (e.key === 'ArrowRight' && !open.has(r.key)) {
      e.preventDefault();
      toggle(r, true);
    } else if (e.key === 'ArrowLeft' && open.has(r.key)) {
      e.preventDefault();
      toggle(r, false);
    }
  };

  const changed = () => {
    setNotice(null);
    void refresh();
  };

  const groupOptions = (group: string | null) => (reference?.disciplines ?? []).filter((d) => (d.group ?? d.code) === group).map((d) => ({ value: d.id, label: d.name }));

  const billTh = clsx(billingView ? 'bg-brand-50 text-brand-700' : '');
  const th = 'border-b border-r border-line bg-surface-sunk px-2.5 py-1.5 text-left text-2xs font-semibold uppercase tracking-wide text-ink-mute';
  const gth = 'border-b border-r border-line bg-surface-sunk px-2.5 py-1 text-2xs font-semibold uppercase tracking-wide text-ink-soft';

  const panelFor = (r: DfsRow): ReactNode => {
    if (!panel || panel.key !== r.key) return null;
    const close = () => setPanel(null);
    const done = () => {
      setPanel(null);
      changed();
    };
    const depth = r.depth;
    switch (panel.kind) {
      case 'addTower':
        return (
          <Panel colSpan={cols} depth={depth} title={`Add a tower or product under ${r.name}`} onClose={close}>
            <FormLine
              confirmLabel="Add Tower / Product"
              fields={[{ key: 'name', label: 'Name', value: '', required: true, width: '18rem' }]}
              submit={async (v) => {
                await send('/api/status/towers', 'POST', { parentProjectId: r.projectId, name: v.name });
              }}
              onDone={done}
            />
          </Panel>
        );
      case 'addPackage':
        return (
          <Panel colSpan={cols} depth={depth} title={`Add a package under ${r.name}`} onClose={close}>
            <FormLine
              confirmLabel="Add Package"
              fields={[
                { key: 'code', label: 'Package code', value: '', required: true, width: '9rem' },
                { key: 'name', label: 'Package name', value: '', required: true, width: '18rem' },
                { key: 'date', label: 'Expected release date', type: 'date', value: '', width: '10rem' },
                { key: 'responsible', label: DFS_LABEL.colResponsible, value: '', list: 'pds-people', width: '12rem' },
              ]}
              submit={async (v) => {
                await send('/api/status/packages', 'POST', {
                  projectId: r.projectId,
                  wbsNodeId: r.kind === 'NODE' ? r.key.slice(2) : null,
                  packageCode: v.code,
                  packageName: v.name,
                  expectedReleaseDate: v.date || null,
                  responsible: v.responsible || null,
                });
              }}
              onDone={done}
            />
          </Panel>
        );
      case 'addDiscipline': {
        const opts = (reference?.disciplines ?? []).map((d) => ({ value: d.id, label: d.name }));
        return (
          <Panel colSpan={cols} depth={depth} title={`Add a discipline to ${r.name}`} onClose={close}>
            <FormLine
              confirmLabel="Add Discipline"
              fields={[{ key: 'disciplineId', label: DFS_LABEL.colDiscipline, type: 'select', value: opts[0]?.value ?? '', options: opts, width: '16rem' }]}
              submit={async (v) => {
                await send('/api/status/disciplines', 'POST', { packageId: r.packageId, disciplineId: v.disciplineId });
              }}
              onDone={done}
            />
          </Panel>
        );
      }
      case 'addDrawing': {
        const opts = groupOptions(r.group);
        return (
          <Panel colSpan={cols} depth={depth} title={`Add a drawing to ${r.name}`} onClose={close}>
            <FormLine
              confirmLabel="Add Drawing"
              fields={[
                ...(opts.length > 1 ? [{ key: 'disciplineId', label: DFS_LABEL.colDiscipline, type: 'select' as const, value: opts[0].value, options: opts, width: '11rem' }] : []),
                { key: 'number', label: 'Drawing number (optional)', value: '', width: '11rem' },
                { key: 'name', label: DFS_LABEL.colDrawingName, value: '', required: true, width: '18rem' },
                { key: 'revision', label: DFS_LABEL.colRevision, value: '', width: '6rem' },
                { key: 'date', label: 'Expected release date', type: 'date', value: '', width: '10rem' },
                { key: 'responsible', label: DFS_LABEL.colResponsible, value: '', list: 'pds-people', width: '12rem' },
              ]}
              submit={async (v) => {
                await send('/api/drawings', 'POST', {
                  projectId: r.projectId,
                  packageId: r.packageId,
                  disciplineId: v.disciplineId || opts[0]?.value || null,
                  drawingNumber: v.number.trim() || null,
                  drawingName: v.name,
                  revision: v.revision.trim() || null,
                  expectedReleaseDate: v.date || null,
                  responsibleText: v.responsible.trim() || null,
                });
              }}
              onDone={done}
            />
          </Panel>
        );
      }
      case 'applicability':
        return (
          <Panel colSpan={cols} depth={depth} title={`${r.status === 'NA' ? 'Mark Applicable' : 'Mark Not Applicable'} — ${r.name}`} onClose={close}>
            <FormLine
              confirmLabel={r.status === 'NA' ? 'Mark Applicable' : 'Mark Not Applicable'}
              fields={[{ key: 'reason', label: 'Reason', value: '', required: true, width: '24rem' }]}
              submit={async (v) => {
                await send('/api/dfs/applicability', 'POST', { packageId: r.packageId, discipline: r.group, applicability: r.status === 'NA' ? 'APPLICABLE' : 'NA', reason: v.reason });
              }}
              onDone={done}
            />
          </Panel>
        );
      case 'reschedule':
        return (
          <Panel colSpan={cols} depth={depth} title={`Move the expected release date — ${r.name}`} onClose={close}>
            <FormLine
              fields={[
                { key: 'date', label: 'New expected date', type: 'date', value: isoDay(r.expectedDate), required: true, width: '10rem' },
                { key: 'reason', label: 'Reason', value: '', required: true, width: '22rem' },
              ]}
              submit={async (v) => {
                await send('/api/reschedule', 'POST', { entityType: 'PACKAGE', ids: [r.packageId], newExpectedDate: v.date, reason: v.reason, scope: 'ITEM', confirm: true });
              }}
              onDone={done}
            />
          </Panel>
        );
      case 'dependencies':
        return (
          <Panel colSpan={cols} depth={depth} title={`Dependencies — ${r.name}`} onClose={close}>
            <Dependencies kind="PACKAGE" id={r.packageId!} />
          </Panel>
        );
      case 'archive': {
        const kind = r.kind === 'PACKAGE' ? 'PACKAGE' : 'PROJECT';
        return (
          <Panel
            colSpan={cols}
            depth={depth}
            title={`Archive ${r.name}${kind === 'PACKAGE' ? ` and its ${formatNumber(r.drawingsTotal)} drawing(s)` : ' and everything under it'} — hidden everywhere, kept in the audit trail`}
            onClose={close}
          >
            <FormLine
              danger
              confirmLabel="Archive"
              fields={[{ key: 'reason', label: 'Reason', value: '', required: true, width: '24rem' }]}
              submit={async (v) => {
                await send('/api/status/archive', 'POST', { kind, id: kind === 'PACKAGE' ? r.packageId : r.projectId, reason: v.reason });
              }}
              onDone={done}
            />
          </Panel>
        );
      }
      default:
        return null;
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <datalist id="pds-people">
        {(reference?.people ?? []).map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <p className="mr-auto text-[12px] text-ink-soft" data-totals="">
          <span className="font-semibold text-ink">{formatOf(totals.packagesComplete, totals.packagesTotal)}</span> packages complete ·{' '}
          <span className="font-semibold text-ink">{formatOf(totals.drawingsReleased, totals.drawingsTotal)}</span> drawings released
          {billing && totals.billing && (
            <>
              {' · '}
              {DFS_LABEL.colTotal} <span className="font-semibold text-ink tabular-nums">₹ {money(totals.billing.total)} Cr</span> · {DFS_LABEL.colBilled}{' '}
              <span className="font-semibold text-ink tabular-nums">₹ {money(totals.billing.billed)} Cr</span> · {DFS_LABEL.colUnbilled}{' '}
              <span className="font-semibold text-ink tabular-nums">₹ {money(totals.billing.unbilled)} Cr</span>
            </>
          )}
        </p>
        <button type="button" className="btn btn-sm" onClick={() => void expandToPackages()} disabled={busy || ordered.length === 0}>
          {busy ? 'Opening…' : DFS_LABEL.expandToPackages}
        </button>
        <button type="button" className="btn btn-sm" onClick={() => setOpen(new Set())}>
          {DFS_LABEL.collapseAll}
        </button>
        {canExport && (
          <>
            <a className="btn btn-sm" href={`/api/dfs/export?format=xlsx&${query}`}>
              {DFS_LABEL.exportExcel}
            </a>
            <a className="btn btn-sm" href={`/api/dfs/export?format=csv&${query}`}>
              {DFS_LABEL.exportCsv}
            </a>
          </>
        )}
      </div>
      {(failed.has('__expand') || notice) && (
        <p className="px-3 py-2 text-[12px] text-rag-red" role="alert">
          {notice ?? DFS_LABEL.errorLoad}
        </p>
      )}
      {ordered.length === 0 ? (
        <p className="px-4 py-10 text-center text-[12.5px] text-ink-mute">{DFS_LABEL.emptyTree}</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto" data-scroll="">
          <table className={clsx('w-full table-fixed border-separate border-spacing-0 text-[12.5px]', billing ? 'min-w-[92rem]' : 'min-w-[70rem]')} role="treegrid" aria-label={billingView ? DFS_LABEL.billingTitle : DFS_LABEL.title}>
            <colgroup>
              <col />
              <col style={{ width: '10rem' }} />
              <col style={{ width: '11.5rem' }} />
              <col style={{ width: '8.5rem' }} />
              <col style={{ width: '7.5rem' }} />
              <col style={{ width: '9rem' }} />
              {billing && (
                <>
                  <col style={{ width: '7.5rem' }} />
                  <col style={{ width: '7.5rem' }} />
                  <col style={{ width: '9rem' }} />
                </>
              )}
            </colgroup>
            <thead className="sticky top-0 z-20">
              <tr data-group-header="">
                <th colSpan={2} className={clsx(gth, 'sticky left-0 z-10')} />
                <th className={gth}>{DFS_LABEL.groupStatus}</th>
                <th className={gth}>{DFS_LABEL.groupSchedule}</th>
                <th colSpan={2} className={clsx(gth, 'text-center')}>
                  {DFS_LABEL.groupProgress}
                </th>
                {billing && (
                  <th colSpan={3} className={clsx(gth, 'text-center', billTh)}>
                    {DFS_LABEL.groupBilling}
                  </th>
                )}
              </tr>
              <tr>
                <th className={clsx(th, 'sticky left-0 z-10')}>{DFS_LABEL.colName}</th>
                <th className={th} title={DFS_TOOLTIP.responsible}>
                  {DFS_LABEL.colResponsible}
                </th>
                <th className={th} title={DFS_TOOLTIP.packageStatus}>
                  {DFS_LABEL.colPackageStatus}
                </th>
                <th className={th} title={DFS_TOOLTIP.releaseDate}>
                  {DFS_LABEL.colReleaseDate}
                </th>
                <th className={clsx(th, 'text-right')} title={DFS_TOOLTIP.packagesComplete}>
                  {DFS_LABEL.colPackagesComplete}
                </th>
                <th className={clsx(th, 'text-right')} title={DFS_TOOLTIP.drawingsReleased}>
                  {DFS_LABEL.colDrawingsReleased}
                </th>
                {billing && (
                  <>
                    <th className={clsx(th, 'text-right', billTh)} title={DFS_TOOLTIP.total}>
                      {DFS_LABEL.colTotal}
                    </th>
                    <th className={clsx(th, 'text-right', billTh)} title={DFS_TOOLTIP.billed}>
                      {DFS_LABEL.colBilled}
                    </th>
                    <th className={clsx(th, 'text-right', billTh)} title={DFS_TOOLTIP.unbilled}>
                      {DFS_LABEL.colUnbilled}
                    </th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {ordered.map((r) => {
                const isOpen = open.has(r.key);
                const aggregate = r.kind === 'PROJECT' || r.kind === 'NODE';
                const tint = tintOf(r);
                const td = clsx(CELL, tint, 'group-hover:bg-brand-50');
                const pkg = r.kind === 'PACKAGE';
                const actions = editMode ? actionsFor(r, { canAddTower, canMarkNa }) : [];
                const billEdit = editMode && billingView && r.kind === 'DISCIPLINE' && !!r.packageId && r.status !== 'NA';
                const eligible = (r.billingFlags ?? []).includes('ELIGIBLE_AFTER_COMPLETION');
                const early = (r.billingFlags ?? []).includes('BILLED_BEFORE_COMPLETION');
                return (
                  <Fragment key={r.key}>
                    <tr className="group" aria-level={r.depth + 1} aria-expanded={r.hasChildren ? isOpen : undefined} data-kind={r.kind}>
                      <td className={clsx(td, 'relative sticky left-0 z-10')} style={{ paddingLeft: padFor(r.depth) }}>
                        <Guides depth={r.depth} />
                        <div className="flex items-start gap-1.5">
                          {r.hasChildren ? (
                            <button
                              type="button"
                              className="mt-px inline-flex w-4 shrink-0 justify-center rounded text-ink-mute hover:text-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                              aria-expanded={isOpen}
                              aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${r.name}`}
                              onClick={() => toggle(r)}
                              onKeyDown={(e) => onKey(e, r)}
                            >
                              <span aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                            </button>
                          ) : (
                            <span className="inline-block w-4 shrink-0" aria-hidden="true" />
                          )}
                          <div className="min-w-0 flex-1">
                            {pkg && r.packageId ? (
                              <Editable
                                enabled={editMode}
                                label={`package ${r.name}`}
                                display={
                                  <span className="block font-medium text-ink">
                                    {r.name}
                                    {r.code && r.code !== r.name && <span className="ml-2 text-2xs font-normal tabular-nums text-ink-mute">{r.code}</span>}
                                  </span>
                                }
                                fields={[
                                  { key: 'packageCode', label: DFS_LABEL.colPackageCode, value: r.code ?? '', required: true, width: '7rem' },
                                  { key: 'packageName', label: DFS_LABEL.colPackage, value: r.name, required: true },
                                ]}
                                onSave={async (v) => {
                                  const body: Record<string, string> = {};
                                  if (v.packageName.trim() !== r.name) body.packageName = v.packageName;
                                  if (v.packageCode.trim() !== (r.code ?? '')) body.packageCode = v.packageCode;
                                  if (Object.keys(body).length) {
                                    await send(`/api/status/packages/${r.packageId}`, 'PATCH', body);
                                    changed();
                                  }
                                }}
                              />
                            ) : (
                              <span className="block font-medium text-ink">
                                {r.name}
                                {r.typeLabel && <span className="ml-2 text-2xs font-normal text-ink-mute">{r.typeLabel}</span>}
                              </span>
                            )}
                          </div>
                          <RowMenu actions={actions} label={r.name} onPick={(k) => setPanel({ key: r.key, kind: k })} />
                        </div>
                      </td>
                      <td className={td}>
                        {pkg && r.packageId ? (
                          <Editable
                            enabled={editMode}
                            label="Responsible Person"
                            display={r.responsible ?? '—'}
                            fields={[{ key: 'name', label: DFS_LABEL.colResponsible, value: r.responsible ?? '', list: 'pds-people' }]}
                            onSave={async (v) => {
                              await send('/api/status/responsible', 'PATCH', { kind: 'PACKAGE', id: r.packageId, name: v.name.trim() || null });
                              changed();
                            }}
                          />
                        ) : (
                          (r.responsible ?? '')
                        )}
                      </td>
                      <td className={td}>{aggregate ? <span className="whitespace-nowrap text-ink-soft">{aggregateStatus(r)}</span> : r.status ? <Chip status={r.status} /> : null}</td>
                      <td className={clsx(td, 'tabular-nums whitespace-nowrap')}>
                        {!aggregate && r.status ? formatDate(r.releaseDate) : ''}
                        {editMode && pkg && r.expectedDate && r.status !== 'COMPLETE' && <span className="block text-2xs text-ink-mute">Expected {formatDate(r.expectedDate)}</span>}
                      </td>
                      <td className={clsx(td, NUM)}>{aggregate ? formatOf(r.packagesComplete, r.packagesTotal) : ''}</td>
                      <td className={clsx(td, NUM)}>{formatOf(r.drawingsReleased, r.drawingsTotal)}</td>
                      {billing && (
                        <>
                          <td className={clsx(td, NUM, billingView && 'bg-brand-50/40')}>
                            <Editable
                              enabled={billEdit}
                              align="right"
                              label={`Total of ${r.name}`}
                              display={r.billing ? money(r.billing.total) : ''}
                              fields={[{ key: 'v', label: `${DFS_LABEL.colTotal} (₹ Cr)`, type: 'number', value: r.billing ? String(r.billing.total) : '', width: '7rem' }]}
                              onSave={async (v) => {
                                await send('/api/status/billing', 'PATCH', { packageId: r.packageId, group: r.group, total: v.v === '' ? null : Number(v.v) });
                                changed();
                              }}
                            />
                          </td>
                          <td className={clsx(td, NUM, billingView && 'bg-brand-50/40')}>
                            <span className="inline-flex items-center justify-end gap-1">
                              {early && (
                                <span className="text-rag-red" title={DFS_LABEL.billedBeforeCompletion} aria-label={DFS_LABEL.billedBeforeCompletion}>
                                  ⚠
                                </span>
                              )}
                              <Editable
                                enabled={billEdit}
                                align="right"
                                label={`Billed of ${r.name}`}
                                display={r.billing ? money(r.billing.billed) : ''}
                                fields={[{ key: 'v', label: `${DFS_LABEL.colBilled} (₹ Cr)`, type: 'number', value: r.billing ? String(r.billing.billed) : '', width: '7rem' }]}
                                onSave={async (v) => {
                                  await send('/api/status/billing', 'PATCH', { packageId: r.packageId, group: r.group, billed: v.v === '' ? null : Number(v.v) });
                                  changed();
                                }}
                              />
                            </span>
                          </td>
                          <td className={clsx(td, NUM, billingView && 'bg-brand-50/40')}>
                            {r.billing ? money(r.billing.unbilled) : ''}
                            {eligible && !aggregate && <span className="block text-2xs font-normal text-amber-800">{DFS_LABEL.eligibleAfterCompletion}</span>}
                          </td>
                        </>
                      )}
                    </tr>
                    {panelFor(r)}
                    {isOpen && r.kind !== 'DISCIPLINE' && loading.has(r.key) && (
                      <tr aria-hidden="true">
                        <td colSpan={cols} className={CELL} style={{ paddingLeft: padFor(r.depth + 1) }}>
                          <span className="block h-3 w-56 animate-pulse rounded bg-slate-200" />
                        </td>
                      </tr>
                    )}
                    {isOpen && failed.has(r.key) && (
                      <tr>
                        <td colSpan={cols} className={clsx(CELL, 'text-[12px] text-rag-red')} style={{ paddingLeft: padFor(r.depth + 1) }} role="alert">
                          {DFS_LABEL.errorLoad}{' '}
                          <button type="button" className="link" onClick={() => void loadChildren(r.key)}>
                            Try again
                          </button>
                        </td>
                      </tr>
                    )}
                    {isOpen && r.kind === 'DISCIPLINE' && r.unitKey && (
                      <DrawingRows unit={r} query={query} cols={cols} billing={billing} editMode={editMode} version={version} reference={reference} onChanged={changed} />
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
