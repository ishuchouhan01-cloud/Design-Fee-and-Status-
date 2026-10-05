'use client';

/**
 * Import: upload → check the reading → dry run → import → history / undo.
 */
import clsx from 'clsx';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { formatDateTime, formatNumber } from '@/lib/format';

type FileType = 'PLAN' | 'DESIGN_FEE' | 'ACC' | 'PROJECT_LIST';

interface SheetMapping {
  sheet: string;
  headerRow: number;
  discipline?: string | null;
  columns: Record<string, string | null>;
  sample: (string | null)[][];
}
interface Inspection {
  fileName: string;
  sheets: { name: string; rows: number; hidden: boolean }[];
  detected: FileType | null;
  reason: string;
  mapping: SheetMapping[];
  designFee: {
    sheet: string;
    packages: number;
    headings: number;
    layout: string | null;
    title: { code: string | null; name: string } | null;
    candidates: { sheet: string; hidden: boolean; layout: string | null; billedTill: number | null; packages: number; revision: number; blocks: { total: number; packageTotal: number; complete: boolean } | null; problem: string | null }[];
    problem: string | null;
  } | null;
}

type FeeLayout = 'AUTO' | 'PACKAGE_TOTAL' | 'DISCIPLINE_BLOCKS';
const FEE_LAYOUT_LABEL: Record<FeeLayout, string> = {
  AUTO: 'Automatic (one fee per package when the sheet has a Total Fee / Balance column set; a project already billed per discipline stays so)',
  PACKAGE_TOTAL: 'One fee per package (Total Fee · Billed till Dec)',
  DISCIPLINE_BLOCKS: 'Per discipline (AR · ST · MEP · LS blocks)',
};
const LAYOUT_NAME: Record<string, string> = { PACKAGE_TOTAL: 'one fee per package', DISCIPLINE_BLOCKS: 'per discipline' };

/** "After the Rain Phase 2c" under "After the Rain" → "Phase 2c". */
function nameUnder(full: string, parent: string) {
  const f = full.trim();
  const p = parent.trim();
  if (!p || f.length <= p.length || f.toLowerCase().indexOf(p.toLowerCase()) !== 0) return f;
  return f.slice(p.length).replace(/^[\s|:–—-]+/, '').trim() || f;
}
interface Issue {
  severity: string;
  code: string;
  workbook: string | null;
  sheet: string | null;
  row: number | null;
  value: string | null;
  message: string;
}
interface RunResult {
  mode: 'PREVIEW' | 'APPLIED';
  batchId: string | null;
  project: { id: string | null; name: string } | null;
  counts: { create: number; update: number; unchanged: number; conflicts: number; ambiguous: number; skipped: number };
  issues: Issue[];
  issueTotal: number;
  preview: unknown;
}
interface Run {
  id: string;
  who: string | null;
  when: string;
  fileTypeLabel: string;
  files: string | null;
  project: string | null;
  created: number;
  updated: number;
  warnings: number;
  status: string;
  undoneBy: string | null;
  canUndo: boolean;
}

const ROLE_LABEL: Record<string, string> = {
  number: 'Drawing number',
  title: 'Drawing name',
  location: 'Location',
  batchCode: 'Batch code',
  batch: 'Batch',
  revision: 'Revision',
  discipline: 'Discipline',
  releaseDate: 'Release date',
  issuedTill: 'Issued till previous year',
  versions: 'Versions',
  collection: 'Collection',
  code: 'Project code',
  shortName: 'Short name',
  fullName: 'Full name',
  parent: 'Parent project',
  order: 'Order',
};

const DISCIPLINES = [
  ['AR', 'Architecture'],
  ['ST', 'Structural'],
  ['MEP', 'Mechanical, Electrical & Plumbing'],
  ['LS', 'Landscape'],
  ['MP', 'Master Planning'],
  ['UD', 'Urban Design'],
  ['SR', 'Services'],
] as const;

const COLS = Array.from({ length: 40 }, (_, i) => (i < 26 ? String.fromCharCode(65 + i) : `A${String.fromCharCode(65 + i - 26)}`));

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'The request could not be completed. Please try again.');
  return data as T;
}

