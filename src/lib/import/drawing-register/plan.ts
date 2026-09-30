/**
 * Turns parsed source rows into an import plan: the current drawings, the
 * conflicts held back for a human, every source row as a snapshot, revision
 * history, plan moves between snapshots, issues and validation counts.
 *
 * Pure: no database access. `apply.ts` writes the plan.
 *
 * Source precedence (approved in Stage 1):
 *   - 03YPlan: the CURRENT workbook is the register; HISTORICAL workbooks are
 *     preserved as snapshots and contribute baseline plans and revisions only.
 *   - T09: the register sheets own number / title / location / batch /
 *     revision / membership; the ACC export owns release status, actual
 *     release date, collection, version count, tags and ACC discipline.
 *     `Created at` is a bulk-upload time and is never a release date.
 */
import { createHash } from 'node:crypto';
import { calendarQuarter } from '@/lib/periods';
import { SILENT_NULL_RULES, type DrawingManifest, type PhaseMapEntry, type PhaseRule } from './manifest';
import type { AccRow, PlanRow, RegisterRow } from './parse';
import { packageCodeForBatch, type DesignFeeParse } from './design-fee';

export type Severity = 'INFO' | 'WARNING' | 'ERROR';

export interface PlanIssue {
  severity: Severity;
  code: string;
  projectCode: string | null;
  drawingNumber?: string | null;
  workbook?: string | null;
  sheet?: string | null;
  rowNumber?: number | null;
  message: string;
  payload?: unknown;
}

export interface SourceRef {
  workbook: string;
  sheet: string;
  row: number;
}

export interface PlannedRevision {
  revision: string | null;
  sequence: number;
  released: boolean;
  releaseEvidence: string | null;
  actualReleaseDate: Date | null;
  expectedReleaseDate: Date | null;
  snapshotLabel: string;
  source: 'IMPORT' | 'ACC';
  ref: SourceRef;
}

export interface PlanPoint {
  date: Date;
  label: string;
  snapshotLabel: string;
  snapshotDate: Date | null;
}

export interface PlannedDrawing {
  sourceKey: string;
  projectCode: string;
  numberStatus: 'NUMBERED' | 'NOT_YET_NUMBERED';
  drawingCode: string;
  drawingNumber: string | null;
  partialNumber: string | null;
  drawingName: string;
  discipline: string;
  location: string | null;
  areaOfWorks: string | null;
  batchCode: string | null;
  batch: string | null;
  /** Fee package from the Design Fee sheet (base DFS): by the explicit batch
   *  rule, else by the drawing-list heading it sits under (logged). */
  packageCode: string | null;
  /** How packageCode was found: BATCH | HEADING, null when unmapped. */
  packageRule: 'BATCH' | 'HEADING' | null;
  /** Drawing-list heading rows above the current source row (context only). */
  sourceHeadings: string[];
  revision: string | null;
  phaseCode: string | null;
  phaseRule: PhaseRule | 'UNMAPPED';
  released: boolean;
  releaseEvidence: string | null;
  actualReleaseDate: Date | null;
  /** The latest revision date the source gives (a source date for "Updated On" when there is no release date). */
  sourceRevisionDate?: Date | null;
  /** Responsible Person from the source, when it has such a column (never invented). */
  responsibleText?: string | null;
  baselineReleaseDate: Date | null;
  currentExpectedReleaseDate: Date | null;
  planPeriodLabel: string | null;
  planHistory: PlanPoint[];
  revisions: PlannedRevision[];
  collection: string | null;
  versionCount: number | null;
  tags: string | null;
  accDiscipline: string | null;
  accCreatedAt: Date | null;
  ref: SourceRef;
}

export interface PlannedConflict {
  projectCode: string;
  conflictType: 'NUMBER_TITLE_CONFLICT' | 'ACC_ONLY_NUMBER';
  drawingNumber: string;
  message: string;
  candidates: Record<string, unknown>[];
}

export interface PlannedSnapshot {
  projectCode: string;
  drawingKey: string | null;
  snapshotRole: 'CURRENT' | 'HISTORICAL';
  sourceKind: 'PLAN' | 'REGISTER' | 'ACC';
  snapshotLabel: string;
  snapshotDate: Date | null;
  planYear: number | null;
  ref: SourceRef;
  disciplineCode: string | null;
  section: string | null;
  location: string | null;
  batchCode: string | null;
  batch: string | null;
  drawingNumber: string | null;
  numberKind: string | null;
  partialNumber: string | null;
  title: string | null;
  revision: string | null;
  released: boolean;
  issuedBeforeYear: boolean;
  issuedQuarter: number | null;
  plannedQuarter: number | null;
  explicitDateText: string | null;
  inAcc: string | null;
  collection: string | null;
  versionCount: number | null;
  tags: string | null;
  accDiscipline: string | null;
  accReleaseDate: Date | null;
  accCreatedAt: Date | null;
}

export interface ProjectCounts {
  drawings: number;
  released: number;
  notReleased: number;
  notYetNumbered: number;
  numberConflicts: number;
  accOnlyConflicts: number;
  actualDates: number;
}

export interface PlannedPackageFee {
  discipline: string;
  percent: number | null;
  fee: number | null;
  billedToDate: number | null;
  /** NA when the source gives this discipline no fee and no drawing is in the package. */
  applicability: 'APPLICABLE' | 'NA';
  drawings: number;
}

export interface PlannedPackage {
  projectCode: string;
  code: string;
  name: string;
  group: string | null;
  heading: string | null;
  /** Parent heading in the base-DFS tree (PlannedWbsNode.key). */
  nodeKey: string | null;
  sequence: number;
  phaseCode: string | null;
  /** Responsible Person from the source, when it has a column for it. */
  responsible: string | null;
  ref: SourceRef;
  fees: PlannedPackageFee[];
}

/** A heading of the base-DFS tree above packages (see design-fee.ts). */
export interface PlannedWbsNode {
  projectCode: string;
  key: string;
  parentKey: string | null;
  type: string;
  name: string;
  code: string | null;
  sourceLabel: string;
  sequence: number;
  ref: SourceRef;
}

/**
 * Resolve a drawing whose batch code is not a base-DFS package from the
 * drawing-list headings it sits under, innermost first. A heading resolves
 * only when it names exactly one package — by its full code (`BB02-2`) or by
 * its location token (`V40` in "Individual Home V40"; tokens of three or more
 * characters, as whole words). A heading naming several packages stops the
 * search as ambiguous; nothing is guessed.
 */
