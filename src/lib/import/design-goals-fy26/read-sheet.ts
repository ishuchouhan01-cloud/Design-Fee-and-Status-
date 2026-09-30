/**
 * Walks one FY26 "Goals" sheet and produces the project → phase → package →
 * dependency tree, plus every issue worth reporting.
 *
 * This layer does no database work; it is pure, so the classifier and the
 * hierarchy rules can be tested without a database.
 */
import path from 'node:path';
import type { Fy26IssueCode } from '@/lib/domain';
import { readWorkbook, type SheetData } from '../workbook';
import { classifyRow, mapColumns, type ClassifiedRow, type SheetColumns } from './classify';
import type { ScopeMapEntry } from './scope-map';

export interface ReadIssue {
  severity: 'INFO' | 'WARNING' | 'ERROR';
  code: Fy26IssueCode;
  workbook: string;
  sheet?: string | null;
  rowNumber?: number | null;
  sourceLabel?: string | null;
  message: string;
  payload?: unknown;
}

export interface ParsedDependency {
  sequence: number;
  stepLabel: string | null;
  description: string;
  targetDate: Date | null;
  responsibleText: string | null;
  remarks: string | null;
  sourceWorkbook: string;
  sourceSheet: string;
  sourceRow: number;
}

export interface ParsedPackage {
  /**
   * Ordinal among packages sharing the same (project, phase, discipline,
   * scope label, description). Eight source rows across ITQE, OTR and OtF are
   * genuinely distinct packages that repeat a description with a different
   * release date or billing value, so the natural key needs this to keep them
   * apart. Assigned in file+row order, which is stable across re-imports.
   */
  occurrence: number;
  projectName: string;
  phaseName: string | null;
  phaseSourceLabel: string | null;
  legacyProjectCode: string | null;
  legacyPhaseProjectCode: string | null;
  disciplineLabel: string | null;
  packageDescription: string;
  sourceScopeLabel: string;
  responsibleSourceText: string | null;
  releaseDate: Date | null;
  planBillingCr: number | null;
  actualBillingCr: number | null;
  plannedPackageQuantity: number | null;
  actualPackageQuantity: number | null;
  remarks: string | null;
  team: string[];
  sourceWorkbook: string;
  sourceSheet: string;
  sourceRow: number;
  dependencies: ParsedDependency[];
}

export interface SheetReadResult {
  workbook: string;
  sheet: string;
  packages: ParsedPackage[];
  issues: ReadIssue[];
  counts: Record<string, number>;
}

/**
 * Sheets to skip, with the reason.
 *
 * `New Projects - Goals FY 26-27Q3` is the stale twin of
 * `New Projects - Goals FY 26- (2)`. Evidence, from the workbook structure
 * rather than the name: the `(2)` sheet has Excel `sheetId` 37 against 36, and
 * sheetIds are assigned monotonically, so `(2)` was created later; it is first
 * in tab order (`rId1`); and the two sheets differ in exactly one row, where
 * `(2)` holds real data (`DP Submitted & Scrutiny in progress | Chandan`) and
 * the other still holds the template placeholder. Importing both would
 * double-count 28 packages, 55 dependency-shaped rows and Rs 24.365 Cr.
 */
export const SHEETS_TO_SKIP: { sheet: string; workbook: string; code: Fy26IssueCode; message: string }[] = [
  {
    workbook: 'New projects - FY26Q3 Design Goals.xlsx',
    sheet: 'New Projects - Goals FY 26-27Q3',
    code: 'DUPLICATE_SHEET_SKIPPED',
    message:
      'Stale duplicate of "New Projects - Goals FY 26- (2)". The (2) sheet has a higher Excel sheetId (37 vs 36), ' +
      'sits first in tab order, and is the only one of the two with row 12 filled in. Skipped to avoid double-counting ' +
      '28 packages, 55 dependency-shaped rows and Rs 24.365 Cr of planned billing.',
  },
];

/**
 * Status sheets whose own title names a different project from the workbook
 * they live in. Excluded rather than guessed, and never silently dropped.
 */
export const AMBIGUOUS_STATUS_SHEETS: { workbook: string; sheet: string; message: string }[] = [
  {
    workbook: '0106 SftH FY26Q3 Design Goals.xlsx',
    sheet: 'Pkgs Summary (Status)-Resi',
    message:
      'SftH workbook contains two Pkgs Summary (Status) sheets whose project title incorrectly references ' +
      'SftW / Songs From The Wood. Ownership of the status data cannot be established from the source. ' +
      'Therefore the sheets were excluded rather than guessed.',
  },
  {
    workbook: '0106 SftH FY26Q3 Design Goals.xlsx',
    sheet: 'Pkgs Summary (Status)-Com',
    message:
      'SftH workbook contains two Pkgs Summary (Status) sheets whose project title incorrectly references ' +
      'SftW / Songs From The Wood. Ownership of the status data cannot be established from the source. ' +
      'Therefore the sheets were excluded rather than guessed.',
  },
];

