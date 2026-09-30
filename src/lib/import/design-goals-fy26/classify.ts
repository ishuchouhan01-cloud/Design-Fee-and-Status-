/**
 * Row classification for a Design Goals FY 26 "Goals" sheet.
 *
 * The sheet is a five-level outline flattened into rows. Excel's own outline
 * levels and fill colours are applied inconsistently across the 17 workbooks
 * and cannot be relied on, so classification is content-based.
 *
 *   PROJECT      column B names a project        (scope map, level PROJECT)
 *     PHASE      column B names a phase          (scope map, level PHASE)
 *       DISCIPLINE  column B is a discipline, C is a structural label
 *         PACKAGE   column B + C, with a date / billing / quantity
 *           DEPENDENCY  "Step N" in B, or B empty with real content in C-F
 *
 * Two rules here carry real weight:
 *
 * 1. A dependency is NOT identified by `Step N` in column B. 65 genuine
 *    dependency rows across the source carry nothing in column B at all — only
 *    a description, date, owner and remark. Requiring `Step N` loses 19% of the
 *    real dependencies.
 *
 * 2. A date alone does not make a row real. The Excel template block ships with
 *    plausible dates already filled in (`Task description 1 | 2026-10-15 |
 *    User 1`), so treating a date as evidence imports ~199 pure template rows.
 *    A row is real when it has a real description, a real owner, or a remark.
 */
import type { Fy26RowClass } from '@/lib/domain';
import { type Cell, type Row, date as toDate, text } from '../workbook';

/** Discipline banner labels seen across the 17 workbooks, incl. case variants. */
const DISCIPLINE_LABEL =
  /^(architecture|architectural|structure|structural|mep|mepf|landscape|master\s*plan(ning)?|interior(s| design)?|id|civil|plumbing|electrical)$/i;

/** Structural banner text in column C. */
const STRUCTURAL_DESCRIPTION = /^(package release|complete the project)/i;

const STEP_MARKER = /^step\s*\d+\b/i;

/** Template boilerplate Excel copies under every new package. */
const PLACEHOLDER_DESCRIPTION = /^task\s*description\s*\d*$/i;
const PLACEHOLDER_RESPONSIBLE = /^user\s*\d*$/i;

/** Excel serial 13 — the template block's unfilled date. */
const DUMMY_DATE_MS = Date.UTC(1900, 0, 13);

export interface SheetColumns {
  project: number;
  description: number;
  releaseDate: number;
  responsible: number;
  remarks: number;
  planBilling?: number;
  planPkgs?: number;
  actualBilling?: number;
  actualPkgs?: number;
  phase?: number;
  discipline?: number;
  designLead?: number;
  lead?: number;
  person1?: number;
  person2?: number;
  person3?: number;
  draftperson?: number;
}

export interface ClassifiedRow {
  rowNumber: number; // 1-based, as the spreadsheet shows it
  cls: Fy26RowClass;
  scopeLabel: string | null;
  description: string | null;
  releaseDate: Date | null;
  releaseDateRaw: Cell;
  responsible: string | null;
  remarks: string | null;
  planBillingCr: number | null;
  planPkgs: number | null;
  actualBillingCr: number | null;
  actualPkgs: number | null;
  phaseCell: string | null;
  disciplineCell: string | null;
  team: string[];
  /** Why a dependency row survived, for the import log. */
  keptBecause?: ('description' | 'responsible' | 'remarks')[];
}

function cell(row: Row, index: number | undefined): Cell {
  if (index == null) return null;
  const v = row[index];
  return v === undefined ? null : v;
}