export function headingResolver(codes: string[]) {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const word = (x: string) => new RegExp(`(^|[^A-Za-z0-9])${esc(x)}($|[^A-Za-z0-9])`, 'i');
  const codeRes = codes.map((c) => ({ c, re: word(c) }));
  const byLoc = new Map<string, string[]>();
  for (const c of codes) {
    const loc = c.replace(/[- ]\d+$/, '');
    if (loc.length >= 3) byLoc.set(loc, [...(byLoc.get(loc) ?? []), c]);
  }
  const locRes = [...byLoc.entries()].map(([loc, list]) => ({ loc, list, re: word(loc) }));
  return (headings: string[]): { code?: string; ambiguous?: string[]; heading?: string } => {
    for (const h of [...headings].reverse()) {
      let found = codeRes.filter((x) => x.re.test(h)).map((x) => x.c);
      if (found.length === 0) found = locRes.filter((x) => x.re.test(h)).flatMap((x) => x.list);
      const uniq = [...new Set(found)];
      if (uniq.length === 1) return { code: uniq[0], heading: h };
      if (uniq.length > 1) return { ambiguous: uniq, heading: h };
    }
    return {};
  };
}

/** Normalised name for comparing a drawing-list heading with a base-DFS group. */
function groupKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/^gfc\s*\|\s*/, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** "Independent Subgrade Structure [Tower 9]" → "ISS". */
function initials(name: string): string {
  return name
    .replace(/\[[^\]]*\]/g, '')
    .replace(/^gfc\s*\|\s*/i, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase())
    .join('');
}

function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Last resort for a drawing whose batch and heading name no package: the
 * heading may name a base-DFS GROUP (exactly, or with a typo of at most two
 * letters in a long name), and the batch's number is then the package's
 * position in that group ("Master Plan" + AR-MP-3 → the group's third
 * package). Resolves only when the group is unique and exactly one of its
 * packages has that position; otherwise nothing is linked.
 */
export function groupOrdinalResolver(
  nodes: { key: string; name: string; sourceLabel: string }[],
  pkgs: { code: string; nodeKey: string | null; ordinal: number | null }[],
) {
  const groups = nodes.map((n) => ({ n, k: groupKey(n.name) })).filter((g) => g.k.length >= 5);
  return (headings: string[], batchCode: string | null): { code: string; heading: string; group: string } | null => {
    // <discipline>-<LOCATION>-<n>: the location must be the group's initials
    // ("Master Plan" → MP, "Independent Subgrade Structure" → ISS).
    const m = /^(?:[A-Z]+-)?([A-Z][A-Z0-9]*)-(\d+)$/i.exec(batchCode ?? '');
    if (!m) return null;
    const loc = m[1].toUpperCase();
    const ordinal = Number(m[2]);
    for (const h of [...headings].reverse()) {
      const hk = groupKey(h);
      if (hk.length < 5) continue;
      let hit = groups.filter((g) => g.k === hk);
      if (hit.length === 0 && hk.length >= 15) hit = groups.filter((g) => g.k.length >= 15 && editDistance(g.k, hk, 2) <= 2);
      if (hit.length === 0) continue;
      // The nearest heading that names a group decides; a stale one further up never does.
      if (hit.length !== 1 || initials(hit[0].n.name) !== loc) return null;
      const inGroup = pkgs.filter((p) => p.nodeKey === hit[0].n.key && p.ordinal === ordinal);
      if (inGroup.length === 1) return { code: inGroup[0].code, heading: h, group: hit[0].n.name };
      return null;
    }
    // No heading at all (a flat register): the location alone decides, and only
    // when exactly one Design Fee group carries those initials.
    if (headings.some((h) => groupKey(h).length >= 5)) return null;
    const only = groups.filter((g) => initials(g.n.name) === loc);
    if (only.length !== 1) return null;
    const inGroup = pkgs.filter((p) => p.nodeKey === only[0].n.key && p.ordinal === ordinal);
    return inGroup.length === 1 ? { code: inGroup[0].code, heading: '', group: only[0].n.name } : null;
  };
}

export interface ImportPlan {
  drawings: PlannedDrawing[];
  packages: PlannedPackage[];
  wbsNodes: PlannedWbsNode[];
  conflicts: PlannedConflict[];
  snapshots: PlannedSnapshot[];
  issues: PlanIssue[];
  phaseMap: { projectCode: string; entry: PhaseMapEntry }[];
  counts: {
    projects: Record<string, ProjectCounts>;
    total: ProjectCounts;
    historicalSnapshotRows: Record<string, number>;
    currentSnapshotRows: number;
    revisions: number;
    planMoves: number;
    packages: Record<string, number>;
    wbsNodes: Record<string, number>;
    packageLinkedDrawings: Record<string, number>;
    fees: Record<string, { sheetTotal: Record<string, number>; packageFees: Record<string, number>; duplicateFees: Record<string, number>; feesOutsidePackages: Record<string, number> }>;
  };
}

// ---------------------------------------------------------------------------

function latestDate(ds: (Date | null | undefined)[]): Date | null {
  let best: Date | null = null;
  for (const d of ds) if (d && (!best || d > best)) best = d;
  return best;
}

export const normTitle = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function revisionNumber(r: string | null | undefined): number | null {
  if (!r) return null;
  const m = /(\d+)/.exec(r);
  return m ? Number(m[1]) : null;
}

function hash(s: string, n = 10) {
  return createHash('sha1').update(s).digest('hex').slice(0, n).toUpperCase();
}

