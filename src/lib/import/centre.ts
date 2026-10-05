/**
 * Import Centre — one place to bring a workbook in, for Administrators and
 * Managers.
 *
 *   upload    .xlsx only (extension, content type, size; macro-enabled and
 *             macro-carrying files refused), stored under the import folder
 *   inspect   sheets, header rows, the detected file type and a column-mapping
 *             preview the user can correct (remembered per project and type)
 *   preview   a dry run: what would be created / updated / left, conflicts,
 *             ambiguous rows and skipped rows — nothing written but the run row
 *   commit    the same, written in one transaction, after confirmation
 *   undo      the latest run only: removes what it created and puts back the
 *             field changes it recorded, never a field changed since
 *
 * File types:
 *   PLAN          Drawing register / 03-Year Plan  (its Design Fee sheet too)
 *   DESIGN_FEE    Base DFS / Design Fee sheet on its own (re-links drawings)
 *   ACC           Autodesk Construction Cloud release export
 *   PROJECT_LIST  project full names and the parent → child hierarchy
 *
 * Nothing here knows a project: the same code reads every workbook, driven
 * by the sheet contents and the mapping the user confirms.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import * as XLSX from 'xlsx';
import { db, type DbLike } from '@/db';
import {
  dfsWbsNodes,
  disciplines,
  drawingImportBatches,
  drawingImportIssues,
  drawingRevisions,
  drawingSnapshots,
  drawings,
  importMappings,
  importRunChanges,
  packageFees,
  packages,
  projects,
} from '@/db/schema';
import { recordAudit, type Actor } from '@/lib/audit';
import { sourceDating } from '@/lib/updated-on';
import { newId } from '@/lib/ids';
import { IMPORT_FILE_TYPE_LABEL, projectLabel } from '@/lib/labels';
import { runDrawingImport } from './drawing-register';
import { textOf } from './drawing-register/apply';
import { chooseFeeSheet, feeSheetCandidates, parseDesignFee, type FeeSheetCandidate } from './drawing-register/design-fee';
import type { DrawingManifest } from './drawing-register/manifest';
import { centreManifest } from './centre-manifest';
import { layout, parseSources, sheetDiscipline, type ColumnOverrides } from './drawing-register/parse';
import { buildPlan, type PlanIssue } from './drawing-register/plan';
import { at, colIndex, parseCalendarDate, readTextWorkbook, type TextSheet } from './drawing-register/read';
import { applyProjectList, detectProjectList, planProjectList } from './project-list';
export { detectProjectList } from './project-list';

export const CENTRE_FILE_TYPES = ['PLAN', 'DESIGN_FEE', 'ACC', 'PROJECT_LIST'] as const;
export type CentreFileType = (typeof CENTRE_FILE_TYPES)[number];

export const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;
const XLSX_MIME = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream', ''];

export class ImportInputError extends Error {
  status = 400;
}

/** Where uploads are kept between inspect, preview and commit. */
export function uploadRoot() {
  return process.env.IMPORT_UPLOAD_DIR || path.join(os.tmpdir(), 'design-control-uploads');
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/** Refuse anything but a plain .xlsx workbook. */
export function validateUpload(name: string, mime: string, size: number, buf: Buffer) {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.xlsm' || ext === '.xlsb' || ext === '.xltm') throw new ImportInputError('Macro-enabled workbooks are not accepted. Save the file as an Excel Workbook (.xlsx) and upload it again.');
  if (ext !== '.xlsx') throw new ImportInputError('Only Excel Workbook (.xlsx) files can be imported.');
  if (!XLSX_MIME.includes(mime)) throw new ImportInputError('The file is not an Excel Workbook (.xlsx).');
  if (size <= 0 || buf.length === 0) throw new ImportInputError('The file is empty.');
  if (size > MAX_UPLOAD_BYTES || buf.length > MAX_UPLOAD_BYTES) throw new ImportInputError(`The file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
  // An .xlsx is a zip ("PK"); a macro project inside it is refused whatever the extension says.
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw new ImportInputError('The file is not an Excel Workbook (.xlsx).');
  // A macro project is a zip entry named …/vbaProject.bin (entry names are stored uncompressed).
  if (buf.includes(Buffer.from('vbaProject.bin'))) throw new ImportInputError('The workbook contains macros and is not accepted. Save a copy without macros as .xlsx.');
}

export function storeUpload(name: string, buf: Buffer) {
  const id = newId('upl_');
  const dir = path.join(uploadRoot(), id);
  fs.mkdirSync(dir, { recursive: true });
  const safe = path.basename(name).replace(/[^\w .()&+-]/g, '_');
  fs.writeFileSync(path.join(dir, safe), buf);
  return { uploadId: id, fileName: safe };
}

export function uploadPath(uploadId: string) {
  if (!/^upl_[a-z0-9]+$/i.test(uploadId)) throw new ImportInputError('Unknown upload.');
  const dir = path.join(uploadRoot(), uploadId);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.xlsx')) : [];
  if (!files.length) throw new ImportInputError('The upload has expired. Please upload the file again.');
  return { dir, fileName: files[0], file: path.join(dir, files[0]) };
}

// ---------------------------------------------------------------------------
// Inspect: sheets, type, mapping preview
// ---------------------------------------------------------------------------

export const PLAN_ROLES = ['number', 'title', 'location', 'batchCode', 'batch', 'revision', 'discipline', 'releaseDate', 'issuedTill'] as const;
export const ACC_ROLES = ['number', 'title', 'releaseDate', 'versions', 'collection', 'discipline'] as const;
export const ROLE_LABEL: Record<string, string> = {
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

export interface SheetMapping {
  sheet: string;
  headerRow: number;
  discipline?: string | null;
  columns: Record<string, string | null>;
  sample: (string | null)[][];
}

export interface Inspection {
  fileName: string;
  sheets: { name: string; rows: number; hidden: boolean }[];
  detected: CentreFileType | null;
  reason: string;
  mapping: SheetMapping[];
  designFee: {
    sheet: string;
    packages: number;
    headings: number;
    layout: string | null;
    /** The sheet's own title ("0072 | After the Rain Phase 2c"): the default full name of a new project. */
    title: { code: string | null; name: string } | null;
    /** Every Design Fee sheet of the workbook, the one used first; the user may choose another. */
    candidates: FeeSheetCandidate[];
    problem: string | null;
  } | null;
}

const letter = (c: number) => (c >= 0 ? XLSX.utils.encode_col(c) : null);

const ACC_HEADERS: Record<(typeof ACC_ROLES)[number], RegExp> = {
  number: /^(number|sheet number|drawing number|name)$/i,
  title: /^(title|sheet title|drawing name|description)$/i,
  releaseDate: /^(date of release|release date|released( on| date)?|published( on)?)$/i,
  versions: /^(total versions|versions?)$/i,
  collection: /^(collection|set|folder)$/i,
  discipline: /^discipline$/i,
};

function accLayout(s: TextSheet, overrides: Record<string, string> = {}) {
  for (let r = 0; r < Math.min(10, s.rows.length); r++) {
    const row = s.rows[r] ?? [];
    const cols: Record<string, number> = {};
    row.forEach((v, c) => {
      if (!v) return;
      for (const [k, re] of Object.entries(ACC_HEADERS)) if (cols[k] == null && re.test(v.trim())) cols[k] = c;
    });
    for (const [k, v] of Object.entries(overrides)) if (v) cols[k] = colIndex(v.toUpperCase());
    if (cols.number != null && cols.releaseDate != null) return { headerRow: r, cols };
  }
  return null;
}

/** Look at a workbook: its sheets, what kind of file it is, and how its columns map. */
export function inspectWorkbook(file: string, fileName: string, want?: CentreFileType | null, saved?: SavedMapping | null): Inspection {
  const sheets = readTextWorkbook(file);
  const list = sheets.map((s) => ({ name: s.name, rows: s.rows.length, hidden: s.hidden }));
  const planSheets = sheets.filter((s) => !s.hidden && layout(s)?.title != null && (layout(s)?.title ?? -1) >= 0);
  const feeChoice = chooseFeeSheet(sheets, saved?.feeSheet);
  const feeSheet = feeChoice ? sheets.find((s) => s.name === feeChoice.sheet) : undefined;
  const accSheet = sheets.find((s) => accLayout(s));
  const listSheet = sheets.map((s) => detectProjectList(s)).find(Boolean);
  let detected: CentreFileType | null = null;
  let reason = 'No sheet looks like a drawing list, a Design Fee sheet, an Autodesk Construction Cloud export or a Project List.';
  if (listSheet) {
    detected = 'PROJECT_LIST';
    reason = `Sheet "${listSheet.sheet}" has project code and full name columns.`;
  } else if (planSheets.length) {
    detected = 'PLAN';
    reason = `${planSheets.length} drawing list sheet(s) with a Location column${feeSheet ? ', and a Design Fee sheet' : ''}.`;
  } else if (feeSheet) {
    detected = 'DESIGN_FEE';
    reason = `Sheet "${feeSheet.name}" has discipline fee columns.`;
  } else if (accSheet) {
    detected = 'ACC';
    reason = `Sheet "${accSheet.name}" has drawing number and release date columns.`;
  }
  const type = want ?? detected;

  const sample = (s: TextSheet, from: number, cols: number[]) =>
    s.rows.slice(from, from + 5).map((r) => cols.map((c) => (c >= 0 ? at(r, c) : null)));
  const mapping: SheetMapping[] = [];
  let designFee: Inspection['designFee'] = null;
  if (type === 'PLAN') {
    for (const s of planSheets) {
      const over = (saved?.columns?.[s.name] ?? saved?.columns?.['*'] ?? {}) as ColumnOverrides;
      const L = layout(s, over)!;
      const columns: Record<string, string | null> = {
        number: letter(L.leftCols[L.leftCols.length - 1] ?? -1),
        title: letter(L.title),
        location: letter(L.loc),
        batchCode: letter(L.batchCode),
        batch: letter(L.batch),
        revision: letter(L.revision),
        discipline: letter(L.discipline),
        releaseDate: letter(L.releaseDate),
        issuedTill: letter(L.issuedTill),
      };
      const idx = Object.values(columns).map((v) => (v ? colIndex(v) : -1));
      const fromName = sheetDiscipline(s.name);
      const known = /^(AR|ST|MEP|LS|MP|UD|ID|PHE|ELE|IBMS|INFRA)$/.test(fromName) ? fromName : null;
      mapping.push({ sheet: s.name, headerRow: L.header + 1, discipline: saved?.disciplines?.[s.name] ?? known, columns, sample: sample(s, L.header + 3, idx) });
    }
  }
  if ((type === 'PLAN' || type === 'DESIGN_FEE') && feeSheet) {
    const candidates = feeSheetCandidates(sheets);
    try {
      const p = parseDesignFee({ file, projectCode: 'PREVIEW' }, feeSheet, { labelPrefix: '^GFC\\s*\\|\\s*', nodeTypes: [] });
      designFee = { sheet: feeSheet.name, packages: p.packages.length, headings: p.nodes.length, layout: p.layout ?? null, title: p.title ?? null, candidates, problem: null };
    } catch (e) {
      // Reported, never fatal: the drawings still import, and another sheet can be chosen.
      designFee = { sheet: feeSheet.name, packages: 0, headings: 0, layout: null, title: null, candidates, problem: e instanceof Error ? e.message : String(e) };
    }
  }
  if (type === 'ACC') {
    for (const s of sheets) {
      const a = accLayout(s, (saved?.columns?.[s.name] ?? {}) as Record<string, string>);
      if (!a) continue;
      const columns = Object.fromEntries(ACC_ROLES.map((k) => [k, letter(a.cols[k] ?? -1)]));
      mapping.push({ sheet: s.name, headerRow: a.headerRow + 1, columns, sample: sample(s, a.headerRow + 1, ACC_ROLES.map((k) => a.cols[k] ?? -1)) });
    }
  }
  if (type === 'PROJECT_LIST') {
    for (const s of sheets) {
      const p = detectProjectList(s);
      if (!p) continue;
      const cols = p.columns as Record<string, number | undefined>;
      const keys = ['code', 'shortName', 'fullName', 'parent', 'order'];
      mapping.push({
        sheet: s.name,
        headerRow: p.headerRow,
        columns: Object.fromEntries(keys.map((k) => [k, letter(cols[k] ?? -1)])),
        sample: sample(s, p.headerRow, keys.map((k) => cols[k] ?? -1)),
      });
    }
  }
  return { fileName, sheets: list, detected, reason, mapping, designFee };
}

// ---------------------------------------------------------------------------
// Remembered mappings
// ---------------------------------------------------------------------------

export interface SavedMapping {
  /** sheet name ('*' = every sheet) → role → column letter */
  columns?: Record<string, Record<string, string>>;
  /** sheet name → discipline code */
  disciplines?: Record<string, string>;
  /** The Design Fee sheet chosen for this project, when the workbook has several. */
  feeSheet?: string | null;
  /** How its fees are read (AUTO, DISCIPLINE_BLOCKS, PACKAGE_TOTAL). */
  feeLayout?: 'AUTO' | 'DISCIPLINE_BLOCKS' | 'PACKAGE_TOTAL' | null;
}

export async function savedMapping(projectId: string | null | undefined, fileType: string): Promise<SavedMapping | null> {
  if (!projectId) return null;
  const [m] = await db.select().from(importMappings).where(and(eq(importMappings.projectId, projectId), eq(importMappings.fileType, fileType))).limit(1);
  if (!m) return null;
  try {
    return JSON.parse(m.mapping) as SavedMapping;
  } catch {
    return null;
  }
}

async function rememberMapping(tx: DbLike, projectId: string, fileType: string, mapping: SavedMapping, actor: Actor) {
  const text = JSON.stringify(mapping);
  await tx
    .insert(importMappings)
    .values({ id: newId('imm_'), projectId, fileType, mapping: text, updatedByLabel: actor.label, updatedAt: new Date() })
    .onConflictDoUpdate({ target: [importMappings.projectId, importMappings.fileType], set: { mapping: text, updatedByLabel: actor.label, updatedAt: new Date() } });
}

// ---------------------------------------------------------------------------
// Preview / commit
// ---------------------------------------------------------------------------

export interface NewProjectInput {
  fullName: string;
  shortCode?: string | null;
  parentProjectId?: string | null;
}

export interface CentreImportInput {
  file: string;
  fileName: string;
  fileType: CentreFileType;
  projectId?: string | null;
  newProject?: NewProjectInput | null;
  mapping?: SavedMapping | null;
  apply: boolean;
  actor: Actor;
}

export interface CentreIssue {
  severity: string;
  code: string;
  workbook: string | null;
  sheet: string | null;
  row: number | null;
  value: string | null;
  message: string;
}

export interface CentreImportResult {
  mode: 'PREVIEW' | 'APPLIED';
  batchId: string | null;
  fileType: CentreFileType;
  project: { id: string | null; name: string } | null;
  counts: { create: number; update: number; unchanged: number; conflicts: number; ambiguous: number; skipped: number };
  issues: CentreIssue[];
  preview: unknown;
}

const AMBIGUOUS = /AMBIGUOUS|CONFLICT|MULTI_BATCH|DUPLICATE/;
const SKIPPED = /SKIPPED|NOT_IMPORTED|WITHOUT_FEE_PACKAGE|UNMAPPED|NOT_FOUND|NO_SHEET_TOTAL/;

function toIssue(i: PlanIssue): CentreIssue {
  const p = i.payload as Record<string, unknown> | undefined;
  return {
    severity: i.severity,
    code: i.code,
    workbook: i.workbook ?? null,
    sheet: i.sheet ?? null,
    row: i.rowNumber ?? null,
    value: i.drawingNumber ?? (p && typeof p.batch === 'string' ? p.batch : null),
    message: i.message,
  };
}

/** A project code for a new project: the short code given, else one made from the full name. */
async function newProjectCode(tx: DbLike, input: NewProjectInput) {
  const base = (input.shortCode?.trim() || input.fullName)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'PROJECT';
  const taken = new Set((await tx.select({ c: projects.projectCode }).from(projects)).map((r) => r.c));
  if (input.shortCode && taken.has(base)) throw new ImportInputError(`A project with the code ${base} already exists. Choose it from the list instead.`);
  let code = base;
  for (let i = 2; taken.has(code); i++) code = `${base}-${i}`;
  return code;
}

async function resolveProject(input: CentreImportInput) {
  if (input.projectId) {
    const [p] = await db.select().from(projects).where(eq(projects.id, input.projectId)).limit(1);
    if (!p) throw new ImportInputError('The chosen project does not exist.');
    return { existing: p, code: p.projectCode, name: projectLabel(p) };
  }
  if (input.newProject?.fullName?.trim()) {
    return { existing: null, code: await newProjectCode(db, input.newProject), name: input.newProject.fullName.trim() };
  }
  return null;
}

function manifestFor(input: CentreImportInput, code: string, name: string): DrawingManifest {
  const fileType = input.fileType === 'DESIGN_FEE' ? 'DESIGN_FEE' : 'PLAN';
  return centreManifest({ fileName: input.fileName, fileType, sheets: readTextWorkbook(input.file), mapping: input.mapping, code, name });
}

/**
 * The fee layout a project's fees are already stored in: DISCIPLINE_BLOCKS
 * when its packages carry per-discipline fee lines and no whole-package fee,
 * PACKAGE_TOTAL the other way round, null when it has no fees yet. A
 * re-import keeps it unless the user chooses another layout.
 */
export async function storedFeeLayout(projectId: string): Promise<'DISCIPLINE_BLOCKS' | 'PACKAGE_TOTAL' | null> {
  const [r] = await db
    .select({
      lines: sql<number>`(select count(*)::int from ${packageFees} f join ${packages} k on k.id = f.package_id where k.project_id = ${projectId} and f.fee_value is not null)`,
      whole: sql<number>`(select count(*)::int from ${packages} k where k.project_id = ${projectId} and k.fee_value is not null)`,
    })
    .from(sql`(select 1) x`);
  if (r.lines > 0 && r.whole === 0) return 'DISCIPLINE_BLOCKS';
  if (r.whole > 0 && r.lines === 0) return 'PACKAGE_TOTAL';
  return null;
}

/** Dry run (apply = false) or commit (apply = true) of one uploaded workbook. */
export async function runCentreImport(input: CentreImportInput): Promise<CentreImportResult> {
  if (input.fileType === 'PROJECT_LIST') return runProjectList(input);
  if (input.fileType === 'ACC') return runAcc(input);
  const project = await resolveProject(input);
  if (!project) throw new ImportInputError('Choose a project, or give the full name of a new one.');
  if (project.existing && !(input.mapping?.feeLayout && input.mapping.feeLayout !== 'AUTO')) {
    const kept = await storedFeeLayout(project.existing.id);
    if (kept) input = { ...input, mapping: { ...(input.mapping ?? {}), feeLayout: kept } };
  }
  const manifest = manifestFor(input, project.code, project.name);
  if (!manifest.planWorkbooks.length && !manifest.designFees.length) throw new ImportInputError('The workbook has no drawing list or Design Fee sheet to import.');

  // A new project: nothing in the database to compare against — everything is new.
  if (!project.existing && !input.apply) {
    const src = parseSources(manifest, path.dirname(input.file));
    const plan = buildPlan(manifest, src);
    const issues = plan.issues.map(toIssue);
    return {
      mode: 'PREVIEW',
      batchId: null,
      fileType: input.fileType,
      project: { id: null, name: project.name },
      counts: {
        create: plan.drawings.length,
        update: 0,
        unchanged: 0,
        conflicts: plan.conflicts.length,
        ambiguous: issues.filter((i) => AMBIGUOUS.test(i.code)).length,
        skipped: issues.filter((i) => SKIPPED.test(i.code)).length,
      },
      issues,
      preview: { drawings: plan.drawings.length, packages: plan.packages.length, headings: plan.wbsNodes.length, sheets: src.sheetsRead },
    };
  }

  let projectId = project.existing?.id ?? null;
  if (!projectId && input.apply) {
    projectId = await createProject(input.newProject!, project.code, input.actor);
  }
  const result = await runDrawingImport({
    manifest,
    sourceFolder: path.dirname(input.file),
    apply: input.apply,
    actor: input.actor,
    meta: { fileType: input.fileType, fileNames: [input.fileName], projectId },
  }).catch(async (e) => {
    // A project created for this run and left empty by a failed import is removed again.
    if (!project.existing && projectId) await db.delete(projects).where(and(eq(projects.id, projectId), eq(projects.createdImportBatchId, 'pending')));
    throw e;
  });
  if (!project.existing && projectId) {
    await db.update(projects).set({ createdImportBatchId: result.batchId }).where(eq(projects.id, projectId));
  }
  if (input.apply && projectId && input.mapping && (input.mapping.columns || input.mapping.disciplines || input.mapping.feeSheet || input.mapping.feeLayout)) {
    await rememberMapping(db, projectId, input.fileType, input.mapping, input.actor);
  }
  const issues = result.issues.map(toIssue);
  return {
    mode: result.mode,
    batchId: result.batchId,
    fileType: input.fileType,
    project: { id: projectId, name: project.name },
    counts: {
      create: result.changes.create,
      update: result.changes.update,
      unchanged: result.changes.unchanged,
      conflicts: result.counts.total.numberConflicts,
      ambiguous: issues.filter((i) => AMBIGUOUS.test(i.code)).length,
      skipped: issues.filter((i) => SKIPPED.test(i.code)).length,
    },
    issues,
    preview: {
      drawings: result.counts.total.drawings,
      released: result.counts.total.released,
      notYetNumbered: result.counts.total.notYetNumbered,
      packages: Object.values(result.counts.packages).reduce((a, b) => a + b, 0),
      headings: Object.values(result.counts.wbsNodes ?? {}).reduce((a, b) => a + b, 0),
      linked: Object.values(result.counts.packageLinkedDrawings).reduce((a, b) => a + b, 0),
      relinked: result.applied?.relinked ?? null,
      sheets: result.sheetsRead,
    },
  };
}

async function createProject(np: NewProjectInput, code: string, actor: Actor) {
  const id = newId('pr_');
  await db.insert(projects).values({
    id,
    projectCode: code,
    projectName: np.fullName.trim(),
    displayName: np.fullName.trim(),
    parentProjectId: np.parentProjectId || null,
    createdImportBatchId: 'pending',
    updatedAt: new Date(),
  });
  await recordAudit({ actor, entityType: 'PROJECT', entityId: id, entityLabel: np.fullName.trim(), action: 'CREATE', reason: 'Import Centre — new project' });
  return id;
}

// ---------------------------------------------------------------------------
// Project List
// ---------------------------------------------------------------------------

async function runProjectList(input: CentreImportInput): Promise<CentreImportResult> {
  const sheets = readTextWorkbook(input.file);
  const over = input.mapping?.columns ?? {};
  let parse = null;
  for (const s of sheets) {
    const o = over[s.name] ?? over['*'];
    const cols = o ? Object.fromEntries(Object.entries(o).filter(([, v]) => v).map(([k, v]) => [k, colIndex(v.toUpperCase())])) : {};
    parse = detectProjectList(s, cols);
    if (parse) break;
  }
  if (!parse) throw new ImportInputError('No sheet with a project code (or short name) column and a full name column was found.');
  const plan = await planProjectList(parse, input.fileName);
  const issues = plan.issues.map(toIssue);
  const preview = plan.items.map((i) => ({ row: i.row.row, code: i.code, fullName: i.displayName, parent: i.parentCode, action: i.action, changes: i.changes }));
  const counts = { create: plan.counts.create, update: plan.counts.update, unchanged: plan.counts.unchanged, conflicts: 0, ambiguous: 0, skipped: issues.filter((i) => i.severity !== 'INFO').length };
  if (!input.apply) return { mode: 'PREVIEW', batchId: null, fileType: 'PROJECT_LIST', project: null, counts, issues, preview };
  const batchId = newId('dib_');
  await db.transaction(async (tx) => {
    await tx.insert(drawingImportBatches).values({
      id: batchId,
      manifest: IMPORT_FILE_TYPE_LABEL.PROJECT_LIST,
      status: 'APPLIED',
      startedById: input.actor.id,
      startedByLabel: input.actor.label,
      fileType: 'PROJECT_LIST',
      fileNames: input.fileName,
      finishedAt: new Date(),
      createdCount: counts.create,
      updatedCount: counts.update,
      warningCount: issues.length,
      summaryJson: JSON.stringify({ counts, preview }),
    });
    await applyProjectList(tx, plan, batchId, input.actor);
    if (plan.issues.length) await tx.insert(drawingImportIssues).values(plan.issues.map((i) => issueRow(batchId, i)));
  });
  return { mode: 'APPLIED', batchId, fileType: 'PROJECT_LIST', project: null, counts, issues, preview };
}

function issueRow(batchId: string, i: PlanIssue) {
  return {
    id: newId('dii_'),
    batchId,
    severity: i.severity,
    code: i.code,
    projectCode: i.projectCode ?? null,
    drawingNumber: i.drawingNumber ?? null,
    workbook: i.workbook ?? null,
    sheet: i.sheet ?? null,
    rowNumber: i.rowNumber ?? null,
    message: i.message,
    payload: i.payload ? JSON.stringify(i.payload) : null,
  };
}

// ---------------------------------------------------------------------------
// Autodesk Construction Cloud release export
// ---------------------------------------------------------------------------

const numKey = (s: string) => s.toUpperCase().replace(/\s+/g, '');

async function runAcc(input: CentreImportInput): Promise<CentreImportResult> {
  const project = await resolveProject(input);
  if (!project?.existing) throw new ImportInputError('An Autodesk Construction Cloud export updates the drawings of an existing project. Choose the project.');
  const projectId = project.existing.id;
  const sheets = readTextWorkbook(input.file);
  const over = input.mapping?.columns ?? {};
  const rows: { sheet: string; row: number; number: string; title: string | null; releaseDate: Date | null; dateText: string | null }[] = [];
  const issues: CentreIssue[] = [];
  for (const s of sheets) {
    const a = accLayout(s, (over[s.name] ?? over['*'] ?? {}) as Record<string, string>);
    if (!a) continue;
    for (let r = a.headerRow + 1; r < s.rows.length; r++) {
      const x = s.rows[r] ?? [];
      const number = at(x, a.cols.number);
      if (!number) continue;
      const dateText = at(x, a.cols.releaseDate);
      const releaseDate = parseCalendarDate(dateText);
      if (dateText && !releaseDate) {
        issues.push({ severity: 'WARNING', code: 'ACC_DATE_UNREADABLE', workbook: input.fileName, sheet: s.name, row: r + 1, value: dateText, message: `The release date "${dateText}" of ${number} could not be read; the row is skipped.` });
        continue;
      }
      rows.push({ sheet: s.name, row: r + 1, number, title: a.cols.title != null ? at(x, a.cols.title) : null, releaseDate, dateText });
    }
  }
  if (!rows.length) throw new ImportInputError('No sheet with a drawing number column and a release date column was found.');
  const existing = await db
    .select({ id: drawings.id, code: drawings.drawingCode, number: drawings.drawingNumber, status: drawings.completionStatus, actual: drawings.actualReleaseDate, edited: drawings.userEditedFields })
    .from(drawings)
    .where(eq(drawings.projectId, projectId));
  const byNo = new Map<string, typeof existing>();
  for (const e of existing) for (const k of new Set([e.code, e.number].filter(Boolean).map((v) => numKey(v!)))) byNo.set(k, [...(byNo.get(k) ?? []), e]);
  const seen = new Map<string, number>();
  type Change = { id: string; number: string; release: boolean; actual: Date | null; from: { status: string; actual: Date | null } };
  const changes: Change[] = [];
  let unchanged = 0;
  for (const r of rows) {
    const k = numKey(r.number);
    if (seen.has(k)) {
      issues.push({ severity: 'WARNING', code: 'ACC_DUPLICATE_NUMBER', workbook: input.fileName, sheet: r.sheet, row: r.row, value: r.number, message: `${r.number} repeats row ${seen.get(k)}; the first row is used.` });
      continue;
    }
    seen.set(k, r.row);
    const hit = byNo.get(k) ?? [];
    if (hit.length === 0) {
      issues.push({ severity: 'WARNING', code: 'ACC_NUMBER_NOT_FOUND', workbook: input.fileName, sheet: r.sheet, row: r.row, value: r.number, message: `${r.number} is not a drawing of ${project.name}; nothing is created for it.` });
      continue;
    }
    if (hit.length > 1) {
      issues.push({ severity: 'WARNING', code: 'ACC_NUMBER_AMBIGUOUS', workbook: input.fileName, sheet: r.sheet, row: r.row, value: r.number, message: `${r.number} matches ${hit.length} drawings; left for a person to decide.` });
      continue;
    }
    const e = hit[0];
    const edited = new Set(e.edited.split(',').filter(Boolean));
    if (!r.releaseDate) {
      unchanged++;
      continue;
    }
    if (e.status === 'COMPLETED' && e.actual) {
      unchanged++;
      continue;
    }
    if (edited.has('completionStatus') || edited.has('actualReleaseDate')) {
      issues.push({ severity: 'INFO', code: 'FIELD_PROTECTED_USER_EDIT', workbook: input.fileName, sheet: r.sheet, row: r.row, value: r.number, message: `${r.number}: the release was set in Drawing Control and is kept.` });
      continue;
    }
    changes.push({ id: e.id, number: r.number, release: e.status !== 'COMPLETED', actual: r.releaseDate, from: { status: e.status, actual: e.actual } });
  }
  const counts = {
    create: 0,
    update: changes.length,
    unchanged,
    conflicts: 0,
    ambiguous: issues.filter((i) => AMBIGUOUS.test(i.code)).length,
    skipped: issues.filter((i) => SKIPPED.test(i.code) || i.code === 'ACC_DATE_UNREADABLE' || i.code === 'ACC_DUPLICATE_NUMBER').length,
  };
  const preview = { rows: rows.length, releases: changes.filter((c) => c.release).length, datesAdded: changes.filter((c) => !c.release).length };
  if (!input.apply) return { mode: 'PREVIEW', batchId: null, fileType: 'ACC', project: { id: projectId, name: project.name }, counts, issues, preview };

  const batchId = newId('dib_');
  const stamp = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(drawingImportBatches).values({
      id: batchId,
      manifest: IMPORT_FILE_TYPE_LABEL.ACC,
      status: 'APPLIED',
      startedById: input.actor.id,
      startedByLabel: input.actor.label,
      fileType: 'ACC',
      fileNames: input.fileName,
      projectId,
      finishedAt: stamp,
      updatedCount: changes.length,
      warningCount: issues.length,
      summaryJson: JSON.stringify({ counts, preview }),
    });
    for (const c of changes) {
      const patch = { completionStatus: 'COMPLETED', actualReleaseDate: c.actual, releaseEvidence: `Autodesk Construction Cloud export ${input.fileName}` };
      // "Updated On" shows the ACC release date (the source date), never the time of this import.
      await tx.update(drawings).set({ ...patch, ...sourceDating(c.actual, null), updatedAt: stamp }).where(eq(drawings.id, c.id));
      await tx.insert(importRunChanges).values([
        { id: newId('irc_'), batchId, entityType: 'DRAWING', entityId: c.id, field: 'completionStatus', oldValue: c.from.status, newValue: 'COMPLETED' },
        { id: newId('irc_'), batchId, entityType: 'DRAWING', entityId: c.id, field: 'actualReleaseDate', oldValue: textOf(c.from.actual), newValue: textOf(c.actual) },
      ]);
      await recordAudit(
        { actor: input.actor, entityType: 'DRAWING', entityId: c.id, entityLabel: c.number, action: c.release ? 'RELEASE_DRAWING' : 'UPDATE_DRAWING', field: 'actualReleaseDate', oldValue: textOf(c.from.actual), newValue: textOf(c.actual), reason: `Autodesk Construction Cloud export ${input.fileName}`, projectId },
        tx,
      );
    }
    if (issues.length)
      await tx.insert(drawingImportIssues).values(
        issues.map((i) => ({ id: newId('dii_'), batchId, severity: i.severity, code: i.code, projectCode: project.code, drawingNumber: i.value, workbook: i.workbook, sheet: i.sheet, rowNumber: i.row, message: i.message, payload: null })),
      );
    if (input.mapping?.columns) await rememberMapping(tx, projectId, 'ACC', input.mapping, input.actor);
  });
  return { mode: 'APPLIED', batchId, fileType: 'ACC', project: { id: projectId, name: project.name }, counts, issues, preview };
}

// ---------------------------------------------------------------------------
// History and undo
// ---------------------------------------------------------------------------

export async function importHistory(limit = 50) {
  const rows = await db
    .select()
    .from(drawingImportBatches)
    .where(eq(drawingImportBatches.status, 'APPLIED'))
    .orderBy(desc(drawingImportBatches.startedAt))
    .limit(limit);
  const prj = await db.select({ id: projects.id, displayName: projects.displayName, projectName: projects.projectName, projectCode: projects.projectCode }).from(projects);
  const nameOf = new Map(prj.map((p) => [p.id, projectLabel(p)]));
  const latest = rows.find((r) => !r.undoneAt);
  return rows.map((r) => ({
    id: r.id,
    who: r.startedByLabel,
    when: r.finishedAt ?? r.startedAt,
    fileType: r.fileType,
    fileTypeLabel: r.fileType ? IMPORT_FILE_TYPE_LABEL[r.fileType] ?? 'Drawing sources (command line)' : 'Drawing sources (command line)',
    files: r.fileNames,
    project: r.projectId ? nameOf.get(r.projectId) ?? null : null,
    created: r.createdCount,
    updated: r.updatedCount,
    warnings: r.warningCount,
    status: r.undoneAt ? 'Undone' : 'Imported',
    undoneAt: r.undoneAt,
    undoneBy: r.undoneByLabel,
    canUndo: latest?.id === r.id,
  }));
}

const split = (s: string | null) => new Set((s ?? '').split(',').filter(Boolean));

/**
 * Undo the latest import run. Removes the rows it created and puts back the
 * field values it changed — skipping anything changed since (a manual edit
 * or a later run), which is reported instead.
 */
export async function undoImport(batchId: string, actor: Actor) {
  const [latest] = await db
    .select()
    .from(drawingImportBatches)
    .where(and(eq(drawingImportBatches.status, 'APPLIED'), sql`${drawingImportBatches.undoneAt} is null`))
    .orderBy(desc(drawingImportBatches.startedAt))
    .limit(1);
  if (!latest || latest.id !== batchId) throw new ImportInputError('Only the latest import can be undone.');
  return db.transaction(async (tx) => {
    const kept: string[] = [];
    let reverted = 0;
    // 1. Field changes on rows that existed before the run.
    const changes = await tx.select().from(importRunChanges).where(eq(importRunChanges.batchId, batchId));
    for (const c of changes) {
      if (c.entityType === 'DRAWING') {
        const [d] = await tx.select().from(drawings).where(eq(drawings.id, c.entityId)).limit(1);
        if (!d) continue;
        const cur = textOf((d as Record<string, unknown>)[c.field]);
        if (cur !== c.newValue || split(d.userEditedFields).has(c.field)) {
          kept.push(`${d.drawingCode}: ${c.field} changed since the import — kept`);
          continue;
        }
        await tx.update(drawings).set({ [c.field]: fieldValue(c.field, c.oldValue), updatedAt: new Date() } as never).where(eq(drawings.id, d.id));
        reverted++;
      } else if (c.entityType === 'PROJECT') {
        const [p] = await tx.select().from(projects).where(eq(projects.id, c.entityId)).limit(1);
        if (!p) continue;
        const cur = textOf((p as Record<string, unknown>)[c.field]);
        if (cur !== c.newValue) {
          kept.push(`${projectLabel(p)}: ${c.field} changed since the import — kept`);
          continue;
        }
        await tx.update(projects).set({ [c.field]: fieldValue(c.field, c.oldValue), updatedAt: new Date() } as never).where(eq(projects.id, p.id));
        reverted++;
      }
    }
    // 2. Rows the run created (children first). A created drawing someone has edited since stays.
    const created = await tx.select({ id: drawings.id, code: drawings.drawingCode, edited: drawings.userEditedFields }).from(drawings).where(eq(drawings.createdImportBatchId, batchId));
    const editedIds = created.filter((d) => d.edited).map((d) => d.id);
    for (const d of created.filter((x) => x.edited)) kept.push(`${d.code}: edited in Drawing Control since the import — kept`);
    const removeIds = created.filter((d) => !d.edited).map((d) => d.id);
    await tx.delete(drawingSnapshots).where(eq(drawingSnapshots.createdImportBatchId, batchId));
    await tx.delete(drawingRevisions).where(eq(drawingRevisions.createdImportBatchId, batchId));
    for (let i = 0; i < removeIds.length; i += 2000) await tx.delete(drawings).where(inArray(drawings.id, removeIds.slice(i, i + 2000)));
    // Packages / headings / fee lines the run created, unless something else now uses them.
    await tx.delete(packageFees).where(and(eq(packageFees.createdImportBatchId, batchId), sql`${packageFees.userEditedFields} = ''`));
    const newPkgs = await tx.select({ id: packages.id }).from(packages).where(eq(packages.createdImportBatchId, batchId));
    for (const p of newPkgs) {
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(drawings).where(eq(drawings.packageId, p.id));
      if (n === 0) await tx.delete(packages).where(eq(packages.id, p.id));
      else kept.push(`A package created by the import still holds ${n} drawing(s) — kept`);
    }
    const newNodes = await tx.select({ id: dfsWbsNodes.id }).from(dfsWbsNodes).where(eq(dfsWbsNodes.createdImportBatchId, batchId));
    for (let pass = 0; pass < 10; pass++) {
      let removed = 0;
      for (const nd of newNodes) {
        const [{ k }] = await tx
          .select({ k: sql<number>`((select count(*) from ${packages} where ${packages.wbsNodeId} = ${nd.id}) + (select count(*) from ${dfsWbsNodes} c where c.parent_id = ${nd.id}))::int` })
          .from(sql`(select 1) x`);
        if (k === 0) {
          const res = await tx.delete(dfsWbsNodes).where(eq(dfsWbsNodes.id, nd.id)).returning({ id: dfsWbsNodes.id });
          removed += res.length;
        }
      }
      if (!removed) break;
    }
    const newProjects = await tx.select({ id: projects.id }).from(projects).where(eq(projects.createdImportBatchId, batchId));
    for (const p of newProjects) {
      const [{ n }] = await tx
        .select({ n: sql<number>`((select count(*) from ${drawings} where ${drawings.projectId} = ${p.id}) + (select count(*) from ${packages} where ${packages.projectId} = ${p.id}) + (select count(*) from ${projects} c where c.parent_project_id = ${p.id}))::int` })
        .from(sql`(select 1) x`);
      if (n === 0) await tx.delete(projects).where(eq(projects.id, p.id));
      else kept.push('A project created by the import still holds records — kept');
    }
    await tx.update(drawingImportBatches).set({ undoneAt: new Date(), undoneByLabel: actor.label }).where(eq(drawingImportBatches.id, batchId));
    await recordAudit(
      { actor, entityType: 'DRAWING_IMPORT', entityId: batchId, entityLabel: latest.fileNames ?? latest.manifest, action: 'UNDO_IMPORT', newValue: JSON.stringify({ removedDrawings: removeIds.length, reverted, kept: kept.length }), reason: 'Undo this import' },
      tx,
    );
    return { removedDrawings: removeIds.length, keptDrawings: editedIds.length, reverted, kept };
  });
}

const DATE_FIELDS = new Set(['actualReleaseDate', 'currentExpectedReleaseDate', 'baselineReleaseDate', 'releasedAt', 'accCreatedAt']);
const INT_FIELDS = new Set(['displayOrder', 'versionCount', 'sourceRow']);

function fieldValue(field: string, v: string | null): unknown {
  if (v == null) return null;
  if (DATE_FIELDS.has(field)) return new Date(v);
  if (INT_FIELDS.has(field)) return Number(v);
  return v;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/** A blank workbook per file type, with the headers the Import Centre reads. */
export function templateWorkbook(type: CentreFileType): Buffer {
  const wb = XLSX.utils.book_new();
  if (type === 'PROJECT_LIST') {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Project code', 'Short name', 'Full name', 'Parent project code', 'Order']]), 'Project List');
  } else if (type === 'ACC') {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Number', 'Title', 'Collection', 'Total versions', 'Date of Release', 'Discipline']]), 'Released drawings');
  } else {
    const fee = [
      [null, null, null, null, 'AR', null, 'ST', null, 'MEP', null, 'LS'],
      [null, 'Outline', 'Package code', 'Package name', '%', 'Fee', '%', 'Fee', '%', 'Fee', '%', 'Fee'],
      [null, '1', null, 'Heading (e.g. Tower 01)'],
      [null, '1', 'T01-01', 'Package name'],
      [null, null, null, 'Design Fees'],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(fee), 'Design Fee');
    if (type === 'PLAN') {
      const list = [
        [null, 'Project name'],
        [null, 'Area of works', 'Sheet No', 'Dwg. No.', 'Drawing name', 'Location', 'Batch Code', 'Batch', "Till Dec'25", 'Date of release', 'Revision', 'Plan in 2026'],
        [],
        [null, 'AR', '100', 'AR-T01-100', 'Ground floor plan', 'T01', 'AR-T01-1', '1', null, null, 'R0', '1'],
        [null, 'AR', '101', 'AR-T01-101', 'First floor plan', 'T01', 'AR-T01-1', '1', null, null, 'R0', '1'],
        [null, 'AR', '102', 'AR-T01-102', 'Roof plan', 'T01', 'AR-T01-1', '1', null, null, 'R0', null],
      ];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(list), 'Drawing list | AR');
    }
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export async function disciplineOptions() {
  return db.select({ code: disciplines.code, name: disciplines.name }).from(disciplines).where(isNotNull(disciplines.code));
}