const PKGS_SUMMARY = /pkgs?\s*(summary|smmy)/i;

/**
 * projectName -> legacy `projects.project_code`, taken only from PROJECT-level
 * scope-map entries. A phase-level entry's legacy code names the legacy record
 * for that *phase* (the legacy model calls `ITQE-Ph1` a project), so it must
 * not be mistaken for the project's own legacy record.
 */
export function buildProjectLegacyIndex(scopeMap: Map<string, ScopeMapEntry>): Map<string, string> {
  const index = new Map<string, string>();
  for (const entry of scopeMap.values()) {
    if (entry.level !== 'PROJECT') continue;
    if (!entry.legacyProjectCode) continue;
    if (!index.has(entry.projectName)) index.set(entry.projectName, entry.legacyProjectCode);
  }
  return index;
}

function isGoalsSheet(name: string): boolean {
  return !PKGS_SUMMARY.test(name);
}

/** Apply a split-continuation row's values to the package it belongs to. */
function mergeSplitRow(pkg: ParsedPackage, row: ClassifiedRow, issues: ReadIssue[], workbook: string, sheet: string) {
  if (row.planBillingCr != null && pkg.planBillingCr == null) pkg.planBillingCr = row.planBillingCr;
  if (row.planPkgs != null && pkg.plannedPackageQuantity == null) pkg.plannedPackageQuantity = row.planPkgs;
  if (row.actualBillingCr != null && pkg.actualBillingCr == null) pkg.actualBillingCr = row.actualBillingCr;
  if (row.actualPkgs != null && pkg.actualPackageQuantity == null) pkg.actualPackageQuantity = row.actualPkgs;
  if (row.team.length && pkg.team.length === 0) pkg.team = row.team;
  if (row.disciplineCell && !pkg.disciplineLabel) pkg.disciplineLabel = row.disciplineCell;

  issues.push({
    severity: 'WARNING',
    code: 'PACKAGE_ROW_SPLIT_MERGED',
    workbook,
    sheet,
    rowNumber: row.rowNumber,
    sourceLabel: pkg.sourceScopeLabel,
    message:
      `Row ${row.rowNumber} carries billing/team values with columns B-F empty. ` +
      `Merged into the package at row ${pkg.sourceRow} ("${pkg.packageDescription}") rather than treated as a package.`,
    payload: {
      parentRow: pkg.sourceRow,
      planBillingCr: row.planBillingCr,
      planPkgs: row.planPkgs,
      team: row.team,
    },
  });

  // The orphan row sometimes states a phase that contradicts its parent. Report
  // it; never overwrite the parent's phase from an orphan row.
  if (row.phaseCell && pkg.phaseSourceLabel && row.phaseCell !== pkg.phaseSourceLabel) {
    issues.push({
      severity: 'WARNING',
      code: 'PHASE_CONFLICT_ON_SPLIT_ROW',
      workbook,
      sheet,
      rowNumber: row.rowNumber,
      sourceLabel: pkg.sourceScopeLabel,
      message:
        `Split row ${row.rowNumber} states phase "${row.phaseCell}" while its parent package at row ${pkg.sourceRow} ` +
        `belongs to "${pkg.phaseSourceLabel}". The source contradicts itself; the parent's phase was kept and the ` +
        `orphan phase was NOT applied.`,
      payload: { orphanPhase: row.phaseCell, parentPhase: pkg.phaseSourceLabel, parentRow: pkg.sourceRow },
    });
  }
}

