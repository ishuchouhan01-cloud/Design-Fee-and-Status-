/**
 * The "Design Fee" sheet of a 03YPlan workbook → packages and their
 * per-discipline fee (billing Scope).
 *
 * Layout (found by header label, never by fixed column):
 *   - a header row (rows 1–8) holding "Fee" cells, with one block per
 *     discipline starting at its label: AR · ST · MEP · LS (Tower08 spells
 *     landscape "LDS"). Inside a block: the label column holds the fee %,
 *     then "Fee" (Cr.), "Billed YTD" / "Billing YTD", … "Total" (drawings);
 *   - one row per package, its code in column B (`T01-01`, `BB01-1`, `SS1-01`).
 *
 * Only coded rows are packages. The heading rows between them are the base
 * DFS's own tree (WBS): "GFC | Tower—01", "GFC | Individual Homes",
 * "GFC | Independent Subgrade Structure—Block 04" … A stack follows the source
 * outline while reading down the sheet, so each heading hangs under its parent
 * (outline numbers such as "2.4" nest one level deeper than "9") and each
 * package under the heading it sits beneath. Nothing is derived from drawing or
 * batch codes. Headings that end up holding no package (design-concept stages,
 * post-construction) are not kept as nodes; their fees are reported, not
 * imported. A code that repeats in one sheet is a source defect (every ISS
 * block of the Residential sheet reuses `SS1-01` / `SS1-02`): the first row is
 * kept and every repeat is logged, never merged.
 *
 * A second layout (PACKAGE_TOTAL) carries ONE fee per package, in a column set
 * before any discipline block: "Total Fee | Released Till Date | Balance |
 * Billed till Dec'25 | Planned Billing …" (the labels vary: "Total", "Fee",
 * "Billed till date", "Billing YTD"). Its package rows carry the code with
 * the department prefix of the sheet's owner (`AR-BB26-2`); the package is the
 * code without it (`BB26-2`), so a drawing batch of any discipline
 * (`ST-BB26-2`, `MEP-BB26-2`) finds it. The fee is stored per package (the
 * PACKAGE_FEE_LINE line), never split over disciplines. Heading rows
 * (`BB26 | GFC | Villa Block 26`) are headings only in this layout.
 */
import path from 'node:path';
import { at, type TextSheet } from './read';
import type { PlanIssue } from './plan';
import { DEFAULT_WBS_NODE_TYPES, type FeeLayoutChoice, type WbsNodeType } from './manifest';

export const FEE_DISCIPLINES: Record<string, string> = { AR: 'AR', ST: 'ST', MEP: 'MEP', LS: 'LS', LDS: 'LS' };
/** `T01-01`, `BB01-1`, `SS1-01`, and the spaced form some sheets use (`MP 01`). */
export const PACKAGE_CODE_RE = /^[A-Z][A-Z0-9]{0,5}[- ]\d{1,2}$/;

/**
 * Discipline / department prefixes a package line or a drawing batch may carry
 * in front of the package code (`AR-BB26-2`, `ST-BB26-2`, `UD-MP-2`).
 */
export const DISCIPLINE_PREFIXES = ['AR', 'ST', 'MEP', 'LS', 'LDS', 'UD', 'SR', 'PHE', 'ELE', 'IBMS', 'ID', 'INFRA'];
const PREFIX_RE = new RegExp(`^(${DISCIPLINE_PREFIXES.join('|')})-`);

/** A package row's code: the package code, optionally with a discipline prefix. */
export function packageLineCode(v: string | null | undefined): { code: string; prefix: string | null } | null {
  if (!v) return null;
  const t = v.trim();
  if (PACKAGE_CODE_RE.test(t)) return { code: t, prefix: null };
  const m = PREFIX_RE.exec(t);
  if (m && PACKAGE_CODE_RE.test(t.slice(m[0].length))) return { code: t.slice(m[0].length), prefix: m[1] };
  return null;
}

/** The fee line of a whole package (PACKAGE_TOTAL layout): not a discipline. */
export const PACKAGE_FEE_LINE = 'PKG';

export type FeeLayout = 'DISCIPLINE_BLOCKS' | 'PACKAGE_TOTAL';

export interface FeeDisciplineValues {
  discipline: string; // AR | ST | MEP | LS, or PACKAGE_FEE_LINE
  percent: number | null;
  fee: number | null;
  billedToDate: number | null;
  totalDrawings: number | null;
  /** PACKAGE_TOTAL layout: "Released Till Date" and "Balance", kept as source values. */
  releasedToDate?: number | null;
  balance?: number | null;
}

