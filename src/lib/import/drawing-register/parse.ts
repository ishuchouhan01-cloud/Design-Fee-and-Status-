/**
 * Layout-aware parsing of the drawing sources.
 *
 * 03YPlan drawing lists move their columns between years and towers (the
 * number sits in C, D or E; the 2024 files split it over three columns), so
 * every column is found from its header label and the title / number columns
 * are found from how the data is filled — never from a fixed letter.
 */
import path from 'node:path';
import { at, colIndex, parseCalendarDate, parseTimestamp, readTextWorkbook, type TextRow, type TextSheet } from './read';
import type { DrawingManifest, PlanWorkbookSpec } from './manifest';
import { parseDesignFee, type DesignFeeParse } from './design-fee';
import type { PlanIssue } from './plan';

export type NumberKind = 'FULL' | 'COMPOSED' | 'PARTIAL' | 'NONE';

export interface PlanRow {
  workbook: string;
  sheet: string;
  row: number;
  projectCode: string;
  role: 'CURRENT' | 'HISTORICAL';
  label: string;
  snapshotDate: Date | null;
  planYear: number;
  /** "Till Dec'25" → 2025: released rows are "Issued before 01-Jan-2026". */
  issuedTillYear: number | null;
  discipline: string;
  section: string | null;
  /** The drawing list's heading rows above this row, oldest first (at most
   *  four) — the drawing's place in the sheet's own grouping. */
  headings: string[];
  location: string;
  batchCode: string | null;
  batch: string | null;
  title: string | null;
  number: string | null;
  numberKind: NumberKind;
  partial: string | null;
  revision: string | null;
  issuedTill: boolean;
  issuedThisYear: boolean;
  issuedQuarter: number | null;
  plannedThisYear: boolean;
  plannedQuarter: number | null;
  explicitDate: string | null;
  /** From an explicit "Date of receipt / release" column, when the sheet has one. */
  releaseDate: Date | null;
  /** From a revision-date column, when the sheet has one. */
  revisionDate: Date | null;
  /** From a Responsible Person column, when the sheet has one. */
  responsible: string | null;
  inAcc: string | null;
  released: boolean;
}

export interface RegisterRow {
  workbook: string;
  sheet: string;
  row: number;
  discipline: string;
  section: string | null;
  number: string | null;
  title: string | null;
  location: string | null;
  batchCode: string | null;
  batch: string | null;
  revision: string | null;
}

export interface AccRow {
  workbook: string;
  sheet: string;
  row: number;
  number: string;
  title: string | null;
  collection: string | null;
  versions: number | null;
  releaseDateText: string | null;
  releaseDate: Date | null;
  createdAtText: string | null;
  createdAt: Date | null;
  discipline: string | null;
  tags: string | null;
}

export interface Layout {
  header: number;
  loc: number;
  /** A per-row discipline column, when the sheet has one (else the sheet name gives it). */
  discipline: number;
  /** An explicit release / receipt date column (the actual release date of an issued drawing). */
  releaseDate: number;
  /** A revision-date column ("Revision date", "Last revised"): the source date of a drawing with no release date. */
  revisionDate: number;
  /** A Responsible Person column (responsible / design lead / owner). */
  responsible: number;
  batchCode: number;
  batch: number;
  issuedTill: number;
  revision: number;
  date: number;
  plan: number;
  issued: number;
  inAcc: number;
  title: number;
  leftCols: number[];
  issuedTillYear: number | null;
  planYearInHeader: number | null;
}

const SCAN_COLS = 80;

/** Column roles a user can set in the Import Centre (letters, e.g. { batchCode: 'I' }). */
export type ColumnOverrides = Partial<Record<'location' | 'batchCode' | 'batch' | 'revision' | 'title' | 'number' | 'discipline' | 'releaseDate' | 'issuedTill', string>>;

/** Discipline codes a sheet name or a Discipline cell may carry (disciplines.code; SR = Services). */
export const DISCIPLINE_TOKENS = new Set(['AR', 'ST', 'MEP', 'LS', 'LDS', 'MP', 'UD', 'ID', 'PHE', 'ELE', 'IBMS', 'INFRA', 'SR']);