export function ImportCentre({ projects, fileTypes, initialRuns }: { projects: { id: string; name: string; parentId: string | null }[]; fileTypes: Record<string, string>; initialRuns: Run[] }) {
  const router = useRouter();
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [fileType, setFileType] = useState<FileType | ''>('');
  const [projectMode, setProjectMode] = useState<'existing' | 'new'>('existing');
  const [projectId, setProjectId] = useState('');
  const [newProject, setNewProject] = useState({ fullName: '', shortCode: '', parentProjectId: '' });
  const [mapping, setMapping] = useState<Record<string, Record<string, string>>>({});
  const [disciplines, setDisciplines] = useState<Record<string, string>>({});
  const [feeSheet, setFeeSheet] = useState('');
  const [feeLayout, setFeeLayout] = useState<FeeLayout>('AUTO');
  const [remembered, setRemembered] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>(initialRuns);
  const [undoMsg, setUndoMsg] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);

  const needsProject = fileType && fileType !== 'PROJECT_LIST';
  const projectReady = !needsProject || (projectMode === 'existing' ? Boolean(projectId) : newProject.fullName.trim().length >= 2 && fileType !== 'ACC');

  const reset = () => {
    setResult(null);
    setConfirmed(false);
  };

  const upload = async (file: File) => {
    setError(null);
    reset();
    setInspection(null);
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      setError('Only Excel Workbook (.xlsx) files can be imported. Macro-enabled workbooks (.xlsm) are not accepted.');
      return;
    }
    setBusy('upload');
    try {
      const fd = new FormData();
      fd.set('file', file);
      const res = await fetch('/api/import-centre/upload', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'The file could not be uploaded.');
      setUploadId(data.uploadId);
      setInspection(data.inspection);
      setFileType(data.inspection.detected ?? '');
      applyInspection(data.inspection);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const applyInspection = (ins: Inspection) => {
    const m: Record<string, Record<string, string>> = {};
    const d: Record<string, string> = {};
    for (const s of ins.mapping) {
      m[s.sheet] = Object.fromEntries(Object.entries(s.columns).filter(([, v]) => v).map(([k, v]) => [k, v!]));
      if (s.discipline) d[s.sheet] = s.discipline;
    }
    setMapping(m);
    setDisciplines(d);
    setFeeSheet(ins.designFee?.sheet ?? '');
    // A new project's full name defaults to the Design Fee sheet's own title ("0072 | After the Rain Phase 2c").
    const title = ins.designFee?.title?.name;
    if (title) setNewProject((np) => (np.fullName.trim() ? np : { ...np, fullName: title, shortCode: np.shortCode || '' }));
  };

  const reinspect = async (type: FileType | '', pid: string, sheet?: string) => {
    if (!uploadId || !type) return;
    setBusy('inspect');
    setError(null);
    try {
      const data = await post<{ inspection: Inspection; remembered: boolean }>('/api/import-centre/inspect', { uploadId, fileType: type, projectId: pid || null, feeSheet: sheet || null });
      setInspection(data.inspection);
      setRemembered(data.remembered);
      applyInspection(data.inspection);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const body = (apply: boolean) => ({
    uploadId,
    fileType,
    projectId: needsProject && projectMode === 'existing' ? projectId : null,
    newProject: needsProject && projectMode === 'new' ? { fullName: newProject.fullName, shortCode: newProject.shortCode || null, parentProjectId: newProject.parentProjectId || null } : null,
    mapping: { columns: mapping, disciplines, feeSheet: feeSheet || null, feeLayout },
    apply,
    confirmed: apply ? confirmed : undefined,
  });

  const run = async (apply: boolean) => {
    setBusy(apply ? 'commit' : 'preview');
    setError(null);
    try {
      const r = await post<RunResult>('/api/import-centre/run', body(apply));
      setResult(r);
      if (apply) {
        setConfirmed(false);
        const h = await fetch('/api/import-centre/history', { cache: 'no-store' }).then((x) => x.json());
        setRuns(h.runs ?? []);
        router.refresh();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const undo = async (id: string) => {
    setBusy('undo');
    setArmed(null);
    setUndoMsg(null);
    setError(null);
    try {
      const r = await post<{ removedDrawings: number; reverted: number; kept: string[] }>('/api/import-centre/undo', { batchId: id });
      setUndoMsg(`Import undone: ${formatNumber(r.removedDrawings)} drawing(s) removed, ${formatNumber(r.reverted)} value(s) put back${r.kept.length ? `, ${formatNumber(r.kept.length)} change(s) kept because they were edited since` : ''}.`);
      const h = await fetch('/api/import-centre/history', { cache: 'no-store' }).then((x) => x.json());
      setRuns(h.runs ?? []);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const typeOptions = useMemo(() => Object.entries(fileTypes) as [FileType, string][], [fileTypes]);

  return (
    <div className="space-y-4">
      {error && (
        <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-900" role="alert">
          {error}
        </p>
      )}

      <section className="card p-4" aria-labelledby="step-file">
        <h2 id="step-file" className="text-[13.5px] font-semibold">
          1. Choose the workbook
        </h2>
        <p className="mt-1 text-[12px] text-ink-mute">Excel Workbook (.xlsx) only, up to 40 MB. Workbooks with macros are not accepted.</p>
        <input
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="mt-3 block text-[12.5px]"
          aria-label="Workbook to import"
          disabled={busy === 'upload'}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
        />
        {busy === 'upload' && <p className="mt-2 text-[12px] text-ink-mute">Reading the workbook…</p>}
        {inspection && (
          <div className="mt-3 text-[12px] text-ink-soft">
            <p>
              <span className="font-medium text-ink">{inspection.fileName}</span> — {inspection.sheets.length} sheet(s):{' '}
              {inspection.sheets.map((s) => `${s.name} (${formatNumber(s.rows)} rows${s.hidden ? ', hidden' : ''})`).join(' · ')}
            </p>
            <p className="mt-1">{inspection.detected ? `Recognised as: ${fileTypes[inspection.detected]}. ${inspection.reason}` : inspection.reason}</p>
          </div>
        )}
      </section>

      {inspection && (
        <section className="card p-4" aria-labelledby="step-type">
          <h2 id="step-type" className="text-[13.5px] font-semibold">
            2. File type and project
          </h2>
          <div className="mt-3 flex flex-wrap gap-4">
            <div className="w-72">
              <label className="label" htmlFor="ic-type">
                File type
              </label>
              <select
                id="ic-type"
                className="select"
                value={fileType}
                onChange={(e) => {
                  const t = e.target.value as FileType;
                  setFileType(t);
                  reset();
                  void reinspect(t, projectId);
                }}
              >
                <option value="">Choose…</option>
                {typeOptions.map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            {needsProject && (
              <div className="min-w-[18rem] flex-1">
                <fieldset>
                  <legend className="label">Project</legend>
                  <div className="flex gap-4 text-[12.5px]">
                    <label className="inline-flex items-center gap-1.5">
                      <input type="radio" name="pm" checked={projectMode === 'existing'} onChange={() => (setProjectMode('existing'), reset())} /> An existing project
                    </label>
                    {fileType !== 'ACC' && (
                      <label className="inline-flex items-center gap-1.5">
                        <input type="radio" name="pm" checked={projectMode === 'new'} onChange={() => (setProjectMode('new'), reset())} /> A new project
                      </label>
                    )}
                  </div>
                </fieldset>
                {projectMode === 'existing' ? (
                  <select
                    className="select mt-2 max-w-md"
                    aria-label="Project"
                    value={projectId}
                    onChange={(e) => {
                      setProjectId(e.target.value);
                      reset();
                      void reinspect(fileType, e.target.value);
                    }}
                  >
                    <option value="">Choose a project…</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="mt-2 grid max-w-2xl gap-2 sm:grid-cols-3">
                    <div className="sm:col-span-3">
                      <label className="label" htmlFor="np-name">
                        Full name
                      </label>
                      <input id="np-name" className="input" value={newProject.fullName} onChange={(e) => (setNewProject({ ...newProject, fullName: e.target.value }), reset())} />
                    </div>
                    <div>
                      <label className="label" htmlFor="np-code">
                        Short code (optional)
                      </label>
                      <input id="np-code" className="input" value={newProject.shortCode} onChange={(e) => (setNewProject({ ...newProject, shortCode: e.target.value }), reset())} />
                    </div>
                    <div className="sm:col-span-2">
                      <label className="label" htmlFor="np-parent">
                        Part of (optional)
                      </label>
                      <select
                        id="np-parent"
                        className="select"
                        value={newProject.parentProjectId}
                        onChange={(e) => {
                          const parent = projects.find((p) => p.id === e.target.value);
                          // Under "After the Rain", the sheet title "After the Rain Phase 2c" becomes "Phase 2c".
                          setNewProject({ ...newProject, parentProjectId: e.target.value, fullName: parent ? nameUnder(newProject.fullName, parent.name) : newProject.fullName });
                          reset();
                        }}
                      >
                        <option value="">— none —</option>
                        {projects
                          .filter((p) => !p.parentId)
                          .map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                      </select>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {inspection && fileType && (
        <section className="card p-4" aria-labelledby="step-map">
          <h2 id="step-map" className="text-[13.5px] font-semibold">
            3. Check how the columns are read
          </h2>
          <p className="mt-1 text-[12px] text-ink-mute">
            Correct any column that is wrong. {remembered ? 'The mapping saved for this project last time is applied.' : 'The mapping you import with is remembered for this project.'}
          </p>
          {busy === 'inspect' && <p className="mt-2 text-[12px] text-ink-mute">Reading the columns…</p>}
          {inspection.designFee && (
            <div className="mt-2 space-y-2 text-[12px] text-ink-soft" data-fee-sheet="">
              <p>
                Design Fee sheet used: &ldquo;{inspection.designFee.sheet}&rdquo;
                {inspection.designFee.layout ? ` (${LAYOUT_NAME[inspection.designFee.layout] ?? inspection.designFee.layout})` : ''}: {formatNumber(inspection.designFee.packages)} package(s) under{' '}
                {formatNumber(inspection.designFee.headings)} heading(s)
                {inspection.designFee.title ? <> · sheet title &ldquo;{[inspection.designFee.title.code, inspection.designFee.title.name].filter(Boolean).join(' | ')}&rdquo;</> : null}.
              </p>
              {inspection.designFee.problem && (
                <p className="text-amber-900" role="alert">
                  This sheet cannot be read ({inspection.designFee.problem}). The drawings still import; choose another Design Fee sheet below.
                </p>
              )}
              <div className="flex flex-wrap items-end gap-3">
                {inspection.designFee.candidates.length > 1 && (
                  <label className="block">
                    <span className="label">Design Fee sheet</span>
                    <select
                      className="select"
                      value={feeSheet}
                      onChange={(e) => {
                        setFeeSheet(e.target.value);
                        reset();
                        void reinspect(fileType, projectMode === 'existing' ? projectId : '', e.target.value);
                      }}
                    >
                      {inspection.designFee.candidates.map((c) => (
                        <option key={c.sheet} value={c.sheet}>
                          {c.sheet}
                          {c.hidden ? ' (hidden)' : ''} — {c.problem ? 'cannot be read' : `${formatNumber(c.packages)} packages${c.billedTill ? `, billed till Dec ${c.billedTill}` : ''}`}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="block">
                  <span className="label">How the fees are read</span>
                  <select className="select" value={feeLayout} onChange={(e) => (setFeeLayout(e.target.value as FeeLayout), reset())}>
                    {(Object.keys(FEE_LAYOUT_LABEL) as FeeLayout[]).map((k) => (
                      <option key={k} value={k}>
                        {FEE_LAYOUT_LABEL[k]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {(() => {
                const c = inspection.designFee.candidates.find((x) => x.sheet === inspection.designFee!.sheet);
                return c?.blocks ? (
                  <p className="text-ink-mute">
                    The sheet also has per-discipline blocks: ₹ {c.blocks.total.toFixed(4)} Cr of the packages&rsquo; ₹ {c.blocks.packageTotal.toFixed(4)} Cr
                    {c.blocks.complete ? ' — they add up, so "Per discipline" is possible too.' : ' — they do not add up to the package fees, so one fee per package is kept.'}
                  </p>
                ) : null;
              })()}
            </div>
          )}
          {inspection.mapping.length === 0 && fileType !== 'DESIGN_FEE' && <p className="mt-2 text-[12px] text-amber-900">No sheet of this workbook could be read as this file type.</p>}
          <div className="mt-3 space-y-4">
            {inspection.mapping.map((s) => {
              const roles = Object.keys(s.columns);
              return (
                <div key={s.sheet} className="rounded border border-line">
                  <div className="flex flex-wrap items-center gap-3 border-b border-line bg-slate-50 px-3 py-2 text-[12px]">
                    <span className="font-semibold text-ink">{s.sheet}</span>
                    <span className="text-ink-mute">header row {s.headerRow}</span>
                    {fileType === 'PLAN' && (
                      <label className="ml-auto inline-flex items-center gap-1.5">
                        Discipline
                        <select className="select w-auto py-0.5" value={disciplines[s.sheet] ?? ''} onChange={(e) => {
                            const next = { ...disciplines };
                            if (e.target.value) next[s.sheet] = e.target.value;
                            else delete next[s.sheet];
                            setDisciplines(next);
                            reset();
                          }}>
                          <option value="">From the Discipline column</option>
                          {DISCIPLINES.map(([c, n]) => (
                            <option key={c} value={c}>
                              {n}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="table table-compact">
                      <thead>
                        <tr>
                          {roles.map((r) => (
                            <th key={r}>
                              <span className="block">{ROLE_LABEL[r] ?? r}</span>
                              <select
                                className="select mt-1 w-20 py-0.5"
                                aria-label={`${ROLE_LABEL[r] ?? r} column in ${s.sheet}`}
                                value={mapping[s.sheet]?.[r] ?? ''}
                                onChange={(e) => {
                                  const next = { ...(mapping[s.sheet] ?? {}) };
                                  if (e.target.value) next[r] = e.target.value;
                                  else delete next[r];
                                  setMapping({ ...mapping, [s.sheet]: next });
                                  reset();
                                }}
                              >
                                <option value="">—</option>
                                {COLS.map((c) => (
                                  <option key={c} value={c}>
                                    {c}
                                  </option>
                                ))}
                              </select>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {s.sample.map((row, i) => (
                          <tr key={i}>
                            {row.map((v, j) => (
                              <td key={j} className="max-w-[14rem] truncate text-[11.5px]" title={v ?? ''}>
                                {v ?? ''}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-primary" disabled={!projectReady || busy != null} onClick={() => void run(false)}>
              {busy === 'preview' ? 'Running the dry run…' : 'Run a dry run'}
            </button>
            {!projectReady && <span className="text-[12px] text-ink-mute">Choose a project first.</span>}
          </div>
        </section>
      )}

      {result && (
        <section className="card p-4" aria-labelledby="step-result" aria-live="polite">
          <h2 id="step-result" className="text-[13.5px] font-semibold">
            {result.mode === 'PREVIEW' ? '4. Dry run — nothing has been imported yet' : 'Imported'}
          </h2>
          {result.project && <p className="mt-1 text-[12px] text-ink-soft">Project: {result.project.name}</p>}
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {(
              [
                ['To create', result.counts.create],
                ['To update', result.counts.update],
                ['Unchanged', result.counts.unchanged],
                ['Conflicts', result.counts.conflicts],
                ['Ambiguous rows', result.counts.ambiguous],
                ['Skipped rows', result.counts.skipped],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="rounded border border-line px-3 py-2">
                <div className="text-2xs font-semibold uppercase tracking-wide text-ink-mute">{result.mode === 'APPLIED' ? k.replace('To create', 'Created').replace('To update', 'Updated') : k}</div>
                <div className="text-[17px] font-semibold">{formatNumber(v)}</div>
              </div>
            ))}
          </div>
          {result.issues.length > 0 && (
            <details className="mt-3" open={result.issues.length <= 20}>
              <summary className="cursor-pointer text-[12.5px] font-medium">
                {formatNumber(result.issueTotal)} note(s) on rows that need a person to decide{result.issueTotal > result.issues.length ? ` (first ${formatNumber(result.issues.length)} shown)` : ''}
              </summary>
              <div className="mt-2 max-h-96 overflow-auto">
                <table className="table table-compact">
                  <thead>
                    <tr>
                      <th>Workbook</th>
                      <th>Sheet</th>
                      <th className="num">Row</th>
                      <th>Value</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.issues.map((i, n) => (
                      <tr key={n}>
                        <td className="max-w-[12rem] truncate" title={i.workbook ?? ''}>
                          {i.workbook ?? '—'}
                        </td>
                        <td>{i.sheet ?? '—'}</td>
                        <td className="num">{i.row ?? '—'}</td>
                        <td className="whitespace-nowrap font-mono text-[11px]">{i.value ?? '—'}</td>
                        <td className="min-w-[20rem]">{i.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          {result.mode === 'PREVIEW' && (
            <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-3">
              <label className="inline-flex items-center gap-2 text-[12.5px]">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> I have checked the dry run and want to import this workbook.
              </label>
              <button type="button" className="btn btn-primary" disabled={!confirmed || busy != null} onClick={() => void run(true)}>
                {busy === 'commit' ? 'Importing…' : 'Import'}
              </button>
            </div>
          )}
        </section>
      )}

      <section className="card p-4" aria-labelledby="history">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="history" className="mr-auto text-[13.5px] font-semibold">
            Import history
          </h2>
          <span className="text-[12px] text-ink-mute">Templates:</span>
          {typeOptions.map(([k, v]) => (
            <a key={k} className="btn btn-sm" href={`/api/import-centre/template?type=${k}`}>
              {v}
            </a>
          ))}
        </div>
        {undoMsg && <p className="mt-2 text-[12.5px] text-emerald-800">{undoMsg}</p>}
        {runs.length === 0 ? (
          <p className="mt-3 text-[12px] text-ink-mute">No imports yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>File</th>
                  <th>Type</th>
                  <th>Project</th>
                  <th className="num">Created</th>
                  <th className="num">Updated</th>
                  <th className="num">Notes</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap">{formatDateTime(r.when)}</td>
                    <td className="whitespace-nowrap">{r.who ?? '—'}</td>
                    <td className="max-w-[16rem] truncate" title={r.files ?? ''}>
                      {r.files ?? '—'}
                    </td>
                    <td className="whitespace-nowrap">{r.fileTypeLabel}</td>
                    <td className="whitespace-nowrap">{r.project ?? '—'}</td>
                    <td className="num">{formatNumber(r.created)}</td>
                    <td className="num">{formatNumber(r.updated)}</td>
                    <td className="num">{formatNumber(r.warnings)}</td>
                    <td className={clsx('whitespace-nowrap', r.status === 'Undone' && 'text-ink-mute')}>
                      {r.status}
                      {r.undoneBy ? ` by ${r.undoneBy}` : ''}
                    </td>
                    <td>
                      {r.canUndo &&
                        (armed === r.id ? (
                          <span className="inline-flex items-center gap-1.5">
                            <button type="button" className="btn btn-sm btn-danger" disabled={busy != null} onClick={() => void undo(r.id)}>
                              {busy === 'undo' ? 'Undoing…' : 'Confirm undo'}
                            </button>
                            <button type="button" className="btn btn-sm" onClick={() => setArmed(null)}>
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button type="button" className="btn btn-sm" disabled={busy != null} onClick={() => setArmed(r.id)} title="Removes what this import created and puts back what it changed, unless someone has edited it since.">
                            Undo this import
                          </button>
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
