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
 */
import path from 'node:path';
import { at, type TextSheet } from './read';
import type { PlanIssue } from './plan';
import { DEFAULT_WBS_NODE_TYPES, type WbsNodeType } from './manifest';

export const FEE_DISCIPLINES: Record<string, string> = { AR: 'AR', ST: 'ST', MEP: 'MEP', LS: 'LS', LDS: 'LS' };
/** `T01-01`, `BB01-1`, `SS1-01`, and the spaced form some sheets use (`MP 01`). */
export const PACKAGE_CODE_RE = /^[A-Z][A-Z0-9]{0,5}[- ]\d{1,2}$/;

export interface FeeDisciplineValues {
  discipline: string; // AR | ST | MEP | LS
  percent: number | null;
  fee: number | null;
  billedToDate: number | null;
  totalDrawings: number | null;
}

export interface FeePackage {
  projectCode: string;
  workbook: string;
  sheet: string;
  row: number;
  code: string;
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

export function parseDesignFee(
  spec: { file: string; projectCode: string; label?: string },
  s: TextSheet,
  wbs: WbsOptions = {},
): DesignFeeParse {
  const workbook = path.basename(spec.file);
  const issues: PlanIssue[] = [];
  // The header row: the one with "Fee" cells, else the one naming two or more
  // discipline blocks (AR · ST · MEP · LS). Rows 1–10.
  const discCount = (r: number) => (s.rows[r] ?? []).filter((v) => v && FEE_DISCIPLINES[v.trim().toUpperCase()]).length;
  let hr = -1;
  for (let r = 0; r < 10 && hr < 0; r++) if ((s.rows[r] ?? []).some((v) => /^Fee$/i.test(v ?? '')) && discCount(r) >= 1) hr = r;
  for (let r = 0; r < 10 && hr < 0; r++) if (discCount(r) >= 2) hr = r;
  if (hr < 0) throw new Error(`${workbook} :: ${s.name}: no header row with discipline blocks (AR / ST / MEP / LS) in rows 1-10`);
  const H = s.rows[hr] ?? [];
  const starts: number[] = [];
  for (let c = 0; c < H.length; c++) if (H[c] && FEE_DISCIPLINES[H[c]!.trim().toUpperCase()]) starts.push(c);
  const blocks = starts.map((st, i) => {
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
    };
  });

  // A Responsible Person column anywhere in the header row (responsible / design lead / owner).
  const respCol = H.findIndex((v) => !!v && /^(responsible( person)?|resposible|design lead|drawing owner|owner|in[- ]?charge)$/i.test(v.trim()));
  const packages: FeePackage[] = [];
  const seen = new Map<string, number>();
  const packageFees: Record<string, number> = {};
  const duplicateFees: Record<string, number> = {};
  const sheetTotal: Record<string, number> = {};
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
    // The package code sits in the first label columns (B in most sheets, C in some).
    const codeCol = [1, 2, 0].find((c) => PACKAGE_CODE_RE.test(at(row, c) ?? ''));
    const b = codeCol != null ? at(row, codeCol) : null;
    const texts = [at(row, 1), at(row, 2), at(row, 3)].filter((v): v is string => Boolean(v));
    const first = texts[0] ?? null;
    if (!b || !PACKAGE_CODE_RE.test(b)) {
      if (first && SECTION_RE.test(first) && texts.length === 1) {
        section = first;
        heading = null;
        stack = stack.filter((n) => n.type === 'PHASE');
        continue;
      }
      // The sheet total ("Design Fees") and roll-up / stage rows.
      const label = [...texts].reverse().find((t) => !OUTLINE_RE.test(t)) ?? null;
      if (label && /^Design (Fees|Packages)$/i.test(label)) {
        if (/^Design Fees$/i.test(label)) for (const bl of blocks) sheetTotal[bl.discipline] = num(at(row, bl.fee)) ?? 0;
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
        if (ownCode && hasFee) {
          const node = stack[stack.length - 1];
          const disciplines = blocks.map((bl) => ({
            discipline: bl.discipline,
            percent: num(at(row, bl.pct)),
            fee: bl.fee >= 0 ? num(at(row, bl.fee)) : null,
            billedToDate: bl.billed >= 0 ? num(at(row, bl.billed)) : null,
            totalDrawings: bl.total >= 0 ? num(at(row, bl.total)) : null,
          }));
          leafLines.push({ node, code: ownCode, name: label, row: r, disciplines, section, ordinal: outline && !outline.includes('.') ? Number(outline) : null });
        }
      }
      continue;
    }
    const name = [codeCol! + 1, codeCol! + 2].map((c) => at(row, c)).find((v) => v && !/^\d+$/.test(v)) ?? b;
    if (seen.has(b)) {
      issues.push({
        severity: 'WARNING',
        code: 'DUPLICATE_PACKAGE_CODE',
        projectCode: spec.projectCode,
        workbook,
        sheet: s.name,
        rowNumber: r + 1,
        message: `Package code ${b} ("${name}"${heading ? ` under "${heading}"` : ''}) repeats row ${seen.get(b)} of the same sheet. The first row is the package; this row is not imported.`,
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
    const disciplines = blocks.map((bl) => ({
      discipline: bl.discipline,
      percent: num(at(row, bl.pct)),
      fee: bl.fee >= 0 ? num(at(row, bl.fee)) : null,
      billedToDate: bl.billed >= 0 ? num(at(row, bl.billed)) : null,
      totalDrawings: bl.total >= 0 ? num(at(row, bl.total)) : null,
    }));
    for (const d of disciplines) if (d.fee) packageFees[d.discipline] = (packageFees[d.discipline] ?? 0) + d.fee;
    const ord = [1, 2].map((c) => at(row, c)).find((v) => v && /^\d+$/.test(v)) ?? null;
    const parent = stack[stack.length - 1] ?? null;
    packages.push({
      projectCode: spec.projectCode,
      workbook,
      sheet: s.name,
      row: r + 1,
      code: b,
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
  return { packages, nodes, issues, sheetTotal, packageFees, duplicateFees, feesOutsidePackages };
}

function round4(v: number) {
  return Math.round(v * 10000) / 10000;
}

/**
 * The explicit batch → package rule. A drawing's batch code is its package's
 * code with an optional discipline prefix and an unpadded number:
 *
 *   AR-T01-1 → T01-01      ST-TXV-12 → TXV-12      BB01-2 → BB01-2
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
  const first = /^(.+)-(\d+)$/.exec(b.replace(/^(AR|ST|MEP|LS)-/, ''));
  if (first) for (const c of variants(first[1], first[2])) if (codes.has(c)) return c;
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