/** A sheet's discipline from its name: "AR | Drawing List" → AR, "Drawing list | ST" → ST. */
export function sheetDiscipline(name: string): string {
  const parts = name.split('|').map((x) => x.trim());
  for (const part of parts) {
    const tok = part.split(/[\s&,]+/)[0]?.toUpperCase();
    if (tok && DISCIPLINE_TOKENS.has(tok)) return tok === 'LDS' ? 'LS' : tok;
  }
  return parts[0];
}

export function layout(s: TextSheet, overrides: ColumnOverrides = {}): Layout | null {
  let h = -1;
  let loc = -1;
  for (let r = 0; r < 8; r++) {
    const row = s.rows[r] ?? [];
    const i = row.findIndex((v) => /^location$/i.test(v ?? ''));
    if (i >= 0) {
      h = r;
      loc = i;
      break;
    }
  }
  if (h < 0) return null;
  const headerRows = [h, h + 1, h + 2];
  const find = (re: RegExp, from = loc) => {
    for (let c = from; c < SCAN_COLS; c++) {
      for (const r of headerRows) {
        const v = at(s.rows[r], c);
        if (v && re.test(v)) return c;
      }
    }
    return -1;
  };
  const L: Layout = {
    header: h,
    loc,
    discipline: find(/^discipline$/i, 0),
    releaseDate: find(/^(date of (receipt|release|issue)|release date|actual release( date)?)$/i, 0),
    batchCode: find(/^batch code$/i),
    batch: find(/^batch$/i),
    issuedTill: find(/till dec/i),
    revision: find(/^(?!.*date).*revision/i),
    responsible: find(/^(responsible( person)?|resposible|design lead|drawing owner|owner|in[- ]?charge)$/i, 0),
    revisionDate: find(/^(revision date|rev\.? date|date of revision|last revised( on)?)$/i, 0),
    date: find(/^date$/i),
    plan: find(/^plan (in|for)/i),
    issued: find(/^issued? in/i),
    inAcc: find(/in acc\?/i, 0),
    title: -1,
    leftCols: [],
    issuedTillYear: null,
    planYearInHeader: null,
  };
  const tillLabel = headerRows.map((r) => at(s.rows[r], L.issuedTill)).find((v) => v && /till dec/i.test(v));
  const ty = tillLabel ? /(\d{2,4})\s*$/.exec(tillLabel) : null;
  if (ty) L.issuedTillYear = ty[1].length === 2 ? 2000 + Number(ty[1]) : Number(ty[1]);
  const planLabel = headerRows.map((r) => at(s.rows[r], L.plan)).find((v) => v && /^plan in/i.test(v));
  const py = planLabel ? /(\d{2,4})\s*$/.exec(planLabel) : null;
  if (py) L.planYearInHeader = py[1].length === 2 ? 2000 + Number(py[1]) : Number(py[1]);

  // Title and number columns: the text columns left of Location, by fill.
  const counts: { c: number; n: number; avg: number }[] = [];
  for (let c = 0; c < loc; c++) {
    let n = 0;
    let len = 0;
    for (let r = h + 1; r < s.rows.length; r++) {
      const v = at(s.rows[r], c);
      if (v && at(s.rows[r], loc)) {
        n++;
        len += v.length;
      }
    }
    counts.push({ c, n, avg: n ? len / n : 0 });
  }
  // Batch code / batch swapped in the data (the header says "Batch Code" over the
  // batch numbers): the column holding code-like values is the batch code.
  if (L.batchCode >= 0 && L.batch >= 0) {
    let numeric = 0;
    let codeLike = 0;
    for (let r = h + 1; r < Math.min(s.rows.length, h + 400); r++) {
      const a = at(s.rows[r], L.batchCode);
      const b = at(s.rows[r], L.batch);
      if (a && /^\d+$/.test(a)) numeric++;
      if (b && /^[A-Z][A-Z0-9]*(-[A-Z0-9]+)+$/i.test(b)) codeLike++;
    }
    if (numeric >= 3 && codeLike >= 3) [L.batchCode, L.batch] = [L.batch, L.batchCode];
  }
  const cand = counts.filter((x) => x.n > 0);
  if (cand.length === 0) return applyOverrides(L, overrides);
  const maxN = Math.max(...cand.map((y) => y.n));
  // A column counts when it is filled on most rows (three or more; fewer on a very short sheet).
  const good = cand.filter((x) => x.n >= Math.max(Math.min(3, maxN), 0.25 * maxN));
  const title = [...good.slice(-2)].sort((a, b) => b.avg - a.avg)[0];
  L.title = title ? title.c : -1;
  L.leftCols = good.filter((x) => x.c < L.title && x.c !== L.discipline).map((x) => x.c);
  return applyOverrides(L, overrides);
}