function colName(c: number) {
  let n = c + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function nynKey(r: Pick<PlanRow, 'discipline' | 'batchCode' | 'title' | 'partial'>) {
  return `NYN:${r.discipline}|${r.batchCode ?? ''}|${normTitle(r.title)}|${r.partial ?? ''}`;
}

export const numberKey = (no: string) => `NO:${no}`;

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(d: Date) {
  return `${String(d.getUTCDate()).padStart(2, '0')}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

function planPoint(r: PlanRow): PlanPoint | null {
  if (r.plannedQuarter) {
    return {
      date: calendarQuarter(r.planYear, r.plannedQuarter).end,
      label: `CY${r.planYear} Q${r.plannedQuarter}`,
      snapshotLabel: r.label,
      snapshotDate: r.snapshotDate,
    };
  }
  if (r.plannedThisYear) {
    return { date: calendarQuarter(r.planYear, 4).end, label: `CY${r.planYear}`, snapshotLabel: r.label, snapshotDate: r.snapshotDate };
  }
  return null;
}

/** Evidence text for a released 03YPlan row. Never a date. */
function planEvidence(rows: PlanRow[]): string | null {
  const till = rows.find((r) => r.issuedTill);
  if (till) {
    const y = (till.issuedTillYear ?? till.planYear - 1) + 1;
    return `Issued before 01-Jan-${y}`;
  }
  const issued = rows.find((r) => r.issuedThisYear);
  if (issued) return issued.issuedQuarter ? `Issued ${issued.planYear} Q${issued.issuedQuarter}` : `Issued in ${issued.planYear}`;
  return null;
}

function snapshotOrder(d: Date | null) {
  // Undated snapshots (the Commercial plan) sort first: they are the oldest plan.
  return d ? d.getTime() : -Infinity;
}

export class PhaseResolver {
  private byProject = new Map<string, PhaseMapEntry[]>();
  private unmapped = new Map<string, { projectCode: string; location: string; zone: string; rule: string; count: number; note?: string }>();

  constructor(
    manifest: DrawingManifest,
    private issueCode = 'UNMAPPED_DRAWING_LOCATION',
    private noun = 'drawing',
  ) {
    for (const [code, entries] of Object.entries(manifest.phaseMap)) this.byProject.set(code, entries);
  }

  resolve(projectCode: string, location: string | null, number: string | null): { phase: string | null; rule: PhaseRule | 'UNMAPPED' } {
    const entries = this.byProject.get(projectCode) ?? [];
    const loc = (location ?? '').toUpperCase();
    const zone = number ? (number.split('-')[1] ?? '').toUpperCase() : '';
    const hit =
      entries.find((e) => e.location.toUpperCase() === loc && (e.zone ?? '').toUpperCase() === zone && e.zone) ??
      entries.find((e) => e.location.toUpperCase() === loc && !e.zone) ??
      entries.find((e) => e.location === '*');
    if (!hit) {
      this.note(projectCode, loc || '(blank)', '', 'UNMAPPED');
      return { phase: null, rule: 'UNMAPPED' };
    }
    if (hit.phase == null && !SILENT_NULL_RULES.includes(hit.rule)) {
      this.note(projectCode, hit.location, hit.zone ?? '', hit.rule, hit.note);
    }
    return { phase: hit.phase, rule: hit.rule };
  }

  private note(projectCode: string, location: string, zone: string, rule: string, note?: string) {
    const k = `${projectCode}|${location}|${zone}|${rule}`;
    const e = this.unmapped.get(k) ?? { projectCode, location, zone, rule, count: 0, note };
    e.count++;
    this.unmapped.set(k, e);
  }

  issues(): PlanIssue[] {
    return [...this.unmapped.values()].map((u) => ({
      severity: 'WARNING' as const,
      code: this.issueCode,
      projectCode: u.projectCode,
      message:
        u.rule === 'UNMAPPED'
          ? `Location "${u.location}" has no entry in the location → phase map: ${u.count} ${this.noun}(s) imported with no phase.`
          : `Location "${u.location}"${u.zone ? ` / zone ${u.zone}` : ''} cannot be mapped to one phase (${u.rule}${u.note ? `: ${u.note}` : ''}): ${u.count} ${this.noun}(s) imported with no phase.`,
      payload: u,
    }));
  }
}

function emptyCounts(): ProjectCounts {
  return { drawings: 0, released: 0, notReleased: 0, notYetNumbered: 0, numberConflicts: 0, accOnlyConflicts: 0, actualDates: 0 };
}

function planRowSnapshot(r: PlanRow, drawingKey: string | null): PlannedSnapshot {
  return {
    projectCode: r.projectCode,
    drawingKey,
    snapshotRole: r.role,
    sourceKind: 'PLAN',
    snapshotLabel: r.label,
    snapshotDate: r.snapshotDate,
    planYear: r.planYear,
    ref: { workbook: r.workbook, sheet: r.sheet, row: r.row },
    disciplineCode: r.discipline,
    section: r.section,
    location: r.location,
    batchCode: r.batchCode,
    batch: r.batch,
    drawingNumber: r.number,
    numberKind: r.numberKind,
    partialNumber: r.partial,
    title: r.title,
    revision: r.revision,
    released: r.released,
    issuedBeforeYear: r.issuedTill,
    issuedQuarter: r.issuedQuarter,
    plannedQuarter: r.plannedQuarter,
    explicitDateText: r.explicitDate,
    inAcc: r.inAcc,
    collection: null,
    versionCount: null,
    tags: null,
    accDiscipline: null,
    accReleaseDate: null,
    accCreatedAt: null,
  };
}

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

/** The row that best represents a drawing that appears several times in one
 *  snapshot (usually a re-issue in a later batch): highest revision, then the
 *  last listed. */
function latestRow<T extends { revision: string | null }>(rows: T[]): T {
  let best = rows[0];
  for (const r of rows) {
    if ((revisionNumber(r.revision) ?? -1) >= (revisionNumber(best.revision) ?? -1)) best = r;
  }
  return best;
}

function candidate(r: PlanRow | RegisterRow | AccRow) {
  return { ...r };
}

// ---------------------------------------------------------------------------

export function buildPlan(
  manifest: DrawingManifest,
  sources: {
    plan: PlanRow[];
    register: RegisterRow[];
    acc: AccRow[];
    warnings: string[];
    formulaIssues?: { workbook: string; sheet: string; row: number; col: number; formula: string; reason: string }[];
    designFees?: (DesignFeeParse & { projectCode: string; workbook: string })[];
  },
): ImportPlan {
  const issues: PlanIssue[] = sources.warnings.map((w) => ({
    severity: 'WARNING' as const,
    code: 'SOURCE_HEADER_NOTE',
    projectCode: null,
    message: w,
  }));
  for (const f of sources.formulaIssues ?? []) {
    issues.push({
      severity: 'WARNING',
      code: 'FORMULA_NOT_EVALUATED',
      projectCode: null,
      workbook: f.workbook,
      sheet: f.sheet,
      rowNumber: f.row,
      message: `Cell ${colName(f.col)}${f.row} holds the formula ${f.formula}, which could not be worked out (${f.reason}). The cell is treated as empty.`,
      payload: { formula: f.formula, column: colName(f.col) },
    });
  }
  const phases = new PhaseResolver(manifest);
  const drawings: PlannedDrawing[] = [];
  const conflicts: PlannedConflict[] = [];
  const snapshots: PlannedSnapshot[] = [];

  const projectCodes = [...new Set(manifest.planWorkbooks.map((w) => w.projectCode))];
  if (manifest.register) projectCodes.push(manifest.register.projectCode);
  const counts: Record<string, ProjectCounts> = {};
  for (const p of new Set(projectCodes)) counts[p] = emptyCounts();

  const registerProject = manifest.register?.projectCode ?? null;
  const planProjects = new Set(manifest.planWorkbooks.filter((w) => w.role === 'CURRENT').map((w) => w.projectCode));

  // Historical rows indexed per project, by number and by not-yet-numbered key.
  const historical = sources.plan.filter((r) => r.role === 'HISTORICAL');
  const histByNumber = new Map<string, PlanRow[]>();
  const histByNyn = new Map<string, PlanRow[]>();
  for (const r of historical) {
    const k = r.number ? `${r.projectCode}|${numberKey(r.number)}` : `${r.projectCode}|${nynKey(r)}`;
    const target = r.number ? histByNumber : histByNyn;
    const list = target.get(k);
    if (list) list.push(r);
    else target.set(k, [r]);
  }
  const linkedHistorical = new Map<PlanRow, string>(); // row → drawing key

  /**
   * Historical rows for a numbered drawing. If one historical workbook uses
   * the number for different titles, that is flagged (never merged): only the
   * rows whose title matches the current drawing stay linked to it; the others
   * are preserved as unlinked snapshots.
   */
  function historicalFor(projectCode: string, no: string, currentTitle: string | null): PlanRow[] {
    const rows = histByNumber.get(`${projectCode}|${numberKey(no)}`) ?? [];
    const out: PlanRow[] = [];
    for (const [wb, list] of groupBy(rows, (r) => r.workbook)) {
      const titles = new Set(list.map((r) => normTitle(r.title)));
      if (titles.size <= 1) {
        out.push(...list);
        continue;
      }
      const keep = list.filter((r) => normTitle(r.title) === normTitle(currentTitle));
      out.push(...keep);
      issues.push({
        severity: 'WARNING',
        code: 'NUMBER_TITLE_CONFLICT_HISTORICAL',
        projectCode,
        drawingNumber: no,
        workbook: wb,
        sheet: list[0].sheet,
        rowNumber: list[0].row,
        message: `${no} is used for ${titles.size} different titles in ${list[0].label}: ${[...new Set(list.map((r) => `"${r.title}"`))].join(' / ')}. The current register title "${currentTitle}" is used; ${list.length - keep.length} historical row(s) with a different title are kept as unlinked snapshots, not merged.`,
        payload: list.map((r) => ({ sheet: r.sheet, row: r.row, title: r.title, batchCode: r.batchCode })),
      });
    }
    return out;
  }

  /** Plan history + revisions for a drawing, from every linked snapshot row. */
  function history(current: PlanRow[] | null, hist: PlanRow[]) {
    const all = [...hist, ...(current ?? [])];
    const bySnapshot = groupBy(all, (r) => `${snapshotOrder(r.snapshotDate)}|${r.workbook}`);
    const ordered = [...bySnapshot.values()].sort(
      (a, b) => snapshotOrder(a[0].snapshotDate) - snapshotOrder(b[0].snapshotDate),
    );
    const points: PlanPoint[] = [];
    for (const rows of ordered) {
      const withPlan = rows.find((r) => planPoint(r));
      const p = withPlan ? planPoint(withPlan) : null;
      if (p) points.push(p);
    }
    const revs: PlannedRevision[] = [];
    for (const rows of ordered) {
      for (const r of rows) {
        if (!r.revision) continue;
        const existing = revs.find((x) => x.revision === r.revision);
        if (existing) {
          if (r.released && !existing.released) {
            existing.released = true;
            existing.releaseEvidence = planEvidence([r]);
          }
          continue;
        }
        revs.push({
          revision: r.revision,
          sequence: revs.length,
          released: r.released,
          releaseEvidence: r.released ? planEvidence([r]) : null,
          actualReleaseDate: null,
          expectedReleaseDate: planPoint(r)?.date ?? null,
          snapshotLabel: r.label,
          source: 'IMPORT',
          ref: { workbook: r.workbook, sheet: r.sheet, row: r.row },
        });
      }
    }
    return { points, revs };
  }

  function finishDates(d: Pick<PlannedDrawing, 'planHistory'>) {
    const pts = d.planHistory;
    return {
      baselineReleaseDate: pts[0]?.date ?? null,
      currentExpectedReleaseDate: pts[pts.length - 1]?.date ?? null,
      planPeriodLabel: pts[pts.length - 1]?.label ?? null,
    };
  }

  function regressionCheck(d: PlannedDrawing) {
    const cur = revisionNumber(d.revision);
    if (cur == null) return;
    const earlier = d.revisions.filter((r) => r.revision !== d.revision && (revisionNumber(r.revision) ?? -1) > cur);
    if (earlier.length) {
      issues.push({
        severity: 'WARNING',
        code: 'REVISION_REGRESSION',
        projectCode: d.projectCode,
        drawingNumber: d.drawingNumber,
        workbook: d.ref.workbook,
        sheet: d.ref.sheet,
        rowNumber: d.ref.row,
        message: `Current revision ${d.revision} is lower than earlier ${earlier.map((e) => `${e.revision} (${e.snapshotLabel})`).join(', ')}. The current value is imported; every revision is kept in the history.`,
      });
    }
  }

  // ---- 03YPlan current registers (Residential, Tower08, …) ----------------
  for (const projectCode of planProjects) {
    if (projectCode === registerProject) continue;
    const current = sources.plan.filter((r) => r.projectCode === projectCode && r.role === 'CURRENT');
    const c = counts[projectCode];

    // Numbered drawings — identity is project + number.
    for (const [no, rows] of groupBy(current.filter((r) => r.number), (r) => r.number!)) {
      const key = numberKey(no);
      const titles = new Set(rows.map((r) => normTitle(r.title)));
      if (titles.size > 1) {
        conflicts.push({
          projectCode,
          conflictType: 'NUMBER_TITLE_CONFLICT',
          drawingNumber: no,
          message: `${no} appears ${rows.length} times with ${titles.size} different titles. Not imported until an admin chooses the correct record.`,
          candidates: rows.map(candidate),
        });
        c.numberConflicts++;
        for (const r of rows) snapshots.push(planRowSnapshot(r, null));
        issues.push({
          severity: 'WARNING',
          code: 'NUMBER_TITLE_CONFLICT',
          projectCode,
          drawingNumber: no,
          workbook: rows[0].workbook,
          sheet: rows[0].sheet,
          rowNumber: rows[0].row,
          message: `Same drawing number, different titles: ${[...new Set(rows.map((r) => r.title))].map((t) => `"${t}"`).join(' / ')}`,
        });
        continue;
      }
      if (rows.length > 1) {
        const occ = new Set(rows.map((r) => `${r.location}|${r.batchCode}`));
        issues.push({
          severity: 'INFO',
          code: occ.size > 1 ? 'MULTI_BATCH_DRAWING' : 'DUPLICATE_ROW_COLLAPSED',
          projectCode,
          drawingNumber: no,
          workbook: rows[0].workbook,
          sheet: rows[0].sheet,
          rowNumber: rows[0].row,
          message:
            occ.size > 1
              ? `${no} is listed ${rows.length} times (${[...occ].join(', ')}) — one drawing; every listing kept as a snapshot.`
              : `${no} is listed ${rows.length} times with identical details — collapsed to one drawing.`,
        });
      }
      const hist = historicalFor(projectCode, no, latestRow(rows).title);
      for (const h of hist) linkedHistorical.set(h, key);
      drawings.push(fromPlanRows(projectCode, key, rows, hist, { no, status: 'NUMBERED' }));
    }

    // Not-yet-numbered drawings — kept, keyed on discipline + batch + title (+ partial sheet no.).
    for (const [key, rows] of groupBy(current.filter((r) => !r.number), nynKey)) {
      const hist = histByNyn.get(`${projectCode}|${key}`) ?? [];
      for (const h of hist) linkedHistorical.set(h, key);
      drawings.push(fromPlanRows(projectCode, key, rows, hist, { no: null, status: 'NOT_YET_NUMBERED' }));
    }
  }

  function fromPlanRows(
    projectCode: string,
    key: string,
    rows: PlanRow[],
    hist: PlanRow[],
    n: { no: string | null; status: 'NUMBERED' | 'NOT_YET_NUMBERED' },
  ): PlannedDrawing {
    const latest = latestRow(rows);
    const released = rows.some((r) => r.released);
    const { points, revs } = history(rows, hist);
    const phase = phases.resolve(projectCode, latest.location, n.no);
    for (const r of rows) snapshots.push(planRowSnapshot(r, key));
    const d: PlannedDrawing = {
      sourceKey: key,
      projectCode,
      numberStatus: n.status,
      drawingCode: n.no ?? `NYN-${latest.discipline}-${hash(`${projectCode}|${key}`)}`,
      drawingNumber: n.no,
      partialNumber: n.no ? null : latest.partial,
      drawingName: latest.title ?? '(untitled)',
      discipline: latest.discipline,
      location: latest.location,
      areaOfWorks: latest.section,
      batchCode: latest.batchCode,
      batch: latest.batch,
      packageCode: null,
      packageRule: null,
      sourceHeadings: latest.headings ?? [],
      revision: latest.revision,
      phaseCode: phase.phase,
      phaseRule: phase.rule,
      released,
      releaseEvidence: released ? planEvidence(rows.filter((r) => r.released)) : null,
      // 03YPlan files record THAT a drawing was issued, not when — unless the
      // sheet has an explicit date-of-receipt / release column.
      actualReleaseDate: released ? latestDate(rows.filter((r) => r.released).map((r) => r.releaseDate)) : null,
      sourceRevisionDate: latestDate(rows.map((r) => r.revisionDate)),
      responsibleText: latest.responsible ?? rows.map((r) => r.responsible).find(Boolean) ?? null,
      baselineReleaseDate: null,
      currentExpectedReleaseDate: null,
      planPeriodLabel: null,
      planHistory: points,
      revisions: revs,
      collection: null,
      versionCount: null,
      tags: null,
      accDiscipline: null,
      accCreatedAt: null,
      ref: { workbook: latest.workbook, sheet: latest.sheet, row: latest.row },
    };
    Object.assign(d, finishDates(d));
    // The current revision carries the drawing's own release state.
    const cur = d.revisions.find((r) => r.revision === d.revision);
    if (cur) {
      cur.released = d.released;
      cur.releaseEvidence = d.releaseEvidence;
    }
    regressionCheck(d);
    return d;
  }

  // ---- T09: register sheets + ACC export + Commercial plan history --------
  if (manifest.register && registerProject) {
    const reg = manifest.register;
    const c = counts[registerProject];
    const accByNumber = groupBy(sources.acc, (a) => a.number);
    for (const [no, list] of accByNumber) {
      if (list.length > 1) {
        issues.push({
          severity: 'WARNING',
          code: 'ACC_DUPLICATE_NUMBER',
          projectCode: registerProject,
          drawingNumber: no,
          workbook: list[0].workbook,
          sheet: list[0].sheet,
          rowNumber: list[0].row,
          message: `${no} appears ${list.length} times in the ACC export; the latest release is used.`,
        });
      }
    }
    const accFor = (no: string): AccRow | null => {
      const list = accByNumber.get(no);
      if (!list) return null;
      return [...list].sort((a, b) => (b.releaseDate?.getTime() ?? 0) - (a.releaseDate?.getTime() ?? 0))[0];
    };
    const registerNumbers = new Set(sources.register.filter((r) => r.number).map((r) => r.number!));

    for (const r of sources.register.filter((x) => !x.number)) {
      issues.push({
        severity: 'WARNING',
        code: 'REGISTER_ROW_WITHOUT_NUMBER',
        projectCode: registerProject,
        workbook: r.workbook,
        sheet: r.sheet,
        rowNumber: r.row,
        message: `Register row has a title but no drawing number: "${r.title}"`,
      });
    }

    for (const [no, rows] of groupBy(sources.register.filter((r) => r.number), (r) => r.number!)) {
      const key = numberKey(no);
      const titles = new Set(rows.map((r) => normTitle(r.title)));
      const a = accFor(no);
      if (titles.size > 1) {
        conflicts.push({
          projectCode: registerProject,
          conflictType: 'NUMBER_TITLE_CONFLICT',
          drawingNumber: no,
          message: `${no} appears ${rows.length} times in the T09 register with ${titles.size} different titles. Not imported until an admin chooses the correct record.`,
          candidates: [...rows.map(candidate), ...(a ? [{ ...candidate(a), source: 'ACC' }] : [])],
        });
        c.numberConflicts++;
        for (const r of rows) snapshots.push(registerSnapshot(registerProject, reg.label, r, null));
        issues.push({
          severity: 'WARNING',
          code: 'NUMBER_TITLE_CONFLICT',
          projectCode: registerProject,
          drawingNumber: no,
          workbook: rows[0].workbook,
          sheet: rows[0].sheet,
          rowNumber: rows[0].row,
          message: `Same drawing number, different titles: ${[...new Set(rows.map((r) => r.title))].map((t) => `"${t}"`).join(' / ')}`,
        });
        continue;
      }
      if (rows.length > 1) {
        const occ = new Set(rows.map((r) => r.batchCode));
        issues.push({
          severity: 'INFO',
          code: occ.size > 1 ? 'MULTI_BATCH_DRAWING' : 'DUPLICATE_ROW_COLLAPSED',
          projectCode: registerProject,
          drawingNumber: no,
          workbook: rows[0].workbook,
          sheet: rows[0].sheet,
          rowNumber: rows[0].row,
          message:
            occ.size > 1
              ? `${no} is listed in ${occ.size} batches (${[...occ].join(', ')}) — one drawing; every listing kept as a snapshot.`
              : `${no} is listed ${rows.length} times with identical details — collapsed to one drawing.`,
        });
      }
      const latest = latestRow(rows);
      for (const r of rows) snapshots.push(registerSnapshot(registerProject, reg.label, r, key));
      const hist = historicalFor(registerProject, no, latest.title);
      for (const h of hist) linkedHistorical.set(h, key);
      const { points } = history(null, hist);
      const phase = phases.resolve(registerProject, latest.location, no);
      const released = Boolean(a);
      const actual = a?.releaseDate ?? null;
      const evidence = a ? (actual ? `ACC release ${fmtDate(actual)}` : 'In ACC export — no release date') : null;
      const d: PlannedDrawing = {
        sourceKey: key,
        projectCode: registerProject,
        numberStatus: 'NUMBERED',
        drawingCode: no,
        drawingNumber: no,
        partialNumber: null,
        drawingName: latest.title ?? a?.title ?? '(untitled)',
        discipline: latest.discipline,
        location: latest.location,
        areaOfWorks: latest.section,
        batchCode: latest.batchCode,
        batch: latest.batch,
        packageCode: null,
        packageRule: null,
        sourceHeadings: latest.section ? [latest.section] : [],
        revision: latest.revision,
        phaseCode: phase.phase,
        phaseRule: phase.rule,
        released,
        releaseEvidence: evidence,
        actualReleaseDate: actual,
        baselineReleaseDate: null,
        currentExpectedReleaseDate: null,
        planPeriodLabel: null,
        planHistory: points,
        // T09: only the register's current revision is known. The ACC version
        // count is stored as-is; intermediate revisions are not fabricated.
        revisions: latest.revision
          ? [
              {
                revision: latest.revision,
                sequence: 0,
                released,
                releaseEvidence: evidence,
                actualReleaseDate: actual,
                expectedReleaseDate: points[points.length - 1]?.date ?? null,
                snapshotLabel: a ? manifest.register.acc?.label ?? reg.label : reg.label,
                source: a ? 'ACC' : 'IMPORT',
                ref: { workbook: latest.workbook, sheet: latest.sheet, row: latest.row },
              },
            ]
          : [],
        collection: a?.collection ?? null,
        versionCount: a?.versions ?? null,
        tags: a?.tags ?? null,
        accDiscipline: a?.discipline ?? null,
        accCreatedAt: a?.createdAt ?? null,
        ref: { workbook: latest.workbook, sheet: latest.sheet, row: latest.row },
      };
      Object.assign(d, finishDates(d));
      if (a) {
        if (normTitle(a.title) !== normTitle(d.drawingName)) {
          issues.push({
            severity: 'WARNING',
            code: 'ACC_TITLE_MISMATCH',
            projectCode: registerProject,
            drawingNumber: no,
            workbook: a.workbook,
            sheet: a.sheet,
            rowNumber: a.row,
            message: `Register title "${d.drawingName}" differs from ACC title "${a.title}". The register title is used (register is authoritative for titles).`,
          });
        }
        const rn = revisionNumber(d.revision);
        if (a.versions != null && rn != null && a.versions !== rn + 1) {
          issues.push({
            severity: 'WARNING',
            code: 'ACC_VERSION_MISMATCH',
            projectCode: registerProject,
            drawingNumber: no,
            workbook: a.workbook,
            sheet: a.sheet,
            rowNumber: a.row,
            message: `Register revision ${d.revision} but ACC holds ${a.versions} version(s) (expected ${rn + 1}).`,
          });
        }
      }
      drawings.push(d);
    }

    // ACC rows: every one is a snapshot; numbers missing from the register are conflicts.
    for (const a of sources.acc) {
      snapshots.push(accSnapshot(registerProject, manifest.register.acc?.label ?? 'ACC export', a, registerNumbers.has(a.number) ? numberKey(a.number) : null));
    }
    for (const [no, list] of accByNumber) {
      if (registerNumbers.has(no)) continue;
      conflicts.push({
        projectCode: registerProject,
        conflictType: 'ACC_ONLY_NUMBER',
        drawingNumber: no,
        message: `${no} is in the ACC export but not in the T09 register. Not imported: it may be a mistyped number (the register is authoritative for membership).`,
        candidates: list.map((a) => ({ ...candidate(a), source: 'ACC' })),
      });
      c.accOnlyConflicts++;
      issues.push({
        severity: 'WARNING',
        code: 'ACC_ONLY_NUMBER',
        projectCode: registerProject,
        drawingNumber: no,
        workbook: list[0].workbook,
        sheet: list[0].sheet,
        rowNumber: list[0].row,
        message: `ACC number ${no} ("${list[0].title}") is not in the T09 register — held as a conflict, not imported.`,
      });
    }
  }

  // ---- historical snapshots ----------------------------------------------
  const historicalSnapshotRows: Record<string, number> = {};
  for (const r of historical) {
    snapshots.push(planRowSnapshot(r, linkedHistorical.get(r) ?? null));
    historicalSnapshotRows[r.workbook] = (historicalSnapshotRows[r.workbook] ?? 0) + 1;
  }
  historicalSnapshotRows.total = historical.length;

  // Drawings that are in a historical snapshot but not in the current register:
  // one summary issue per historical workbook (mostly the 2024 files' older
  // numbering scheme), with the numbers in the payload.
  const currentKeys = new Set(drawings.map((d) => `${d.projectCode}|${d.sourceKey}`));
  const conflictNos = new Set(conflicts.map((c) => `${c.projectCode}|${numberKey(c.drawingNumber)}`));
  const dropped = new Map<string, { r: PlanRow; numbers: string[] }>();
  for (const [k, rows] of histByNumber) {
    if (currentKeys.has(k) || conflictNos.has(k)) continue;
    const r = rows[rows.length - 1];
    if (r.projectCode === registerProject) continue; // the Commercial plan is an older, partial T09 plan
    const e = dropped.get(r.workbook) ?? { r, numbers: [] };
    e.numbers.push(r.number!);
    dropped.set(r.workbook, e);
  }
  for (const { r, numbers } of dropped.values()) {
    issues.push({
      severity: 'INFO',
      code: 'NOT_IN_CURRENT_REGISTER',
      projectCode: r.projectCode,
      workbook: r.workbook,
      message: `${numbers.length} drawing number(s) in ${r.label} are not in the current register (older numbering or withdrawn). Kept as historical snapshots only.`,
      payload: { numbers },
    });
  }

  // ---- base DFS: WBS nodes, fee packages and the drawing → package link -------
  const packages: PlannedPackage[] = [];
  const wbsNodes: PlannedWbsNode[] = [];
  const packageCounts: Record<string, number> = {};
  const nodeCounts: Record<string, number> = {};
  const linkedCounts: Record<string, number> = {};
  const feeTotals: ImportPlan['counts']['fees'] = {};
  const byHeading = manifest.dfsHierarchy?.resolveUnlinkedByHeading !== false;
  for (const fee of sources.designFees ?? []) {
    issues.push(...fee.issues);
    feeTotals[fee.projectCode] = {
      sheetTotal: fee.sheetTotal,
      packageFees: fee.packageFees,
      duplicateFees: fee.duplicateFees,
      feesOutsidePackages: fee.feesOutsidePackages,
    };
    for (const n of fee.nodes ?? []) {
      wbsNodes.push({
        projectCode: fee.projectCode,
        key: n.key,
        parentKey: n.parentKey,
        type: n.type,
        name: n.name,
        code: n.code,
        sourceLabel: n.sourceLabel,
        sequence: n.sequence,
        ref: { workbook: n.workbook, sheet: n.sheet, row: n.row },
      });
      nodeCounts[fee.projectCode] = (nodeCounts[fee.projectCode] ?? 0) + 1;
    }
    const codes = new Set(fee.packages.map((p) => p.code));
    const resolver = headingResolver(fee.packages.map((p) => p.code));
    const byOrdinal = groupOrdinalResolver(fee.nodes ?? [], fee.packages);
    const viaOrdinal = new Map<string, { pattern: string; code: string; heading: string; group: string; n: number }>();
    const unlinked = new Map<string, number>();
    const viaHeading = new Map<string, { pattern: string; code: string; heading: string; n: number; sheets: Set<string> }>();
    const ambiguous = new Map<string, { pattern: string; heading: string; codes: string[]; n: number }>();
    const perUnit = new Map<string, number>();
    for (const d of drawings) {
      if (d.projectCode !== fee.projectCode) continue;
      d.packageCode = packageCodeForBatch(d.batchCode, codes);
      d.packageRule = d.packageCode ? 'BATCH' : null;
      const pattern = (d.batchCode ?? '(no batch)').replace(/\d+$/, 'n');
      // A batch the source marks "…-NA" says the drawing has no package: kept unmapped.
      if (!d.packageCode && byHeading && !/-NA$/i.test(d.batchCode ?? '')) {
        const h = resolver(d.sourceHeadings);
        if (h.code) {
          d.packageCode = h.code;
          d.packageRule = 'HEADING';
          const k = `${d.batchCode ?? ''}|${h.code}|${h.heading}`;
          const e = viaHeading.get(k) ?? { pattern: d.batchCode ?? '(no batch)', code: h.code, heading: h.heading!, n: 0, sheets: new Set<string>() };
          e.n++;
          e.sheets.add(d.ref.sheet ?? '');
          viaHeading.set(k, e);
        } else if (h.ambiguous) {
          const k = `${pattern}|${h.heading}`;
          const e = ambiguous.get(k) ?? { pattern, heading: h.heading!, codes: h.ambiguous, n: 0 };
          e.n++;
          ambiguous.set(k, e);
          continue;
        } else {
          const g = byOrdinal(d.sourceHeadings, d.batchCode);
          if (g) {
            d.packageCode = g.code;
            d.packageRule = 'HEADING';
            const k = `${d.batchCode ?? ''}|${g.code}`;
            const e = viaOrdinal.get(k) ?? { pattern: d.batchCode ?? '', code: g.code, heading: g.heading, group: g.group, n: 0 };
            e.n++;
            viaOrdinal.set(k, e);
          }
        }
      }
      if (d.packageCode) {
        linkedCounts[d.projectCode] = (linkedCounts[d.projectCode] ?? 0) + 1;
        perUnit.set(`${d.packageCode}|${d.discipline}`, (perUnit.get(`${d.packageCode}|${d.discipline}`) ?? 0) + 1);
      } else {
        unlinked.set(pattern, (unlinked.get(pattern) ?? 0) + 1);
      }
    }
    for (const e of viaOrdinal.values()) {
      issues.push({
        severity: 'WARNING',
        code: 'BATCH_RESOLVED_BY_GROUP_ORDINAL',
        projectCode: fee.projectCode,
        workbook: fee.workbook,
        message: `${e.n} drawing(s) with batch ${e.pattern} ${e.heading ? `sit under the heading "${e.heading}", which is` : 'have no heading; the batch location is the initials of'} the base-DFS group "${e.group}"; the batch number is that group's package ${e.code}: linked to ${e.code}. Check the batch code in the source.`,
        payload: { batch: e.pattern, package: e.code, heading: e.heading, group: e.group, drawings: e.n },
      });
    }
    for (const e of viaHeading.values()) {
      issues.push({
        severity: 'WARNING',
        code: 'BATCH_RESOLVED_BY_DFS_HEADING',
        projectCode: fee.projectCode,
        workbook: fee.workbook,
        message: `${e.n} drawing(s) with batch ${e.pattern} — not a package in the base DFS — sit under the drawing-list heading "${e.heading}", which names only package ${e.code}: linked to ${e.code}. Correct the batch code in the source.`,
        payload: { batch: e.pattern, package: e.code, heading: e.heading, drawings: e.n, sheets: [...e.sheets] },
      });
    }
    for (const e of ambiguous.values()) {
      issues.push({
        severity: 'WARNING',
        code: 'DRAWING_PACKAGE_AMBIGUOUS',
        projectCode: fee.projectCode,
        workbook: fee.workbook,
        message: `${e.n} drawing(s) in batch ${e.pattern} are not a package in the base DFS, and their heading "${e.heading}" names ${e.codes.length} packages (${e.codes.slice(0, 6).join(', ')}${e.codes.length > 6 ? ', …' : ''}). Not assigned — shown under "Drawings not assigned to a package".`,
        payload: { pattern: e.pattern, heading: e.heading, packages: e.codes, drawings: e.n },
      });
    }
    for (const [pattern, n] of unlinked) {
      issues.push({
        severity: 'WARNING',
        code: 'BATCH_WITHOUT_FEE_PACKAGE',
        projectCode: fee.projectCode,
        workbook: fee.workbook,
        message: `${n} drawing(s) in batch ${pattern} match no package of the base DFS (Design Fee sheet), by batch code or by heading — shown in the Design Fee Schedule under "Drawings not assigned to a package", with no design fee.`,
        payload: { pattern, drawings: n },
      });
    }
    for (const p of fee.packages) {
      packages.push({
        projectCode: fee.projectCode,
        code: p.code,
        name: p.name,
        group: p.section,
        heading: p.heading,
        nodeKey: p.nodeKey ?? null,
        sequence: p.sequence,
        // The base DFS is the only source of a package's place; a phase comes
        // from a PHASE heading of the DFS tree, never from a location code.
        phaseCode: null,
        responsible: p.responsible ?? null,
        ref: { workbook: p.workbook, sheet: p.sheet, row: p.row },
        fees: p.disciplines.map((d) => {
          const n = perUnit.get(`${p.code}|${d.discipline}`) ?? 0;
          const noFee = !d.fee && !d.percent;
          return {
            discipline: d.discipline,
            percent: d.percent,
            fee: d.fee,
            billedToDate: d.billedToDate,
            applicability: noFee && n === 0 ? 'NA' : 'APPLICABLE',
            drawings: n,
          };
        }),
      });
      packageCounts[fee.projectCode] = (packageCounts[fee.projectCode] ?? 0) + 1;
    }
  }

  // ---- counts --------------------------------------------------------------
  for (const d of drawings) {
    const c = counts[d.projectCode];
    c.drawings++;
    if (d.released) c.released++;
    else c.notReleased++;
    if (d.numberStatus === 'NOT_YET_NUMBERED') c.notYetNumbered++;
    if (d.actualReleaseDate) c.actualDates++;
  }
  const total = emptyCounts();
  for (const c of Object.values(counts)) for (const k of Object.keys(total) as (keyof ProjectCounts)[]) total[k] += c[k];

  issues.push(...phases.issues());

  const phaseMap = Object.entries(manifest.phaseMap).flatMap(([projectCode, entries]) =>
    entries.map((entry) => ({ projectCode, entry })),
  );

  return {
    drawings,
    packages,
    wbsNodes,
    conflicts,
    snapshots,
    issues,
    phaseMap,
    counts: {
      packages: packageCounts,
      wbsNodes: nodeCounts,
      packageLinkedDrawings: linkedCounts,
      fees: feeTotals,
      projects: counts,
      total,
      historicalSnapshotRows,
      currentSnapshotRows: snapshots.filter((s) => s.snapshotRole === 'CURRENT').length,
      revisions: drawings.reduce((n, d) => n + d.revisions.length, 0),
      planMoves: drawings.reduce((n, d) => n + planMoves(d).length, 0),
    },
  };
}