export function readGoalsSheet(
  sheet: SheetData,
  workbookName: string,
  scopeMap: Map<string, ScopeMapEntry>,
  projectLegacy: Map<string, string> = buildProjectLegacyIndex(scopeMap),
): SheetReadResult {
  const issues: ReadIssue[] = [];
  const packages: ParsedPackage[] = [];
  const counts: Record<string, number> = {};
  const bump = (k: string) => {
    counts[k] = (counts[k] ?? 0) + 1;
  };

  const header = mapColumns(sheet.rows);
  if (!header) {
    issues.push({
      severity: 'ERROR',
      code: 'UNMAPPED_SCOPE_LABEL',
      workbook: workbookName,
      sheet: sheet.name,
      message: 'No header row with Project / Description was found; the sheet could not be read.',
    });
    return { workbook: workbookName, sheet: sheet.name, packages, issues, counts };
  }

  const columns: SheetColumns = header.columns;
  let currentProject: ScopeMapEntry | null = null;
  let currentPhase: ScopeMapEntry | null = null;
  let currentDiscipline: string | null = null;
  let currentPackage: ParsedPackage | null = null;
  let dependencySeq = 0;

  for (let r = header.headerRow + 1; r < sheet.rows.length; r += 1) {
    const row = classifyRow(sheet.rows[r] ?? [], r, columns);
    bump(row.cls);

    switch (row.cls) {
      case 'SPACER':
        break;

      case 'DISCIPLINE':
        currentDiscipline = row.scopeLabel;
        break;

      case 'SPLIT_CONTINUATION':
        if (currentPackage) mergeSplitRow(currentPackage, row, issues, workbookName, sheet.name);
        break;

      case 'EMPTY_STEP':
        issues.push({
          severity: 'INFO',
          code: 'EMPTY_STEP_MARKER',
          workbook: workbookName,
          sheet: sheet.name,
          rowNumber: row.rowNumber,
          message: `"${row.scopeLabel ?? ''}" marker with no description, date, owner or remark. Not imported.`,
        });
        break;

      case 'TEMPLATE':
        issues.push({
          severity: 'INFO',
          code: 'TEMPLATE_ROW_SKIPPED',
          workbook: workbookName,
          sheet: sheet.name,
          rowNumber: row.rowNumber,
          message:
            `Unfilled template placeholder (description "${row.description ?? ''}", responsible ` +
            `"${row.responsible ?? ''}"). Not imported.`,
        });
        break;

      case 'PROJECT': {
        // A banner. The scope map — not the banner's position — decides whether
        // it names a project or a phase.
        const entry = row.scopeLabel ? scopeMap.get(row.scopeLabel) : undefined;
        if (!entry) {
          issues.push({
            severity: 'ERROR',
            code: 'UNMAPPED_SCOPE_LABEL',
            workbook: workbookName,
            sheet: sheet.name,
            rowNumber: row.rowNumber,
            sourceLabel: row.scopeLabel,
            message:
              `Banner label "${row.scopeLabel}" is not in the scope map. Its project/phase identity cannot be ` +
              `established from the source, so nothing under it was imported.`,
          });
          currentProject = null;
          currentPhase = null;
          break;
        }
        if (entry.level === 'PHASE') {
          currentPhase = entry;
          if (!currentProject || currentProject.projectName !== entry.projectName) {
            currentProject = { ...entry, level: 'PROJECT', phaseName: null };
          }
        } else {
          currentProject = entry;
          currentPhase = null;
        }
        currentDiscipline = null;
        break;
      }

      case 'PACKAGE': {
        const entry = row.scopeLabel ? scopeMap.get(row.scopeLabel) : undefined;
        if (!entry) {
          issues.push({
            severity: 'ERROR',
            code: 'UNMAPPED_SCOPE_LABEL',
            workbook: workbookName,
            sheet: sheet.name,
            rowNumber: row.rowNumber,
            sourceLabel: row.scopeLabel,
            message: `Package scope label "${row.scopeLabel}" is not in the scope map. Row not imported.`,
          });
          break;
        }

        // A package row's own label can name its phase (`ITQE-Ph1`), a
        // sub-scope (`OWC`), or an abbreviated phase (`SftH - Res`). Whichever
        // it is, the scope map has already resolved it.
        const projectName = entry.projectName;
        const phaseName = entry.phaseName ?? (currentPhase?.projectName === projectName ? currentPhase.phaseName : null);
        const phaseSourceLabel = entry.phaseName
          ? entry.sourceLabel
          : currentPhase?.projectName === projectName
            ? currentPhase.sourceLabel
            : null;

        const pkg: ParsedPackage = {
          occurrence: 0,
          projectName,
          phaseName,
          phaseSourceLabel,
          legacyProjectCode: projectLegacy.get(projectName) ?? null,
          legacyPhaseProjectCode: entry.phaseName
            ? entry.legacyProjectCode
            : (currentPhase?.legacyProjectCode ?? null),
          disciplineLabel: row.disciplineCell ?? currentDiscipline,
          packageDescription: row.description ?? '',
          sourceScopeLabel: row.scopeLabel ?? '',
          responsibleSourceText: row.responsible,
          releaseDate: row.releaseDate,
          planBillingCr: row.planBillingCr,
          actualBillingCr: row.actualBillingCr,
          plannedPackageQuantity: row.planPkgs,
          actualPackageQuantity: row.actualPkgs,
          remarks: row.remarks,
          team: row.team,
          sourceWorkbook: workbookName,
          sourceSheet: sheet.name,
          sourceRow: row.rowNumber,
          dependencies: [],
        };

        if (row.releaseDate == null) {
          const raw = row.releaseDateRaw;
          if (raw != null && String(raw).trim() !== '') {
            issues.push({
              severity: 'WARNING',
              code: 'NON_DATE_RELEASE_VALUE',
              workbook: workbookName,
              sheet: sheet.name,
              rowNumber: row.rowNumber,
              message: `Release date cell holds "${String(raw).trim()}", which is not a date. Imported as empty.`,
            });
          } else {
            issues.push({
              severity: 'WARNING',
              code: 'MISSING_RELEASE_DATE',
              workbook: workbookName,
              sheet: sheet.name,
              rowNumber: row.rowNumber,
              message: `Package "${pkg.packageDescription}" has no release date. Imported as empty; no date invented.`,
            });
          }
        }
        if (!row.responsible) {
          issues.push({
            severity: 'WARNING',
            code: 'MISSING_RESPONSIBLE',
            workbook: workbookName,
            sheet: sheet.name,
            rowNumber: row.rowNumber,
            message: `Package "${pkg.packageDescription}" has no responsible person.`,
          });
        }

        packages.push(pkg);
        currentPackage = pkg;
        dependencySeq = 0;
        break;
      }

      case 'DEPENDENCY': {
        if (!currentPackage) {
          issues.push({
            severity: 'WARNING',
            code: 'UNMAPPED_SCOPE_LABEL',
            workbook: workbookName,
            sheet: sheet.name,
            rowNumber: row.rowNumber,
            message: 'Dependency row with no preceding package. Not imported.',
          });
          break;
        }
        dependencySeq += 10;
        currentPackage.dependencies.push({
          sequence: dependencySeq,
          stepLabel: row.scopeLabel,
          description: row.description ?? row.remarks ?? row.responsible ?? '(no description)',
          targetDate: row.releaseDate,
          responsibleText: row.responsible,
          remarks: row.remarks,
          sourceWorkbook: workbookName,
          sourceSheet: sheet.name,
          sourceRow: row.rowNumber,
        });
        break;
      }

      default:
        break;
    }
  }

  return { workbook: workbookName, sheet: sheet.name, packages, issues, counts };
}