function applyOverrides(L: Layout, o: ColumnOverrides): Layout {
  const c = (v: string | undefined) => (v ? colIndex(v.toUpperCase()) : undefined);
  if (o.location) L.loc = c(o.location)!;
  if (o.batchCode) L.batchCode = c(o.batchCode)!;
  if (o.batch) L.batch = c(o.batch)!;
  if (o.revision) L.revision = c(o.revision)!;
  if (o.title) L.title = c(o.title)!;
  if (o.number) L.leftCols = [c(o.number)!];
  if (o.discipline) L.discipline = c(o.discipline)!;
  if (o.releaseDate) L.releaseDate = c(o.releaseDate)!;
  if (o.issuedTill) L.issuedTill = c(o.issuedTill)!;
  return L;
}

/** e.g. A-BA1-1001, S-E01-FD0001, PHE-T09-1011A, LS-0059-03-… */
const FULL_NUMBER = /^[A-Z0-9]{1,6}(-[A-Z0-9()\.]+){1,6}[a-zA-Z]?$/;

export function drawingNumberOf(parts: (string | null)[]): { number: string | null; kind: NumberKind; partial: string | null } {
  const last = parts[parts.length - 1];
  if (last && FULL_NUMBER.test(last.replace(/\s+/g, ''))) {
    return { number: last.replace(/\s+/g, ''), kind: 'FULL', partial: null };
  }
  if (last && /^\d{3,5}[A-Z]?$/i.test(last)) {
    const pre = parts.slice(0, -1).filter((p): p is string => Boolean(p));
    if (pre.length >= 2) return { number: [...pre.slice(-2), last].join('-'), kind: 'COMPOSED', partial: null };
    return { number: null, kind: 'PARTIAL', partial: last };
  }
  return { number: null, kind: 'NONE', partial: null };
}

const flag = (v: string | null) => v === '1' || v === '1.0';

function normaliseDiscipline(v: string | null): string | null {
  if (!v) return null;
  const t = v.trim().toUpperCase();
  if (t === 'LDS') return 'LS';
  return DISCIPLINE_TOKENS.has(t) ? t : null;
}

function isoDate(s: string | null): Date | null {
  return s ? parseCalendarDate(s) : null;
}