/** Consecutive changes of planned date across snapshots. */
export function planMoves(d: Pick<PlannedDrawing, 'planHistory'>) {
  const out: { from: PlanPoint; to: PlanPoint }[] = [];
  for (let i = 1; i < d.planHistory.length; i++) {
    const a = d.planHistory[i - 1];
    const b = d.planHistory[i];
    if (a.date.getTime() !== b.date.getTime()) out.push({ from: a, to: b });
  }
  return out;
}

function registerSnapshot(projectCode: string, label: string, r: RegisterRow, drawingKey: string | null): PlannedSnapshot {
  return {
    projectCode,
    drawingKey,
    snapshotRole: 'CURRENT',
    sourceKind: 'REGISTER',
    snapshotLabel: label,
    snapshotDate: null,
    planYear: null,
    ref: { workbook: r.workbook, sheet: r.sheet, row: r.row },
    disciplineCode: r.discipline,
    section: r.section,
    location: r.location,
    batchCode: r.batchCode,
    batch: r.batch,
    drawingNumber: r.number,
    numberKind: r.number ? 'FULL' : 'NONE',
    partialNumber: null,
    title: r.title,
    revision: r.revision,
    released: false,
    issuedBeforeYear: false,
    issuedQuarter: null,
    plannedQuarter: null,
    explicitDateText: null,
    inAcc: null,
    collection: null,
    versionCount: null,
    tags: null,
    accDiscipline: null,
    accReleaseDate: null,
    accCreatedAt: null,
  };
}