export interface WorkbookReadResult {
  workbook: string;
  sheets: SheetReadResult[];
  issues: ReadIssue[];
}

export function readFy26Workbook(
  file: string,
  scopeMap: Map<string, ScopeMapEntry>,
  projectLegacy: Map<string, string> = buildProjectLegacyIndex(scopeMap),
): WorkbookReadResult {
  const wb = readWorkbook(file);
  const workbookName = path.basename(file);
  const issues: ReadIssue[] = [];
  const sheets: SheetReadResult[] = [];

  for (const s of wb.sheets) {
    if (s.hidden) continue;
    for (const f of s.formulaIssues ?? []) {
      issues.push({ severity: 'WARNING', code: 'FORMULA_NOT_EVALUATED', workbook: workbookName, sheet: s.name, rowNumber: f.row, message: `A formula (${f.formula}) could not be worked out (${f.reason}); the cell is treated as empty.` });
    }
  }
  const hiddenCount = wb.sheets.filter((s) => s.hidden).length;
  if (hiddenCount > 0) {
    issues.push({
      severity: 'INFO',
      code: 'HIDDEN_SHEET_SKIPPED',
      workbook: workbookName,
      message: `${hiddenCount} hidden sheet(s) skipped (legacy FY25/FY26-Q1/Q2 archives, per-lead copies and pivots).`,
    });
  }

  for (const ambiguous of AMBIGUOUS_STATUS_SHEETS) {
    if (ambiguous.workbook !== workbookName) continue;
    if (!wb.byName.has(ambiguous.sheet)) continue;
    issues.push({
      severity: 'WARNING',
      code: 'SOURCE_DATA_AMBIGUITY',
      workbook: workbookName,
      sheet: ambiguous.sheet,
      message: ambiguous.message,
    });
  }

  for (const sheet of wb.sheets) {
    if (sheet.hidden) continue;
    if (!isGoalsSheet(sheet.name)) continue;

    const skip = SHEETS_TO_SKIP.find((s) => s.workbook === workbookName && s.sheet === sheet.name);
    if (skip) {
      issues.push({
        severity: 'WARNING',
        code: skip.code,
        workbook: workbookName,
        sheet: sheet.name,
        message: skip.message,
      });
      continue;
    }
    sheets.push(readGoalsSheet(sheet, workbookName, scopeMap, projectLegacy));
  }

  return { workbook: workbookName, sheets, issues };
}