export interface FeePackage {
  projectCode: string;
  workbook: string;
  sheet: string;
  row: number;
  code: string;
  /** The code as the row gives it (`AR-BB26-2` for package `BB26-2`). */
  lineCode?: string;
  name: string;
  section: string | null;
  heading: string | null;
  /** The package's position number inside its heading ("3:4" in the sheet). */
  ordinal: number | null;
  /** Key of the WBS node the package sits under (null: directly under the project). */
  nodeKey: string | null;
  sequence: number;
  /** Responsible Person, when the sheet has such a column (never invented). */
  responsible: string | null;
  disciplines: FeeDisciplineValues[];
}

/** One heading of the base-DFS tree. */
export interface FeeWbsNode {
  key: string;
  parentKey: string | null;
  type: WbsNodeType;
  name: string;
  code: string | null;
  sourceLabel: string;
  depth: number;
  sequence: number;
  section: string | null;
  workbook: string;
  sheet: string;
  row: number;
}

export interface WbsOptions {
  labelPrefix?: string;
  nodeTypes?: { pattern: string; type: WbsNodeType }[];
}

export interface DesignFeeParse {
  layout?: FeeLayout;
  /** The sheet's own title in its header row ("0072 | After the Rain Phase 2c"). */
  title?: { code: string | null; name: string } | null;
  packages: FeePackage[];
  /** The WBS headings that hold at least one package, parents first. */
  nodes: FeeWbsNode[];
  issues: PlanIssue[];
  /** The sheet's own "Design Fees" total per discipline. */
  sheetTotal: Record<string, number>;
  /** Fee per discipline on the imported packages. */
  packageFees: Record<string, number>;
  /** Fee per discipline on repeated-code rows that were not imported. */
  duplicateFees: Record<string, number>;
  /** sheetTotal − packageFees − duplicateFees: design-concept, post-construction
   *  and other stage fees that are not drawing packages. */
  feesOutsidePackages: Record<string, number>;
  /** PACKAGE_TOTAL layout: the sheet's billed total and the billed amount on the imported packages. */
  sheetBilled?: Record<string, number>;
  packageBilled?: Record<string, number>;
}