export function parsePlanSheet(spec: PlanWorkbookSpec, s: TextSheet): { rows: PlanRow[]; layout: Layout } | null {
  const L = layout(s, spec.columns?.[s.name] ?? spec.columns?.['*'] ?? {});
  if (!L || L.title < 0) return null;
  const sheetDisc = spec.disciplines?.[s.name] ?? sheetDiscipline(s.name);
  const out: PlanRow[] = [];
  let section: string | null = null;
  let headings: string[] = [];
  const pushHeading = (row: TextRow, upTo: number) => {
    const text = row
      .slice(0, Math.max(1, upTo))
      .filter((v): v is string => Boolean(v))
      .join(' ')
      .trim();
    if (text) headings = [...headings, text].slice(-4);
  };
  for (let r = L.header + 1; r < s.rows.length; r++) {
    const row: TextRow = s.rows[r] ?? [];
    const loc = at(row, L.loc);
    const title = at(row, L.title);
    if (!loc && !title) {
      const a = at(row, 0) || at(row, 1);
      if (a) {
        section = a;
        pushHeading(row, L.loc);
      }
      continue;
    }
    if (/^location$/i.test(loc ?? '')) {
      pushHeading(row, Math.min(L.loc, Math.max(0, L.title))); // a group title on the repeated header row
      continue;
    }
    if (!loc) {
      if (title) {
        section = title; // sub-banner
        pushHeading(row, L.loc);
      }
      continue;
    }
    const n = drawingNumberOf(L.leftCols.map((c) => at(row, c)));
    const q = (base: number) => (base >= 0 ? ([1, 2, 3, 4].find((k) => flag(at(row, base + k))) ?? null) : null);
    const any = (base: number) => base >= 0 && [0, 1, 2, 3, 4].some((k) => flag(at(row, base + k)));
    const issuedTill = L.issuedTill >= 0 ? flag(at(row, L.issuedTill)) : false;
    const issuedThisYear = any(L.issued);
    out.push({
      workbook: path.basename(spec.file),
      sheet: s.name,
      row: r + 1,
      projectCode: spec.projectCode,
      role: spec.role,
      label: spec.label,
      snapshotDate: isoDate(spec.snapshotDate),
      planYear: L.planYearInHeader ?? spec.planYear,
      issuedTillYear: L.issuedTillYear,
      discipline: (L.discipline >= 0 ? normaliseDiscipline(at(row, L.discipline)) : null) ?? sheetDisc,
      section,
      headings,
      location: loc,
      batchCode: at(row, L.batchCode),
      batch: at(row, L.batch),
      title,
      number: n.number,
      numberKind: n.kind,
      partial: n.partial,
      revision: L.revision >= 0 ? at(row, L.revision) : null,
      issuedTill,
      issuedThisYear,
      issuedQuarter: q(L.issued),
      plannedThisYear: any(L.plan),
      plannedQuarter: q(L.plan),
      explicitDate: L.date >= 0 ? at(row, L.date) : null,
      releaseDate: L.releaseDate >= 0 ? parseCalendarDate(at(row, L.releaseDate)) : null,
      revisionDate: L.revisionDate >= 0 ? parseCalendarDate(at(row, L.revisionDate)) : null,
      responsible: L.responsible >= 0 ? at(row, L.responsible) : null,
      inAcc: L.inAcc >= 0 ? at(row, L.inAcc) : null,
      // A sheet with no issue columns records a release by its release date.
      released: issuedTill || issuedThisYear || (L.issued < 0 && L.issuedTill < 0 && L.releaseDate >= 0 && parseCalendarDate(at(row, L.releaseDate)) != null),
    });
  }
  return { rows: out, layout: L };
}

export interface ParsedSources {
  plan: PlanRow[];
  register: RegisterRow[];
  acc: AccRow[];
  sheetsRead: { workbook: string; sheet: string; rows: number; layout?: string }[];
  warnings: string[];
  /** Formula cells of the sheets read whose value could not be worked out. */
  formulaIssues?: { workbook: string; sheet: string; row: number; col: number; formula: string; reason: string }[];
  designFees: (DesignFeeParse & { projectCode: string; workbook: string })[];
  /** Design Fee sheets that could not be read: reported, the rest of the import goes on. */
  feeIssues?: PlanIssue[];
}