function accSnapshot(projectCode: string, label: string, a: AccRow, drawingKey: string | null): PlannedSnapshot {
  return {
    projectCode,
    drawingKey,
    snapshotRole: 'CURRENT',
    sourceKind: 'ACC',
    snapshotLabel: label,
    snapshotDate: null,
    planYear: null,
    ref: { workbook: a.workbook, sheet: a.sheet, row: a.row },
    disciplineCode: null,
    section: null,
    location: null,
    batchCode: null,
    batch: null,
    drawingNumber: a.number,
    numberKind: 'FULL',
    partialNumber: null,
    title: a.title,
    revision: null,
    released: true,
    issuedBeforeYear: false,
    issuedQuarter: null,
    plannedQuarter: null,
    explicitDateText: a.releaseDateText,
    inAcc: 'Yes',
    collection: a.collection,
    versionCount: a.versions,
    tags: a.tags,
    accDiscipline: a.discipline,
    accReleaseDate: a.releaseDate,
    accCreatedAt: a.createdAt,
  };
}

/** Compare plan counts with the manifest targets. Empty = valid. */
export function validatePlan(manifest: DrawingManifest, plan: ImportPlan): string[] {
  const e = manifest.expected;
  if (!e) return [];
  const diffs: string[] = [];
  const cmp = (label: string, got: number, want: number | undefined) => {
    if (want != null && got !== want) diffs.push(`${label}: got ${got}, expected ${want}`);
  };
  for (const [code, want] of Object.entries(e.projects)) {
    const got = plan.counts.projects[code] ?? emptyCounts();
    for (const k of Object.keys(want) as (keyof ProjectCounts)[]) cmp(`${code} ${k}`, got[k], want[k]);
  }
  for (const k of Object.keys(e.total) as (keyof ProjectCounts)[]) cmp(`TOTAL ${k}`, plan.counts.total[k], e.total[k]);
  for (const [wb, want] of Object.entries(e.historicalSnapshotRows)) {
    cmp(`historical snapshot rows ${wb}`, plan.counts.historicalSnapshotRows[wb] ?? 0, want);
  }
  for (const [code, want] of Object.entries(e.packages ?? {})) cmp(`${code} fee packages`, plan.counts.packages[code] ?? 0, want);
  for (const [code, want] of Object.entries(e.wbsNodes ?? {})) cmp(`${code} base-DFS headings (WBS nodes)`, plan.counts.wbsNodes?.[code] ?? 0, want);
  for (const [code, want] of Object.entries(e.packageLinkedDrawings ?? {})) {
    cmp(`${code} drawings linked to a fee package`, plan.counts.packageLinkedDrawings[code] ?? 0, want);
  }
  // Fees reconcile: imported + repeated-code + outside-package fees = the sheet total.
  for (const [code, f] of Object.entries(plan.counts.fees)) {
    for (const d of Object.keys(f.sheetTotal)) {
      const sum = (f.packageFees[d] ?? 0) + (f.duplicateFees[d] ?? 0) + (f.feesOutsidePackages[d] ?? 0);
      if (Math.abs(sum - f.sheetTotal[d]) > 0.0002) diffs.push(`${code} ${d} fees do not reconcile: ${sum} vs sheet total ${f.sheetTotal[d]}`);
    }
  }
  return diffs;
}