function num(v: string | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const SECTION_RE = /^[A-Z][A-Z &-]{4,}$/;
const OUTLINE_RE = /^\d+(\.\d+)*$/;
/** A heading's own code in the column before its label (Tower08: `BB01`, `PD`). */
const GROUP_CODE_RE = /^[A-Z]{1,5}\d{0,3}$/;

export function nodeTypeOf(name: string, rules: { pattern: string; type: WbsNodeType }[] = []): WbsNodeType {
  for (const r of [...rules, ...DEFAULT_WBS_NODE_TYPES]) if (new RegExp(r.pattern, 'i').test(name)) return r.type;
  return 'GROUP';
}

/**
 * The PACKAGE_TOTAL header: in rows 1–10, a "Balance" column with a total-fee
 * column before it, both left of any discipline block. Billed is the
 * "Billed / Billing till Dec'yy" column when there is one (the till-date
 * column is then the released value), else the till-date column itself.
 */
export function packageTotalHeader(s: TextSheet) {
  for (let r = 0; r < Math.min(10, s.rows.length); r++) {
    const row = s.rows[r] ?? [];
    const firstDisc = row.findIndex((v) => !!v && !!FEE_DISCIPLINES[v.trim().toUpperCase()]);
    const limit = firstDisc >= 0 ? firstDisc : row.length;
    const find = (re: RegExp, from: number, to: number) => {
      for (let c = from; c < to; c++) if (re.test((row[c] ?? '').trim())) return c;
      return -1;
    };
    const balance = find(/^balance$/i, 0, limit);
    if (balance < 0) continue;
    let total = -1;
    for (let c = balance - 1; c >= 0 && total < 0; c--) if (/^(total( fee)?|fee)$/i.test((row[c] ?? '').trim())) total = c;
    if (total < 0) continue;
    const tillDate = find(/^(released|billed|billing) (till date|ytd)$/i, total + 1, balance);
    const tillDec = find(/^bill(ed|ing) till dec/i, balance + 1, Math.min(limit, balance + 6));
    const tillLabel = tillDec >= 0 ? (row[tillDec] ?? '').trim() : null;
    const y = tillLabel ? /(\d{2,4})\s*$/.exec(tillLabel) : null;
    const tillYear = y ? (y[1].length === 2 ? 2000 + Number(y[1]) : Number(y[1])) : null;
    const releasedIsLabelled = tillDate >= 0 && /^released/i.test((row[tillDate] ?? '').trim());
    return {
      headerRow: r,
      total,
      balance,
      billed: tillDec >= 0 ? tillDec : releasedIsLabelled ? -1 : tillDate,
      released: tillDec >= 0 || releasedIsLabelled ? tillDate : -1,
      billedLabel: tillDec >= 0 ? tillLabel : tillDate >= 0 ? (row[tillDate] ?? '').trim() : null,
      tillYear,
    };
  }
  return null;
}

/** The DISCIPLINE_BLOCKS header: the row with "Fee" cells, else the one naming two or more blocks. Rows 1–10. */
function disciplineBlockHeader(s: TextSheet): number {
  const discCount = (r: number) => (s.rows[r] ?? []).filter((v) => v && FEE_DISCIPLINES[v.trim().toUpperCase()]).length;
  for (let r = 0; r < 10; r++) if ((s.rows[r] ?? []).some((v) => /^Fee$/i.test(v ?? '')) && discCount(r) >= 1) return r;
  for (let r = 0; r < 10; r++) if (discCount(r) >= 2) return r;
  return -1;
}

export function feeLayoutOf(s: TextSheet): FeeLayout | null {
  if (packageTotalHeader(s)) return 'PACKAGE_TOTAL';
  return disciplineBlockHeader(s) >= 0 ? 'DISCIPLINE_BLOCKS' : null;
}

/** "0072 | After the Rain Phase 2c" → { code: "0072", name: "After the Rain Phase 2c" }. */
export function sheetTitle(s: TextSheet, headerRow: number): { code: string | null; name: string } | null {
  for (const r of [headerRow, headerRow - 1, headerRow - 2]) {
    const v = [0, 1, 2, 3].map((c) => at(s.rows[r], c)).find((x) => x && /[A-Za-z]{3}/.test(x) && !/^(design (fee|packages)|packages design fee)$/i.test(x));
    if (!v) continue;
    const m = /^([0-9A-Z]{2,6})\s*\|\s*(.+)$/.exec(v);
    return m ? { code: m[1], name: m[2].trim() } : { code: null, name: v.trim() };
  }
  return null;
}

export interface FeeSheetCandidate {
  sheet: string;
  hidden: boolean;
  layout: FeeLayout | null;
  /** "R (3)" → 3, "R" → 1, plain "Design Fee" → 0. */
  revision: number;
  /** The year of the "Billed till Dec'yy" column, when the sheet has one. */
  billedTill: number | null;
  /** Package rows the sheet carries (0 when its layout is not readable). */
  packages: number;
  /** PACKAGE_TOTAL sheets that also carry per-discipline blocks: whether those
   *  blocks add up to the package fees (then "per discipline" is a choice too). */
  blocks: { total: number; packageTotal: number; complete: boolean } | null;
  rank: number;
  problem: string | null;
}

export function feeSheetRevision(name: string): number {
  const m = /design fees?\s*r\s*(?:\((\d+)\)|(\d+))?\s*$/i.exec(name.trim());
  if (!m) return 0;
  return Number(m[1] ?? m[2] ?? 1);
}

/**
 * Every Design Fee sheet of a workbook, best first. Deterministic: a sheet
 * whose layout reads and that has package rows; then a visible sheet before a
 * hidden one (a hidden sheet is a superseded copy); then the latest "Billed
 * till Dec'yy" year; then the highest revision ("R (3)" over "R (2)" over
 * "R" over plain "Design Fee"); then the name.
 */
export function feeSheetCandidates(sheets: TextSheet[]): FeeSheetCandidate[] {
  const out: FeeSheetCandidate[] = [];
  for (const s of sheets) {
    if (!/design fees?/i.test(s.name)) continue;
    const layout = feeLayoutOf(s);
    let packages = 0;
    let problem: string | null = null;
    let blocks: FeeSheetCandidate['blocks'] = null;
    if (layout) {
      try {
        const p = parseDesignFee({ file: 'x.xlsx', projectCode: 'PREVIEW' }, s);
        packages = p.packages.length;
        if (layout === 'PACKAGE_TOTAL' && disciplineBlockHeader(s) >= 0) {
          const d = parseDesignFee({ file: 'x.xlsx', projectCode: 'PREVIEW', layout: 'DISCIPLINE_BLOCKS' }, s);
          const total = round4(Object.values(d.packageFees).reduce((a, b) => a + b, 0) + Object.values(d.duplicateFees).reduce((a, b) => a + b, 0));
          const packageTotal = round4((p.packageFees[PACKAGE_FEE_LINE] ?? 0) + (p.duplicateFees[PACKAGE_FEE_LINE] ?? 0));
          blocks = { total, packageTotal, complete: d.packages.length === p.packages.length && Math.abs(total - packageTotal) <= Math.max(0.0005, packageTotal * 0.001) };
        }
      } catch (e) {
        problem = e instanceof Error ? e.message : String(e);
      }
      if (!problem && packages === 0) problem = 'No package rows (a package code such as BB01-1 or AR-BB01-1 in the first columns).';
    } else problem = 'Neither a discipline-block header (AR / ST / MEP / LS with Fee) nor a Total Fee / Balance header in rows 1–10.';
    out.push({ sheet: s.name, hidden: s.hidden, layout, revision: feeSheetRevision(s.name), billedTill: packageTotalHeader(s)?.tillYear ?? null, packages, blocks, rank: 0, problem });
  }
  out.sort(
    (a, b) =>
      Number(!!b.layout && b.packages > 0) - Number(!!a.layout && a.packages > 0) ||
      Number(a.hidden) - Number(b.hidden) ||
      (b.billedTill ?? 0) - (a.billedTill ?? 0) ||
      b.revision - a.revision ||
      a.sheet.localeCompare(b.sheet),
  );
  out.forEach((c, i) => (c.rank = i + 1));
  return out;
}

/** The Design Fee sheet to import: the one asked for when it exists, else the best candidate. */
export function chooseFeeSheet(sheets: TextSheet[], preferred?: string | null): FeeSheetCandidate | null {
  const list = feeSheetCandidates(sheets);
  if (preferred) {
    const hit = list.find((c) => c.sheet === preferred);
    if (hit) return hit;
  }
  return list[0] ?? null;
}

export function parseDesignFee(
  spec: { file: string; projectCode: string; label?: string; layout?: FeeLayoutChoice },
  s: TextSheet,
  wbs: WbsOptions = {},
): DesignFeeParse {
  const workbook = path.basename(spec.file);
  const issues: PlanIssue[] = [];
  const want = spec.layout ?? 'AUTO';
  const pt = want === 'DISCIPLINE_BLOCKS' ? null : packageTotalHeader(s);
  if (want === 'PACKAGE_TOTAL' && !pt) throw new Error(`${workbook} :: ${s.name}: no Total Fee / Balance column set in rows 1-10 (layout "one fee per package" was chosen)`);
  const layout: FeeLayout = pt ? 'PACKAGE_TOTAL' : 'DISCIPLINE_BLOCKS';
  const hr = pt ? pt.headerRow : disciplineBlockHeader(s);
  if (hr < 0) throw new Error(`${workbook} :: ${s.name}: no header row with discipline blocks (AR / ST / MEP / LS) or a Total Fee / Balance column set in rows 1-10`);
  const H = s.rows[hr] ?? [];
  type Block = { discipline: string; pct: number; fee: number; billed: number; total: number; released: number; balance: number };
  let blocks: Block[];
  if (pt) {
    // One fee per package, before any discipline block (those are not read: no split is invented).
    blocks = [{ discipline: PACKAGE_FEE_LINE, pct: -1, fee: pt.total, billed: pt.billed, total: -1, released: pt.released, balance: pt.balance }];
  } else {
    const starts: number[] = [];
    for (let c = 0; c < H.length; c++) if (H[c] && FEE_DISCIPLINES[H[c]!.trim().toUpperCase()]) starts.push(c);
    blocks = starts.map((st, i) => {
      const end = starts[i + 1] ?? H.length;
      const find = (re: RegExp) => {
        for (let c = st; c < end; c++) if (re.test(H[c] ?? '')) return c;
        return -1;
      };
      const fee = find(/^Fee$/i);
      return {
        discipline: FEE_DISCIPLINES[H[st]!.trim().toUpperCase()],
        pct: st,
        // Without a "Fee" label the block is [percent, fee] pairs (Violet Hill layout).
        fee: fee >= 0 ? fee : starts[i + 1] !== st + 1 ? st + 1 : -1,
        billed: find(/^Bill(ed|ing) YTD$/i),
        total: find(/^Total$/i),
        released: -1,
        balance: -1,
      };
    });
  }
  const lineValues = (row: (string | null)[]): FeeDisciplineValues[] =>
    blocks.map((bl) => ({
      discipline: bl.discipline,
      percent: num(at(row, bl.pct)),
      fee: bl.fee >= 0 ? num(at(row, bl.fee)) : null,
      billedToDate: bl.billed >= 0 ? num(at(row, bl.billed)) : null,
      totalDrawings: bl.total >= 0 ? num(at(row, bl.total)) : null,
      ...(pt ? { releasedToDate: bl.released >= 0 ? num(at(row, bl.released)) : null, balance: bl.balance >= 0 ? num(at(row, bl.balance)) : null } : {}),
    }));
  // PACKAGE_TOTAL: the sheet totals are the "Design Fee(s)" row just below the
  // header (row 5), or — without a label — the first non-integer total there
  // (the row above it counts packages).
  const sheetBilled: Record<string, number> = {};
  const totalsRows = new Set<number>();
  const sheetTotal: Record<string, number> = {};
  if (pt) {
    const cand = [hr + 1, hr + 2, hr + 3];
    const labelOf = (r: number) => [0, 1, 2, 3].map((c) => at(s.rows[r], c)).find((v) => v && /[A-Za-z]/.test(v)) ?? null;
    let tr = cand.find((r) => /^design fees?$/i.test(labelOf(r) ?? '')) ?? -1;
    if (tr < 0) tr = cand.find((r) => !labelOf(r) && !Number.isInteger(num(at(s.rows[r], pt.total)) ?? 0)) ?? -1;
    for (const r of cand) if (/^design packages$/i.test(labelOf(r) ?? '') || r === tr) totalsRows.add(r);
    if (tr >= 0) {
      sheetTotal[PACKAGE_FEE_LINE] = num(at(s.rows[tr], pt.total)) ?? 0;
      if (pt.billed >= 0) sheetBilled[PACKAGE_FEE_LINE] = num(at(s.rows[tr], pt.billed)) ?? 0;
      // The count row above the total has no package code: mark it read.
      if (tr - 1 > hr) totalsRows.add(tr - 1);
    }
  }

  // A Responsible Person column anywhere in the header row (responsible / design lead / owner).
  const respCol = H.findIndex((v) => !!v && /^(responsible( person)?|resposible|design lead|drawing owner|owner|in[- ]?charge)$/i.test(v.trim()));
  const packages: FeePackage[] = [];
  const seen = new Map<string, number>();
  const packageFees: Record<string, number> = {};
  const duplicateFees: Record<string, number> = {};
  const packageBilled: Record<string, number> = {};
  let section: string | null = null;
  let heading: string | null = null;
  let sequence = 0;
  const prefixRe = wbs.labelPrefix ? new RegExp(wbs.labelPrefix, 'i') : null;
  const allNodes: FeeWbsNode[] = [];
  const nodeKeys = new Set<string>();
  const duplicateHeadings = new Map<string, string>();
  /** Open headings, outermost first. A PHASE heading stays open across sections. */
  let stack: FeeWbsNode[] = [];
  let nodeSeq = 0;
  const openHeading = (label: string, marker: string | null, ownCode: string | null, r: number) => {
    const name = (prefixRe ? label.replace(prefixRe, '') : label).trim() || label;
    const type = nodeTypeOf(name, wbs.nodeTypes);
    const outline = marker && OUTLINE_RE.test(marker) ? marker.split('.').length : 1;
    // A phase heading closes everything; other headings nest by outline depth.
    const depth = type === 'PHASE' ? 0 : outline;
    stack = stack.filter((n) => n.depth < depth);
    const parent = stack[stack.length - 1] ?? null;
    const path = [...stack.map((n) => n.name), name].join(' › ');
    let key = `${type === 'PHASE' ? '' : section ?? ''}::${path}`;
    if (nodeKeys.has(key)) {
      key = `${key}#${r + 1}`;
      duplicateHeadings.set(key, label);
    }
    nodeKeys.add(key);
    nodeSeq += 10;
    const node: FeeWbsNode = {
      key,
      parentKey: parent?.key ?? null,
      type,
      name,
      code: ownCode,
      sourceLabel: label,
      depth,
      sequence: nodeSeq,
      section,
      workbook,
      sheet: s.name,
      row: r + 1,
    };
    allNodes.push(node);
    stack.push(node);
    heading = label;
  };

  const leafLines: { node: FeeWbsNode; code: string; name: string; row: number; disciplines: FeeDisciplineValues[]; section: string | null; ordinal: number | null }[] = [];
  for (let r = hr + 1; r < s.rows.length; r++) {
    const row = s.rows[r] ?? [];
    if (totalsRows.has(r)) continue;
    // The package code sits in the first label columns (B in most sheets, C or A in some),
    // optionally with a discipline prefix (AR-BB26-2 → BB26-2).
    // PACKAGE_TOTAL sheets hyphenate every package code; their spaced "DC 01" lines are design stages.
    const lineOf = (c: number) => {
      const l = packageLineCode(at(row, c));
      return l && pt && !l.code.includes('-') ? null : l;
    };
    const codeCol = [1, 2, 0].find((c) => lineOf(c) != null);
    const line = codeCol != null ? lineOf(codeCol) : null;
    const b = line?.code ?? null;
    const texts = [at(row, 1), at(row, 2), at(row, 3)].filter((v): v is string => Boolean(v));
    const first = texts[0] ?? null;
    if (!b || !line) {
      if (first && SECTION_RE.test(first) && texts.length === 1) {
        section = first;
        heading = null;
        stack = stack.filter((n) => n.type === 'PHASE');
        continue;
      }
      // The sheet total ("Design Fees") and roll-up / stage rows.
      const label = [...texts].reverse().find((t) => !OUTLINE_RE.test(t)) ?? null;
      if (label && /^Design (Fees|Packages)$/i.test(label)) {
        if (/^Design Fees$/i.test(label) && !pt) for (const bl of blocks) sheetTotal[bl.discipline] = num(at(row, bl.fee)) ?? 0;
        continue;
      }
      if (!label || r <= hr + 3) continue;
      // A heading: its label with an outline number / own code before it, or a
      // roll-up row carrying the fees of what follows.
      const idx = [3, 2, 1].find((c) => at(row, c) === label) ?? 3;
      const markers = [1, 2, 3].filter((c) => c < idx).map((c) => at(row, c)).filter((v): v is string => Boolean(v));
      const outline = markers.find((m) => OUTLINE_RE.test(m) && m.includes('.')) ?? markers.find((m) => OUTLINE_RE.test(m)) ?? null;
      const ownCode = markers.find((m) => GROUP_CODE_RE.test(m) && !OUTLINE_RE.test(m)) ?? null;
      const hasFee = blocks.some((bl) => num(at(row, bl.fee)) != null);
      if (outline || ownCode || hasFee || nodeTypeOf(label, wbs.nodeTypes) === 'PHASE') {
        openHeading(label, outline, ownCode, r);
        // A coded line with its own fees ("4 | MA | Master Archives"): a package
        // when nothing is found beneath it (decided after the sheet is read).
        // (PACKAGE_TOTAL sheets code every package on its own row: a heading stays a heading.)
        if (ownCode && hasFee && !pt) {
          const node = stack[stack.length - 1];
          const disciplines = lineValues(row);
          leafLines.push({ node, code: ownCode, name: label, row: r, disciplines, section, ordinal: outline && !outline.includes('.') ? Number(outline) : null });
        }
      }
      continue;
    }
    const name = [codeCol! + 1, codeCol! + 2, codeCol! + 3].map((c) => at(row, c)).find((v) => v && !/^\d+$/.test(v)) ?? b;
    if (seen.has(b)) {
      issues.push({
        severity: 'WARNING',
        code: 'DUPLICATE_PACKAGE_CODE',
        projectCode: spec.projectCode,
        workbook,
        sheet: s.name,
        rowNumber: r + 1,
        message: `Package code ${line.prefix ? `${at(row, codeCol!)} (package ${b})` : b} ("${name}"${heading ? ` under "${heading}"` : ''}) repeats row ${seen.get(b)} of the same sheet. The first row is the package; this row is not imported.`,
        payload: Object.fromEntries(blocks.map((bl) => [bl.discipline, num(at(row, bl.fee))])),
      });
      for (const bl of blocks) {
        const v = num(at(row, bl.fee));
        if (v) duplicateFees[bl.discipline] = (duplicateFees[bl.discipline] ?? 0) + v;
      }
      continue;
    }
    seen.set(b, r + 1);
    sequence += 10;
    const disciplines = lineValues(row);
    for (const d of disciplines) {
      if (d.fee) packageFees[d.discipline] = (packageFees[d.discipline] ?? 0) + d.fee;
      if (d.billedToDate) packageBilled[d.discipline] = (packageBilled[d.discipline] ?? 0) + d.billedToDate;
    }
    const ord = [1, 2].map((c) => at(row, c)).find((v) => v && /^\d+$/.test(v)) ?? null;
    const parent = stack[stack.length - 1] ?? null;
    packages.push({
      projectCode: spec.projectCode,
      workbook,
      sheet: s.name,
      row: r + 1,
      code: b,
      ...(line.prefix ? { lineCode: at(row, codeCol!)! } : {}),
      name,
      section,
      heading: parent ? parent.sourceLabel : heading,
      ordinal: ord && /^\d+$/.test(ord) ? Number(ord) : null,
      nodeKey: parent?.key ?? null,
      sequence,
      responsible: respCol >= 0 ? at(row, respCol) : null,
      disciplines,
    });
  }

  // Coded fee lines with no package and no heading beneath them are packages.
  for (const l of leafLines) {
    if (packages.some((p) => p.nodeKey === l.node.key) || allNodes.some((n) => n.parentKey === l.node.key) || seen.has(l.code)) continue;
    seen.set(l.code, l.row + 1);
    const idx = allNodes.indexOf(l.node);
    if (idx >= 0) allNodes.splice(idx, 1);
    for (const d of l.disciplines) if (d.fee) packageFees[d.discipline] = (packageFees[d.discipline] ?? 0) + d.fee;
    const parent = l.node.parentKey ? allNodes.find((n) => n.key === l.node.parentKey) ?? null : null;
    packages.push({
      projectCode: spec.projectCode,
      workbook,
      sheet: s.name,
      row: l.row + 1,
      code: l.code,
      name: (prefixRe ? l.name.replace(prefixRe, '') : l.name).trim() || l.name,
      section: l.section,
      heading: parent?.sourceLabel ?? null,
      ordinal: l.ordinal,
      nodeKey: parent?.key ?? null,
      sequence: l.node.sequence,
      responsible: null,
      disciplines: l.disciplines,
    });
  }
  if (leafLines.length) {
    packages.sort((a, b) => a.row - b.row);
    packages.forEach((p, i) => (p.sequence = (i + 1) * 10));
  }

  // Keep the headings that hold a package (directly or below), parents first.
  const used = new Set<string>();
  const byKey = new Map(allNodes.map((n) => [n.key, n]));
  for (const p of packages) {
    let k = p.nodeKey;
    while (k && !used.has(k)) {
      used.add(k);
      k = byKey.get(k)?.parentKey ?? null;
    }
  }
  const nodes = allNodes.filter((n) => used.has(n.key));
  for (const n of nodes) {
    const label = duplicateHeadings.get(n.key);
    if (!label) continue;
    issues.push({
      severity: 'WARNING',
      code: 'WBS_DUPLICATE_HEADING',
      projectCode: spec.projectCode,
      workbook,
      sheet: s.name,
      rowNumber: n.row,
      message: `Heading "${label}" repeats an earlier heading at the same level${n.section ? ` in ${n.section}` : ''}. Kept as a separate node; check the source.`,
    });
  }
  const hasGroups = packages.some((p) => p.nodeKey);
  if (hasGroups) {
    const loose = packages.filter((p) => !p.nodeKey);
    if (loose.length) {
      issues.push({
        severity: 'WARNING',
        code: 'WBS_PACKAGE_WITHOUT_HEADING',
        projectCode: spec.projectCode,
        workbook,
        sheet: s.name,
        rowNumber: loose[0].row,
        message: `${loose.length} package(s) (${loose.slice(0, 6).map((p) => p.code).join(', ')}${loose.length > 6 ? ', …' : ''}) sit above any heading in the Design Fee sheet — shown directly under the project.`,
      });
    }
  }
  const feesOutsidePackages: Record<string, number> = {};
  const hasTotal = Object.keys(sheetTotal).length > 0;
  if (!hasTotal) {
    // No "Design Fees" total row to reconcile against: the imported fees are the total.
    if (pt) sheetBilled[PACKAGE_FEE_LINE] = packageBilled[PACKAGE_FEE_LINE] ?? 0;
    for (const bl of blocks) sheetTotal[bl.discipline] = (packageFees[bl.discipline] ?? 0) + (duplicateFees[bl.discipline] ?? 0);
    issues.push({
      severity: 'INFO',
      code: 'DESIGN_FEE_NO_SHEET_TOTAL',
      projectCode: spec.projectCode,
      workbook,
      sheet: s.name,
      message: 'The Design Fee sheet has no "Design Fees" total row, so imported fees cannot be reconciled to a sheet total.',
    });
  }
  for (const bl of blocks) {
    const d = bl.discipline;
    feesOutsidePackages[d] = round4((sheetTotal[d] ?? 0) - (packageFees[d] ?? 0) - (duplicateFees[d] ?? 0));
    packageFees[d] = round4(packageFees[d] ?? 0);
    duplicateFees[d] = round4(duplicateFees[d] ?? 0);
    sheetTotal[d] = round4(sheetTotal[d] ?? 0);
  }
  for (const k of Object.keys(sheetBilled)) sheetBilled[k] = round4(sheetBilled[k]);
  return {
    layout,
    title: sheetTitle(s, hr),
    packages,
    nodes,
    issues,
    sheetTotal,
    packageFees,
    duplicateFees,
    feesOutsidePackages,
    ...(pt ? { sheetBilled, packageBilled: { [PACKAGE_FEE_LINE]: round4(packageBilled[PACKAGE_FEE_LINE] ?? 0) } } : {}),
  };
}

function round4(v: number) {
  return Math.round(v * 10000) / 10000;
}

/**
 * The explicit batch → package rule. A drawing's batch code is its package's
 * code with an optional discipline prefix and an unpadded number:
 *
 *   AR-T01-1 → T01-01      ST-TXV-12 → TXV-12      BB01-2 → BB01-2
 *   ST-BB26-2 → BB26-2 (fee line AR-BB26-2)          T09-3 → T9-3
 *
 * Nothing else is tried; a batch whose package is not in the Design Fee sheet
 * stays unlinked (BATCH_WITHOUT_FEE_PACKAGE).
 */
export function packageCodeForBatch(batchCode: string | null | undefined, codes: Set<string>): string | null {
  if (!batchCode) return null;
  const variants = (loc: string, num: string) => {
    const n = String(Number(num));
    return [`${loc}-${n}`, `${loc}-${n.padStart(2, '0')}`, `${loc} ${n}`, `${loc} ${n.padStart(2, '0')}`];
  };
  const b = batchCode.trim().toUpperCase();
  // The package code with an optional discipline prefix (AR-T01-1 → T01-01) …
  const first = /^(.+)-(\d+)$/.exec(b.replace(PREFIX_RE, ''));
  if (first) for (const c of variants(first[1], first[2])) if (codes.has(c)) return c;
  // … with the location's own number padded or not (T09-3 → T9-3, BB1-2 → BB01-2), when exactly one matches …
  const loc = first ? /^([A-Z]+)(\d+)$/.exec(first[1]) : null;
  if (first && loc) {
    const n = String(Number(loc[2]));
    const locs = [...new Set([`${loc[1]}${n}`, `${loc[1]}${n.padStart(2, '0')}`, `${loc[1]}${n.padStart(3, '0')}`])].filter((x) => x !== first[1]);
    const hits = [...new Set(locs.flatMap((l) => variants(l, first[2])).filter((c) => codes.has(c)))];
    if (hits.length === 1) return hits[0];
  }
  // … or, when the prefix is a department code, just its last location segment
  // (UD-MP-1 → MP 01). Never a shorter, ambiguous match: one location, one number.
  const last = /^[A-Z0-9]+(?:-[A-Z0-9]+)*-([A-Z][A-Z0-9]*)-(\d+)$/.exec(b);
  if (last) {
    const hits = variants(last[1], last[2]).filter((c) => codes.has(c));
    if (hits.length === 1) return hits[0];
  }
  return null;
}

/** Location part of a package code (`T01-01` → `T01`), for the phase map. */
export function packageLocation(code: string): string {
  return code.replace(/[- ]\d+$/, '');
}