export function parseSources(manifest: DrawingManifest, sourceFolder: string): ParsedSources {
  const plan: PlanRow[] = [];
  const sheetsRead: ParsedSources['sheetsRead'] = [];
  const warnings: string[] = [];
  const formulaIssues: NonNullable<ParsedSources['formulaIssues']> = [];
  const noteFormulas = (workbook: string, s: TextSheet | undefined) => {
    for (const f of s?.formulaIssues ?? []) formulaIssues.push({ workbook, ...f });
  };
  const pattern = new RegExp(manifest.planSheetPattern, 'i');
  const cache = new Map<string, TextSheet[]>();
  const read = (file: string) => {
    const hit = cache.get(file);
    if (hit) return hit;
    const sheets = readTextWorkbook(path.join(sourceFolder, file));
    cache.set(file, sheets);
    return sheets;
  };

  for (const spec of manifest.planWorkbooks) {
    const sheets = read(spec.file);
    for (const s of sheets) {
      if (!pattern.test(s.name) || s.hidden) continue;
      const parsed = parsePlanSheet(spec, s);
      if (!parsed) {
        warnings.push(`${spec.file} :: ${s.name}: no "Location" header in rows 1-8 — sheet skipped`);
        continue;
      }
      if (parsed.layout.planYearInHeader != null && parsed.layout.planYearInHeader !== spec.planYear) {
        warnings.push(
          `${spec.file} :: ${s.name}: header plan year ${parsed.layout.planYearInHeader} differs from manifest ${spec.planYear}`,
        );
      }
      plan.push(...parsed.rows);
      noteFormulas(spec.file, s);
      sheetsRead.push({ workbook: spec.file, sheet: s.name, rows: parsed.rows.length });
    }
  }

  const register: RegisterRow[] = [];
  const acc: AccRow[] = [];
  const reg = manifest.register;
  if (reg) {
    const sheets = readTextWorkbook(path.join(sourceFolder, reg.file));
    const byName = new Map(sheets.map((s) => [s.name, s]));
    for (const spec of reg.sheets) {
      const s = byName.get(spec.name);
      if (!s) throw new Error(`Register sheet "${spec.name}" not found in ${reg.file}`);
      noteFormulas(reg.file, s);
      const C = Object.fromEntries(Object.entries(spec.columns).map(([k, v]) => [k, colIndex(v)])) as Record<
        keyof typeof spec.columns,
        number
      >;
      let section: string | null = null;
      let count = 0;
      for (let r = spec.firstDataRow - 1; r < s.rows.length; r++) {
        const row = s.rows[r] ?? [];
        const no = at(row, C.number);
        const title = at(row, C.title);
        if (!no && !title) continue;
        if (no && !title && !at(row, C.revision)) {
          section = no;
          continue;
        }
        register.push({
          workbook: reg.file,
          sheet: spec.name,
          row: r + 1,
          discipline: spec.discipline,
          section,
          number: no,
          title,
          location: at(row, C.location),
          batchCode: at(row, C.batchCode),
          batch: at(row, C.batch),
          revision: at(row, C.revision),
        });
        count++;
      }
      sheetsRead.push({ workbook: reg.file, sheet: spec.name, rows: count });
    }
    if (reg.acc) {
      const s = byName.get(reg.acc.sheet);
      if (!s) throw new Error(`ACC sheet "${reg.acc.sheet}" not found in ${reg.file}`);
      const C = Object.fromEntries(Object.entries(reg.acc.columns).map(([k, v]) => [k, colIndex(v)])) as Record<
        keyof typeof reg.acc.columns,
        number
      >;
      for (let r = reg.acc.headerRow; r < s.rows.length; r++) {
        const row = s.rows[r] ?? [];
        const no = at(row, C.number);
        if (!no) continue;
        const releaseText = at(row, C.releaseDate);
        const createdText = at(row, C.createdAt);
        const v = at(row, C.versions);
        acc.push({
          workbook: reg.file,
          sheet: reg.acc.sheet,
          row: r + 1,
          number: no,
          title: at(row, C.title),
          collection: at(row, C.collection),
          versions: v ? Number.parseInt(v, 10) || 0 : null,
          releaseDateText: releaseText,
          releaseDate: parseCalendarDate(releaseText),
          createdAtText: createdText,
          createdAt: parseTimestamp(createdText),
          discipline: at(row, C.discipline),
          tags: at(row, C.tags),
        });
      }
      sheetsRead.push({ workbook: reg.file, sheet: reg.acc.sheet, rows: acc.length });
    }
  }
  const designFees: ParsedSources['designFees'] = [];
  const feeIssues: PlanIssue[] = [];
  for (const spec of manifest.designFees) {
    const s = read(spec.file).find((x) => x.name === spec.sheet);
    if (!s) throw new Error(`Design Fee sheet "${spec.sheet}" not found in ${spec.file}`);
    noteFormulas(spec.file, s);
    let parsed: DesignFeeParse;
    try {
      parsed = parseDesignFee(spec, s, manifest.dfsHierarchy);
    } catch (e) {
      // A sheet of another layout never stops the drawings coming in: it is reported.
      feeIssues.push({
        severity: 'WARNING',
        code: 'DESIGN_FEE_LAYOUT_NOT_READ',
        projectCode: spec.projectCode,
        workbook: path.basename(spec.file),
        sheet: spec.sheet,
        message: `The Design Fee sheet "${spec.sheet}" could not be read (${e instanceof Error ? e.message : String(e)}). No packages or fees were taken from it; the drawings are imported without a package. Choose another Design Fee sheet in the Import Centre.`,
      });
      continue;
    }
    designFees.push({ ...parsed, projectCode: spec.projectCode, workbook: spec.file });
    sheetsRead.push({ workbook: spec.file, sheet: spec.sheet, rows: parsed.packages.length, layout: parsed.layout });
  }
  return { plan, register, acc, sheetsRead, warnings, formulaIssues, designFees, feeIssues };
}