function numeric(row: Row, index: number | undefined): number | null {
  const v = cell(row, index);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function intOrNull(row: Row, index: number | undefined): number | null {
  const n = numeric(row, index);
  return n == null ? null : Math.round(n);
}

function isDummyDate(v: Cell): boolean {
  if (v instanceof Date) return Math.abs(v.getTime() - DUMMY_DATE_MS) < 2 * 86_400_000;
  return typeof v === 'number' && Math.abs(v - 13) < 2;
}

/**
 * Locate the header row and map every column we care about by its *label*.
 *
 * Column letters differ between workbooks: 16 sheets put `Plan - Billing` in
 * column J, while ITQE (0063) and OTR (0082) insert explicit `Phase` and
 * `Discipline` columns that shift billing two columns left to H. Header rows
 * sit at row 3 in most sheets and row 4 in TuiG and Violet Hill. Nothing may be
 * addressed by a fixed letter.
 */
export function mapColumns(rows: Row[]): { headerRow: number; columns: SheetColumns } | null {
  for (let r = 0; r < Math.min(12, rows.length); r += 1) {
    const row = rows[r] ?? [];
    if (text(cell(row, 1)) !== 'Project' || text(cell(row, 2)) !== 'Description') continue;

    const columns: SheetColumns = { project: 1, description: 2, releaseDate: 3, responsible: 4, remarks: 5 };
    row.forEach((raw, j) => {
      const label = text(raw);
      if (!label) return;
      if (/^release\s*date$/i.test(label)) columns.releaseDate = j;
      else if (/^responsible$/i.test(label)) columns.responsible = j;
      else if (/^remarks?$/i.test(label) && columns.remarks === 5 && j < 8) columns.remarks = j;
      else if (/^plan\s*-\s*billing/i.test(label)) columns.planBilling = j;
      else if (/^plan\s*-\s*pkgs/i.test(label)) columns.planPkgs = j;
      else if (/^actuals?\s*-\s*billing/i.test(label)) columns.actualBilling = j;
      else if (/^actuals?\s*-\s*pkgs/i.test(label)) columns.actualPkgs = j;
      else if (/^phase$/i.test(label)) columns.phase = j;
      else if (/^discipline$/i.test(label)) columns.discipline = j;
      else if (/^design lead$/i.test(label) && columns.designLead == null) columns.designLead = j;
      else if (/^lead$/i.test(label)) columns.lead = j;
      else if (/^person\s*1$/i.test(label)) columns.person1 = j;
      else if (/^person\s*2$/i.test(label)) columns.person2 = j;
      else if (/^person\s*3$/i.test(label)) columns.person3 = j;
      else if (/^draftperson$/i.test(label)) columns.draftperson = j;
    });
    return { headerRow: r, columns };
  }
  return null;
}

function hasAnyValue(row: Row): boolean {
  return row.some((v) => v != null && String(v).trim() !== '');
}

/** True when columns B–F are all empty — the shape of a split package row. */
function coreColumnsEmpty(row: Row, c: SheetColumns): boolean {
  return [c.project, c.description, c.releaseDate, c.responsible, c.remarks].every((j) => {
    const v = cell(row, j);
    return v == null || String(v).trim() === '';
  });
}

export function classifyRow(row: Row, rowIndex: number, c: SheetColumns): ClassifiedRow {
  const scopeLabel = text(cell(row, c.project));
  const description = text(cell(row, c.description));
  const releaseRaw = cell(row, c.releaseDate);
  const responsible = text(cell(row, c.responsible));
  const remarks = text(cell(row, c.remarks));

  const base: ClassifiedRow = {
    rowNumber: rowIndex + 1,
    cls: 'SPACER',
    scopeLabel,
    description,
    releaseDate: isDummyDate(releaseRaw) ? null : toDate(releaseRaw),
    releaseDateRaw: releaseRaw,
    responsible,
    remarks,
    planBillingCr: numeric(row, c.planBilling),
    planPkgs: intOrNull(row, c.planPkgs),
    actualBillingCr: numeric(row, c.actualBilling),
    actualPkgs: intOrNull(row, c.actualPkgs),
    phaseCell: text(cell(row, c.phase)),
    disciplineCell: text(cell(row, c.discipline)),
    team: [c.designLead, c.lead, c.person1, c.person2, c.person3, c.draftperson]
      .map((j) => text(cell(row, j)))
      .filter((v): v is string => Boolean(v) && v !== '-' && v !== '0'),
  };

  if (!hasAnyValue(row)) return { ...base, cls: 'SPACER' };

  // Columns B-F empty but numbers or team names present: a package row whose
  // billing/team values were pushed onto a later row. Merged into the package
  // above by the reader — never a package of its own.
  if (coreColumnsEmpty(row, c)) {
    const carriesData =
      base.planBillingCr != null ||
      base.planPkgs != null ||
      base.actualBillingCr != null ||
      base.actualPkgs != null ||
      base.team.length > 0 ||
      base.phaseCell != null ||
      base.disciplineCell != null;
    return { ...base, cls: carriesData ? 'SPLIT_CONTINUATION' : 'SPACER' };
  }

  // Dependency position: an explicit Step marker, OR no scope label at all but
  // real content in the task columns. The second clause is the one that keeps
  // the 65 unlabelled dependency rows.
  const inDependencyPosition =
    (scopeLabel != null && STEP_MARKER.test(scopeLabel)) ||
    (scopeLabel == null && (description != null || releaseRaw != null || responsible != null || remarks != null));

  if (inDependencyPosition) {
    const descriptionIsReal = description != null && !PLACEHOLDER_DESCRIPTION.test(description);
    const responsibleIsReal = responsible != null && !PLACEHOLDER_RESPONSIBLE.test(responsible);
    const remarksIsReal = remarks != null;
    const dateIsReal = base.releaseDate != null;

    if (!description && !responsible && !remarks && !dateIsReal) {
      return { ...base, cls: 'EMPTY_STEP' };
    }
    if (descriptionIsReal || responsibleIsReal || remarksIsReal) {
      const keptBecause: ClassifiedRow['keptBecause'] = [];
      if (descriptionIsReal) keptBecause.push('description');
      if (responsibleIsReal) keptBecause.push('responsible');
      if (remarksIsReal) keptBecause.push('remarks');
      return { ...base, cls: 'DEPENDENCY', keptBecause };
    }
    return { ...base, cls: 'TEMPLATE' };
  }

  if (scopeLabel != null && DISCIPLINE_LABEL.test(scopeLabel)) return { ...base, cls: 'DISCIPLINE' };

  // A banner row: either no description at all, or one of the two structural
  // labels. Whether it denotes a project or a phase is decided by the scope
  // map, not by its position in the sheet.
  if (scopeLabel != null && (description == null || STRUCTURAL_DESCRIPTION.test(description))) {
    return { ...base, cls: 'PROJECT' };
  }

  if (scopeLabel != null && description != null) return { ...base, cls: 'PACKAGE' };

  return { ...base, cls: 'UNMAPPED' };
}

export const CLASSIFY_INTERNALS = {
  DISCIPLINE_LABEL,
  STRUCTURAL_DESCRIPTION,
  STEP_MARKER,
  PLACEHOLDER_DESCRIPTION,
  PLACEHOLDER_RESPONSIBLE,
  isDummyDate,
};
