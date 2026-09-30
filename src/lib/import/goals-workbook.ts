/**
 * Mapper for "Design Goals FY26-27 …xlsx".
 *
 * Sheet classification (full reasoning in DATA-MAPPING.md):
 *
 *   SOURCE / MASTER      Prj List, Prj Crtcl rqrmnt, Notes,
 *                        Goals 2026, Goals FY 26-27Q1, Goals FY 26-27Q2,
 *                        Goals FY 2026Q2 (Revised Plan),
 *                        Goals, Actuals 2026 Q1, ID Goals FY 26-27Q2
 *   DERIVED / IGNORED    every "<leader name>" sheet, every pivot, Smry,
 *                        One liner, Goal Summary 25Q4, Breakup-MP+MEP+LS,
 *                        26Q1 Actuals Smry, Data sheet, Sheet1, Sheet2
 *
 * The per-leader sheets are filtered copies of the same goal rows. Importing
 * them would create one record per quarter per leader — exactly what spec §6
 * forbids. They are skipped and logged, and the Goals screen reproduces them
 * as a Design Lead filter over the single master record set.
 */
import { calendarQuarter, fiscalQuarter } from '@/lib/periods';
import {
  cellAt,
  col,
  date,
  findColumn,
  findHeaderRow,
  int,
  num,
  text,
  type Row,
  type SheetData,
  type WorkbookData,
} from './workbook';
import type { ImportLogger } from './logger';
import {
  addGoalRevision,
  disciplineIdFor,
  findProjectByName,
  goalCodeFor,
  replaceTeam,
  upsertCriticalRequirement,
  upsertDeliverable,
  upsertGoal,
  upsertPhase,
  upsertProject,
  userIdForPersonName,
  hash6,
} from './upsert';
import { codeify } from '@/lib/ids';
import { db } from '@/db';
import { goals as goalsTable, projects as projectsTable } from '@/db/schema';
import { eq } from 'drizzle-orm';

const DERIVED_SHEET_PATTERNS = [
  /^Smry$/i,
  /Pivot/i,
  /^One liner$/i,
  /^Goal Summary/i,
  /^Breakup-/i,
  /Actuals Smry$/i,
  /^Data sheet$/i,
  /^Sheet\d+$/i,
  /Leaderwise$/i,
];

/** Leader-scoped copies of the master goal rows. */
const LEADER_SHEET_PATTERNS = [
  /^Goals FY 26-27Q2 .+/i,
  /^\s*FY26-27Q2 .+/i,
  /^26Q1 .+/i,
];

const GOAL_HEADER = [
  { column: col('B'), label: 'Project' },
  { column: col('C'), label: 'Phase' },
  { column: col('D'), label: 'Discipline' },
  { column: col('E'), label: 'Design Lead' },
  { column: col('F'), label: 'Description' },
];

interface GoalRowRaw {
  rowNumber: number;
  project: string;
  phase: string | null;
  discipline: string | null;
  lead: string;
  description: string;
}

function readLeaf(row: Row, rowNumber: number): GoalRowRaw | null {
  const project = text(cellAt(row, col('B')));
  const lead = text(cellAt(row, col('E')));
  const description = text(cellAt(row, col('F')));
  // Leaf rows carry a design lead AND a description. Rows with a project but
  // no lead are the workbook's own subtotal rows; rows with only a project are
  // portfolio section headers. Both are recomputed by the dashboard.
  if (!project || !lead || !description) return null;
  return {
    rowNumber,
    project,
    phase: text(cellAt(row, col('C'))),
    discipline: text(cellAt(row, col('D'))),
    lead,
    description,
  };
}

const TEAM_COLUMNS: { column: string; role: string }[] = [
  { column: 'M', role: 'LEAD' },
  { column: 'N', role: 'PERSON_1' },
  { column: 'O', role: 'PERSON_2' },
  { column: 'P', role: 'PERSON_3' },
  { column: 'Q', role: 'DRAFTPERSON' },
];

function remarkOf(row: Row): string | null {
  const v = text(cellAt(row, col('R')));
  if (!v) return null;
  if (v === '0' || v === 'T') return null; // flag columns reused as markers
  return v;
}

// ---------------------------------------------------------------------------
// 1. Project master list
// ---------------------------------------------------------------------------

const PORTFOLIO_LABELS: Record<string, string> = {
  ONGOING: 'Ongoing',
  'NEW PRJ': 'New Projects',
  DSGNBLD: 'Design & Build',
  HPL: 'HPL',
  CSR: 'CSR',
};

export async function importProjectList(sheet: SheetData, log: ImportLogger, workbook: string) {
  let portfolio = 'Ongoing';
  let count = 0;
  for (let i = 0; i < sheet.rows.length; i += 1) {
    const row = sheet.rows[i];
    const group = text(cellAt(row, col('A')));
    if (group) portfolio = PORTFOLIO_LABELS[group.toUpperCase()] ?? group;
    const name = text(cellAt(row, col('B')));
    if (!name) continue;
    if (/^\d+$/.test(name)) continue; // the header row's count cells
    const flag = text(cellAt(row, col('D')));
    const note = text(cellAt(row, col('E')));
    const active = int(cellAt(row, col('C'))) === 1;
    await upsertProject({
      name,
      portfolio,
      onHold: flag ? /hold/i.test(flag) : false,
      active,
      description: note ? `Marked "${note}" in the project master list` : null,
    });
    count += 1;
  }
  log.count('projects', count);
  log.info('PROJECTS_IMPORTED', `${count} projects read from the project master list`, {
    workbook,
    sheet: sheet.name,
  });
}

export async function importCriticalRequirements(sheet: SheetData, log: ImportLogger, workbook: string) {
  let count = 0;
  const unmatched = 0;
  for (let i = 1; i < sheet.rows.length; i += 1) {
    const row = sheet.rows[i];
    const label = text(cellAt(row, col('A')));
    const requirement = text(cellAt(row, col('B')));
    if (!label || !requirement) continue;
    if (/^(Project|Ongoing Projects|New Projects)$/i.test(label)) continue;
    if (/^Packages$/i.test(requirement)) continue;
    const projectId = await resolveOrCreateProject(label, 'Ongoing', log, {
      workbook,
      sheet: sheet.name,
      rowNumber: i + 1,
    });
    const extra = [col('C'), col('D'), col('E')]
      .map((c) => text(cellAt(row, c)))
      .filter(Boolean)
      .join(' | ');
    await upsertCriticalRequirement(projectId, label, extra ? `${requirement} | ${extra}` : requirement);
    count += 1;
  }
  log.count('criticalRequirements', count);
  log.info('CRITICAL_REQS', `${count} critical requirements imported, ${unmatched} unmatched`, {
    workbook,
    sheet: sheet.name,
  });
}

export async function importNotes(sheet: SheetData, log: ImportLogger, workbook: string) {
  let current: string | null = null;
  let count = 0;
  for (let i = 0; i < sheet.rows.length; i += 1) {
    const row = sheet.rows[i];
    const a = text(cellAt(row, col('A')));
    if (!a) continue;
    const projectId = await matchProject(a);
    if (projectId) {
      current = projectId;
      continue;
    }
    if (current) {
      await upsertCriticalRequirement(current, 'Note', a);
      count += 1;
    } else {
      log.info('NOTE_UNATTACHED', `Note with no preceding project heading: "${a.slice(0, 80)}"`, {
        workbook,
        sheet: sheet.name,
        rowNumber: i + 1,
      });
    }
  }
  log.count('notes', count);
}

/**
 * Project names in the workbooks are written many ways ("AtR", "AtR - 03",
 * "AtR Ph 1,2a,2b,2c", "Violet Hill [21.76a]"). Matching walks from exact to
 * progressively looser forms and never silently invents a project.
 */
const projectMatchCache = new Map<string, string | null>();

/**
 * Unambiguous shorthand seen in the goal sheets. Only entries where the
 * expansion is certain are listed; anything else is created as its own project
 * rather than guessed into an existing one.
 */
export const PROJECT_ALIASES: Record<string, string> = {
  SVKNHLI: 'Savakanahalli',
  TMK33A: 'Tumkur 33a',
  'NH30A MH': 'NH 30a - Madakuhosahalli',
  'NH37A': 'NH37a - Acharalahalli',
  'TR MILLS': 'TR Mills Chamarajpet',
  'SARJAPUR ROAD [SOUTH BLOCK-RESI]': 'Srjp - Res',
  'SARJAPUR - C (SOUTH BLOCK)': 'Srjp - C - SB',
  'SARJAPUR - C (NORTH BLOCK)': 'Srjp - C - NB',
  'ITQE-PH3A [T10-12 & 31 VILLAS]': 'ITQE-Ph2c',
  'JHANJH LAKE': 'Jhanjh Lake [Mayfair]',
  MAYFAIR: 'Jhanjh Lake [Mayfair]',
};

export async function matchProject(rawLabel: string): Promise<string | null> {
  const key = rawLabel.trim().toUpperCase();
  if (projectMatchCache.has(key)) return projectMatchCache.get(key)!;
  const result = await matchProjectUncached(rawLabel);
  projectMatchCache.set(key, result);
  return result;
}

export function clearProjectMatchCache() {
  projectMatchCache.clear();
}

function normalise(s: string): string {
  return s
    .toUpperCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\bPH\s*[\d.,ABCa-c\s-]*$/i, ' ')
    .replace(/[^A-Z0-9]+/g, '')
    .trim();
}

async function matchProjectUncached(rawLabel: string): Promise<string | null> {
  const aliasTarget = PROJECT_ALIASES[rawLabel.trim().toUpperCase()];
  if (aliasTarget) {
    const viaAlias = await findProjectByName(aliasTarget);
    if (viaAlias) return viaAlias;
  }
  const direct = await findProjectByName(rawLabel);
  if (direct) return direct;
  const all = await db.select({ id: projectsTable.id, name: projectsTable.projectName }).from(projectsTable);
  const target = normalise(rawLabel);
  if (!target) return null;
  const hit = all.find((p) => normalise(p.name) === target);
  if (hit) return hit.id;
  // Longest project name that is a prefix of the label (e.g. "AtR - 03" → "AtR")
  const prefixed = all
    .filter((p) => target.startsWith(normalise(p.name)) && normalise(p.name).length >= 3)
    .sort((a, b) => normalise(b.name).length - normalise(a.name).length);
  if (prefixed[0]) return prefixed[0].id;
  const contained = all
    .filter((p) => normalise(p.name).length >= 4 && normalise(p.name).includes(target))
    .sort((a, b) => normalise(a.name).length - normalise(b.name).length);
  if (contained[0]) return contained[0].id;
  return null;
}

/**
 * Goal rows sometimes name a delivery scope that is not on the project master
 * list (a work stream such as "Personalised Customisation", or a shorthand for
 * a scope split like "Srjp - C - SB"). Those rows are NOT dropped: the scope
 * becomes its own Project, tagged with the portfolio section it appeared under,
 * and the fact is logged. Losing hundreds of goal rows to a naming mismatch
 * would be worse than carrying an extra project row.
 */
async function resolveOrCreateProject(
  label: string,
  portfolio: string,
  log: ImportLogger,
  ctx: { workbook: string; sheet: string; rowNumber: number },
): Promise<string> {
  const found = await matchProject(label);
  if (found) return found;
  const id = await upsertProject({
    name: label,
    portfolio,
    description: `Created during Excel migration from the "${ctx.sheet}" sheet; not present on the project master list.`,
  });
  projectMatchCache.set(label.trim().toUpperCase(), id);
  log.warn(
    'PROJECT_CREATED_FROM_GOAL_ROW',
    `"${label}" is not on the project master list; created as a project under "${portfolio}" so its goal rows are kept`,
    { ...ctx },
  );
  log.count('projectsCreatedFromGoals');
  return id;
}

/** Portfolio section headers: a project name in column B with nothing else. */
function sectionHeaderOf(row: Row): string | null {
  const b = text(cellAt(row, col('B')));
  if (!b) return null;
  const hasOther = [col('C'), col('D'), col('E'), col('F')].some((c) => text(cellAt(row, c)));
  if (hasOther) return null;
  return b;
}

// ---------------------------------------------------------------------------
// 2. Calendar-year goal sheet ("Goals 2026")
// ---------------------------------------------------------------------------

export async function importCalendarGoals(
  sheet: SheetData,
  log: ImportLogger,
  workbook: string,
  year: number,
) {
  const headerIdx = findHeaderRow(sheet.rows, GOAL_HEADER);
  if (headerIdx < 0) {
    log.error('HEADER_NOT_FOUND', 'Could not locate the Project/Phase/Discipline header row', {
      workbook,
      sheet: sheet.name,
    });
    return;
  }
  const billingTotalCol = findColumn(sheet.rows, 'Billing [Cr.]', headerIdx + 1);
  const pkgsTotalCol = findColumn(sheet.rows, 'Pkgs', headerIdx + 1);
  if (billingTotalCol < 0 || pkgsTotalCol < 0) {
    log.error('QUARTER_COLUMNS_NOT_FOUND', 'Quarter columns for billing/packages not found', {
      workbook,
      sheet: sheet.name,
    });
    return;
  }
  const billingQ = [1, 2, 3, 4].map((q) => billingTotalCol + q);
  const pkgsQ = [1, 2, 3, 4].map((q) => pkgsTotalCol + q);

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let section = 'Ongoing';

  for (let i = headerIdx + 1; i < sheet.rows.length; i += 1) {
    const row = sheet.rows[i];
    const header = sectionHeaderOf(row);
    if (header) section = header;
    const leaf = readLeaf(row, i + 1);
    if (!leaf) {
      skipped += 1;
      continue;
    }
    const projectId = await resolveOrCreateProject(leaf.project, section, log, {
      workbook,
      sheet: sheet.name,
      rowNumber: leaf.rowNumber,
    });
    const disciplineId = await disciplineIdFor(leaf.discipline);
    if (leaf.discipline && !disciplineId) {
      log.warn('DISCIPLINE_UNMATCHED', `Unrecognised discipline "${leaf.discipline}"`, {
        workbook,
        sheet: sheet.name,
        rowNumber: leaf.rowNumber,
      });
    }
    const phaseId = leaf.phase ? await upsertPhase(projectId, leaf.phase) : null;
    const leadId = await userIdForPersonName(leaf.lead);
    const projectCode = await projectCodeOf(projectId);

    let anyQuarter = false;
    for (let q = 1; q <= 4; q += 1) {
      const qty = int(cellAt(row, pkgsQ[q - 1])) ?? 0;
      const value = num(cellAt(row, billingQ[q - 1])) ?? 0;
      if (qty === 0 && value === 0) continue;
      anyQuarter = true;
      const period = calendarQuarter(year, q);
      const goalCode = goalCodeFor({
        projectCode,
        phase: leaf.phase,
        discipline: leaf.discipline,
        lead: leaf.lead,
        description: leaf.description,
        fiscalYear: period.label,
        quarter: q,
      });
      const res = await upsertGoal(goalCode, {
        projectId,
        phaseId,
        disciplineId,
        designLeadId: leadId,
        goalDescription: leaf.description,
        fiscalYear: period.label,
        quarter: q,
        periodStart: period.start,
        periodEnd: period.end,
        plannedQuantity: qty,
        plannedValue: round2(value),
        remarks: remarkOf(row),
        sourceSheet: sheet.name,
        sourceRow: leaf.rowNumber,
      });
      if (res.created) created += 1;
      else updated += 1;
    }
    if (!anyQuarter) {
      // A goal line with a total but no quarter allocation: keep it, attributed
      // to the year rather than dropped.
      const totalQty = int(cellAt(row, pkgsTotalCol)) ?? 0;
      const totalValue = num(cellAt(row, billingTotalCol)) ?? 0;
      if (totalQty === 0 && totalValue === 0) {
        skipped += 1;
        continue;
      }
      const period = calendarQuarter(year, 4);
      const goalCode = goalCodeFor({
        projectCode,
        phase: leaf.phase,
        discipline: leaf.discipline,
        lead: leaf.lead,
        description: leaf.description,
        fiscalYear: period.label,
        quarter: 4,
      });
      const res = await upsertGoal(goalCode, {
        projectId,
        phaseId,
        disciplineId,
        designLeadId: leadId,
        goalDescription: leaf.description,
        fiscalYear: period.label,
        quarter: 4,
        periodStart: period.start,
        periodEnd: period.end,
        plannedQuantity: totalQty,
        plannedValue: round2(totalValue),
        remarks: remarkOf(row),
        sourceSheet: sheet.name,
        sourceRow: leaf.rowNumber,
      });
      if (res.created) created += 1;
      else updated += 1;
      log.info('GOAL_NO_QUARTER_SPLIT', `Goal row has a year total but no quarter split; attributed to ${period.label} Q4`, {
        workbook,
        sheet: sheet.name,
        rowNumber: leaf.rowNumber,
      });
    }
  }
  log.count('goalsCreated', created);
  log.count('goalsUpdated', updated);
  log.info('CALENDAR_GOALS', `${created} created, ${updated} updated, ${skipped} non-leaf rows skipped`, {
    workbook,
    sheet: sheet.name,
  });
}

// ---------------------------------------------------------------------------
// 3. Fiscal-quarter goal sheets
// ---------------------------------------------------------------------------

export interface FiscalGoalSheetOptions {
  fyStartYear: number;
  quarter: number;
  /** Revised-plan sheets update an existing goal and record a revision. */
  revision?: { reason: string };
}

export async function importFiscalGoals(
  sheet: SheetData,
  log: ImportLogger,
  workbook: string,
  opts: FiscalGoalSheetOptions,
) {
  const headerIdx = findHeaderRow(sheet.rows, GOAL_HEADER);
  if (headerIdx < 0) {
    log.error('HEADER_NOT_FOUND', 'Could not locate the goal header row', { workbook, sheet: sheet.name });
    return;
  }
  const planValueCol = findColumn(sheet.rows, 'Plan - Billing [Cr.]', headerIdx + 1);
  const planQtyCol = findColumn(sheet.rows, 'Plan - Pkgs', headerIdx + 1);
  const actualValueCol = findColumn(sheet.rows, 'Actuals - Billing [Cr.]', headerIdx + 1);
  const actualQtyCol = findColumn(sheet.rows, 'Actuals - Pkgs', headerIdx + 1);
  if (planValueCol < 0 || planQtyCol < 0) {
    log.error('PLAN_COLUMNS_NOT_FOUND', 'Plan billing/packages columns not found', { workbook, sheet: sheet.name });
    return;
  }
  const period = fiscalQuarter(opts.fyStartYear, opts.quarter);

  let created = 0;
  let updated = 0;
  let revisions = 0;
  let skipped = 0;
  let section = 'Ongoing';

  for (let i = headerIdx + 1; i < sheet.rows.length; i += 1) {
    const row = sheet.rows[i];
    const header = sectionHeaderOf(row);
    if (header) section = header;
    const leaf = readLeaf(row, i + 1);
    if (!leaf) {
      skipped += 1;
      continue;
    }
    const projectId = await resolveOrCreateProject(leaf.project, section, log, {
      workbook,
      sheet: sheet.name,
      rowNumber: leaf.rowNumber,
    });
    const disciplineId = await disciplineIdFor(leaf.discipline);
    const phaseId = leaf.phase ? await upsertPhase(projectId, leaf.phase) : null;
    const leadId = await userIdForPersonName(leaf.lead);
    const projectCode = await projectCodeOf(projectId);

    const plannedQuantity = int(cellAt(row, planQtyCol)) ?? 0;
    const plannedValue = round2(num(cellAt(row, planValueCol)) ?? 0);
    const reportedActualQuantity = actualQtyCol >= 0 ? int(cellAt(row, actualQtyCol)) ?? 0 : 0;
    const reportedActualValue = actualValueCol >= 0 ? round2(num(cellAt(row, actualValueCol)) ?? 0) : 0;

    const goalCode = goalCodeFor({
      projectCode,
      phase: leaf.phase,
      discipline: leaf.discipline,
      lead: leaf.lead,
      description: leaf.description,
      fiscalYear: period.label,
      quarter: opts.quarter,
    });

    if (opts.revision) {
      const [existing] = await db.select().from(goalsTable).where(eq(goalsTable.goalCode, goalCode)).limit(1);
      if (existing) {
        const qtyChanged = existing.plannedQuantity !== plannedQuantity;
        const valChanged = Math.abs(existing.plannedValue - plannedValue) > 0.005;
        if (qtyChanged || valChanged) {
          await addGoalRevision({
            goalId: existing.id,
            previousTargetQuantity: existing.plannedQuantity,
            newTargetQuantity: plannedQuantity,
            previousTargetValue: existing.plannedValue,
            newTargetValue: plannedValue,
            reason: opts.revision.reason,
            impactSummary: `Revised plan: quantity ${existing.plannedQuantity} → ${plannedQuantity}, value ${existing.plannedValue} → ${plannedValue} Cr.`,
          });
          revisions += 1;
        }
      }
    }

    const res = await upsertGoal(goalCode, {
      projectId,
      phaseId,
      disciplineId,
      designLeadId: leadId,
      goalDescription: leaf.description,
      fiscalYear: period.label,
      quarter: opts.quarter,
      periodStart: period.start,
      periodEnd: period.end,
      plannedQuantity,
      plannedValue,
      reportedActualQuantity,
      reportedActualValue,
      remarks: remarkOf(row),
      sourceSheet: sheet.name,
      sourceRow: leaf.rowNumber,
      isBaselineRevision: Boolean(opts.revision),
    });
    if (res.created) created += 1;
    else updated += 1;

    const team = TEAM_COLUMNS.map((tc) => ({ name: text(cellAt(row, col(tc.column))) ?? '', role: tc.role })).filter(
      (m) => m.name.length > 1,
    );
    if (team.length) await replaceTeam(res.id, team);
  }
  log.count('goalsCreated', created);
  log.count('goalsUpdated', updated);
  log.count('goalRevisions', revisions);
  log.info(
    'FISCAL_GOALS',
    `${period.label} Q${opts.quarter}: ${created} created, ${updated} updated, ${revisions} revisions, ${skipped} non-leaf rows skipped`,
    { workbook, sheet: sheet.name },
  );
}

// ---------------------------------------------------------------------------
// 4. Actuals sheet (calendar Q1)
// ---------------------------------------------------------------------------

export async function importCalendarActuals(
  sheet: SheetData,
  log: ImportLogger,
  workbook: string,
  year: number,
  quarter: number,
  opts: { withRemarks?: boolean } = {},
) {
  const headerIdx = findHeaderRow(sheet.rows, GOAL_HEADER);
  if (headerIdx < 0) {
    log.error('HEADER_NOT_FOUND', 'Could not locate the goal header row', { workbook, sheet: sheet.name });
    return;
  }
  // Row 1 carries the "Plan 26Q1" / "Actual 26Q1" group labels; the row below
  // holds the Billing/Pkgs pair under each.
  const yy = String(year).slice(2);
  const planGroup = findColumn(sheet.rows, `Plan ${yy}Q${quarter}`, headerIdx);
  const actualGroup = findColumn(sheet.rows, `Actual ${yy}Q${quarter}`, headerIdx);
  if (planGroup < 0 || actualGroup < 0) {
    log.error('ACTUALS_COLUMNS_NOT_FOUND', 'Plan/Actual group headers not found', { workbook, sheet: sheet.name });
    return;
  }
  const period = calendarQuarter(year, quarter);
  let matched = 0;
  let createdFromActuals = 0;
  let remarksApplied = 0;
  let section = 'Ongoing';
  let lastGoalId: string | null = null;
  let lastRemarkLines: string[] = [];

  const flushRemarks = async () => {
    if (!lastGoalId || lastRemarkLines.length === 0) return;
    const joined = lastRemarkLines.join('; ');
    const [g] = await db.select().from(goalsTable).where(eq(goalsTable.id, lastGoalId)).limit(1);
    if (g) {
      const merged = g.remarks && !g.remarks.includes(joined) ? `${g.remarks}; ${joined}` : joined;
      await db.update(goalsTable).set({ remarks: merged, updatedAt: new Date() }).where(eq(goalsTable.id, lastGoalId));
      remarksApplied += 1;
    }
    lastRemarkLines = [];
  };

  for (let i = headerIdx + 1; i < sheet.rows.length; i += 1) {
    const row = sheet.rows[i];
    const header = sectionHeaderOf(row);
    if (header) section = header;
    const leaf = readLeaf(row, i + 1);
    if (!leaf) {
      // In the "(Remark)" variant a row carrying only a Description is a
      // sub-item note belonging to the goal above it.
      if (opts.withRemarks) {
        const onlyDescription =
          text(cellAt(row, col('F'))) &&
          !text(cellAt(row, col('B'))) &&
          !text(cellAt(row, col('C'))) &&
          !text(cellAt(row, col('E')));
        if (onlyDescription) lastRemarkLines.push(text(cellAt(row, col('F')))!);
      }
      continue;
    }
    await flushRemarks();

    const projectId = await resolveOrCreateProject(leaf.project, section, log, {
      workbook,
      sheet: sheet.name,
      rowNumber: leaf.rowNumber,
    });
    const projectCode = await projectCodeOf(projectId);
    const goalCode = goalCodeFor({
      projectCode,
      phase: leaf.phase,
      discipline: leaf.discipline,
      lead: leaf.lead,
      description: leaf.description,
      fiscalYear: period.label,
      quarter,
    });
    const planValue = round2(num(cellAt(row, planGroup)) ?? 0);
    const planQty = int(cellAt(row, planGroup + 1)) ?? 0;
    const actualValue = round2(num(cellAt(row, actualGroup)) ?? 0);
    const actualQty = int(cellAt(row, actualGroup + 1)) ?? 0;

    const [existing] = await db.select().from(goalsTable).where(eq(goalsTable.goalCode, goalCode)).limit(1);
    if (!existing) {
      // Keep the row rather than discarding it: the actuals sheet also carries
      // the plan figures, so a complete goal record can be created here.
      const res = await upsertGoal(goalCode, {
        projectId,
        phaseId: leaf.phase ? await upsertPhase(projectId, leaf.phase) : null,
        disciplineId: await disciplineIdFor(leaf.discipline),
        designLeadId: await userIdForPersonName(leaf.lead),
        goalDescription: leaf.description,
        fiscalYear: period.label,
        quarter,
        periodStart: period.start,
        periodEnd: period.end,
        plannedQuantity: planQty,
        plannedValue: planValue,
        reportedActualQuantity: actualQty,
        reportedActualValue: actualValue,
        sourceSheet: sheet.name,
        sourceRow: leaf.rowNumber,
      });
      createdFromActuals += 1;
      log.info(
        'GOAL_CREATED_FROM_ACTUALS',
        `No matching plan row for this actuals line; goal created from the actuals sheet (plan ${planQty} pkgs / ${planValue} Cr.)`,
        { workbook, sheet: sheet.name, rowNumber: leaf.rowNumber },
      );
      lastGoalId = res.id;
      continue;
    }

    const completed = existing.plannedQuantity > 0 && actualQty >= existing.plannedQuantity;
    await db
      .update(goalsTable)
      .set({
        reportedActualQuantity: actualQty,
        reportedActualValue: actualValue,
        completionStatus: completed ? 'COMPLETED' : 'NOT_COMPLETED',
        actualCompletionDate: completed ? existing.actualCompletionDate ?? period.end : null,
        updatedAt: new Date(),
      })
      .where(eq(goalsTable.id, existing.id));
    matched += 1;
    lastGoalId = existing.id;
  }
  await flushRemarks();

  log.count('goalActualsApplied', matched);
  log.count('goalsCreatedFromActuals', createdFromActuals);
  log.count('goalRemarksEnriched', remarksApplied);
  log.info(
    'CALENDAR_ACTUALS',
    `${matched} goals updated with actuals, ${createdFromActuals} created from the actuals sheet, ${remarksApplied} enriched with sub-item remarks`,
    { workbook, sheet: sheet.name },
  );
}

// ---------------------------------------------------------------------------
// 5. Interior-design unit register — real dated deliverables
// ---------------------------------------------------------------------------

export async function importIdUnitRegister(sheet: SheetData, log: ImportLogger, workbook: string) {
  const header = sheet.rows[1] ?? [];
  const idx = (label: string) => {
    for (let c = 0; c < header.length; c += 1) {
      const v = text(header[c]);
      if (v && v.toLowerCase() === label.toLowerCase()) return c;
    }
    return -1;
  };
  const cProject = idx('Project');
  const cPhase = idx('Phase');
  const cUnit = idx('Unit no');
  const cProduct = idx('Product');
  const cArchitect = idx('Architect');
  const cSignoff = idx('Signoff Quarter');
  const cGfc = idx('GFC Target');
  const cStatus = idx('Status');
  const cRemarks = idx('Remarks');
  if (cProject < 0 || cUnit < 0 || cGfc < 0) {
    log.warn('ID_REGISTER_HEADER', 'Interior-design unit register header not recognised; sheet skipped', {
      workbook,
      sheet: sheet.name,
    });
    return;
  }
  const disciplineId = await disciplineIdFor('Interior Design');
  let created = 0;
  let updated = 0;
  let skippedNoDate = 0;

  for (let i = 2; i < sheet.rows.length; i += 1) {
    const row = sheet.rows[i];
    const projectLabel = text(cellAt(row, cProject));
    const unit = text(cellAt(row, cUnit));
    if (!projectLabel || !unit) continue;
    const projectId = await matchProject(projectLabel);
    if (!projectId) {
      log.warn('ID_UNIT_PROJECT_UNMATCHED', `Unit register references unknown project "${projectLabel}"`, {
        workbook,
        sheet: sheet.name,
        rowNumber: i + 1,
      });
      continue;
    }
    const gfc = date(cellAt(row, cGfc));
    const signoff = date(cellAt(row, cSignoff));
    const baseline = gfc ?? signoff;
    if (!baseline) {
      skippedNoDate += 1;
      log.warn('ID_UNIT_NO_DATE', `Unit ${projectLabel} ${unit} has no GFC target or signoff date`, {
        workbook,
        sheet: sheet.name,
        rowNumber: i + 1,
      });
      continue;
    }
    const phaseLabel = text(cellAt(row, cPhase));
    const phaseId = phaseLabel ? await upsertPhase(projectId, phaseLabel) : null;
    const product = text(cellAt(row, cProduct));
    const status = cStatus >= 0 ? text(cellAt(row, cStatus)) : null;
    const completed = Boolean(status && /^(released|issued|complete|completed|done)$/i.test(status));
    const projectCode = await projectCodeOf(projectId);
    const code = `D-${projectCode}-ID-${codeify(unit, 12)}-${hash6(projectLabel, phaseLabel, unit, product)}`;
    const res = await upsertDeliverable(code, {
      projectId,
      phaseId,
      disciplineId,
      deliverableDescription: `Interior design GFC — Unit ${unit}${product ? ` (${product})` : ''}`,
      baselineReleaseDate: baseline,
      actualReleaseDate: completed ? baseline : null,
      completionStatus: completed ? 'COMPLETED' : 'NOT_COMPLETED',
      ownerId: cArchitect >= 0 ? await userIdForPersonName(text(cellAt(row, cArchitect))) : null,
      remarks: cRemarks >= 0 ? text(cellAt(row, cRemarks)) : null,
      sourceSheet: sheet.name,
    });
    if (res.created) created += 1;
    else updated += 1;
  }
  log.count('deliverablesCreated', created);
  log.count('deliverablesUpdated', updated);
  log.info(
    'ID_UNIT_REGISTER',
    `${created} created, ${updated} updated, ${skippedNoDate} rows without a usable date`,
    { workbook, sheet: sheet.name },
  );
}

// ---------------------------------------------------------------------------
// Orchestration for this workbook
// ---------------------------------------------------------------------------

export function classifySheet(name: string): 'MASTER' | 'DERIVED' | 'LEADER_VIEW' | 'UNKNOWN' {
  // DERIVED first: "26Q1 Actuals Smry" also matches the leader-sheet shape.
  if (DERIVED_SHEET_PATTERNS.some((r) => r.test(name))) return 'DERIVED';
  if (LEADER_SHEET_PATTERNS.some((r) => r.test(name))) return 'LEADER_VIEW';
  if (
    /^Prj List$/i.test(name) ||
    /^Prj Crtcl rqrmnt$/i.test(name) ||
    /^Notes$/i.test(name) ||
    /^Goals \d{4}$/i.test(name) ||
    /^Goals FY 26-27Q[12]$/i.test(name) ||
    /^Goals FY 2026Q2 \(Revised Plan\)$/i.test(name) ||
    /^Goals, Actuals \d{4} Q\d/i.test(name) ||
    /^ID Goals FY 26-27Q2$/i.test(name)
  ) {
    return 'MASTER';
  }
  return 'UNKNOWN';
}

async function projectCodeOf(projectId: string): Promise<string> {
  const [row] = await db.select({ code: projectsTable.projectCode }).from(projectsTable).where(eq(projectsTable.id, projectId)).limit(1);
  return row?.code ?? projectId;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function importGoalsWorkbook(wb: WorkbookData, log: ImportLogger) {
  const workbook = wb.fileName;
  clearProjectMatchCache();

  const order: { match: RegExp; run: (s: SheetData) => Promise<void> }[] = [
    // Order matters: the project master list first, then the goal sheets (which
    // may introduce delivery scopes of their own), then the sheets that only
    // annotate existing projects.
    { match: /^Prj List$/i, run: (s) => importProjectList(s, log, workbook) },
    { match: /^Goals 2026$/i, run: (s) => importCalendarGoals(s, log, workbook, 2026) },
    {
      match: /^Goals FY 26-27Q1$/i,
      run: (s) => importFiscalGoals(s, log, workbook, { fyStartYear: 2026, quarter: 1 }),
    },
    {
      match: /^Goals FY 26-27Q2$/i,
      run: (s) => importFiscalGoals(s, log, workbook, { fyStartYear: 2026, quarter: 2 }),
    },
    {
      match: /^Goals FY 2026Q2 \(Revised Plan\)$/i,
      run: (s) =>
        importFiscalGoals(s, log, workbook, {
          fyStartYear: 2026,
          quarter: 1,
          revision: { reason: 'Revised plan issued in the FY26-27 goals workbook' },
        }),
    },
    { match: /^Goals, Actuals 2026 Q1$/i, run: (s) => importCalendarActuals(s, log, workbook, 2026, 1) },
    {
      match: /^Goals, Actuals 2026 Q1 \(Remark\)$/i,
      run: (s) => importCalendarActuals(s, log, workbook, 2026, 1, { withRemarks: true }),
    },
    { match: /^ID Goals FY 26-27Q2$/i, run: (s) => importIdUnitRegister(s, log, workbook) },
    { match: /^Prj Crtcl rqrmnt$/i, run: (s) => importCriticalRequirements(s, log, workbook) },
    { match: /^Notes$/i, run: (s) => importNotes(s, log, workbook) },
  ];


  const handled = new Set<string>();
  for (const step of order) {
    for (const sheet of wb.sheets) {
      if (step.match.test(sheet.name)) {
        handled.add(sheet.name);
        await step.run(sheet);
      }
    }
  }

  for (const sheet of wb.sheets) {
    if (handled.has(sheet.name)) continue;
    const kind = classifySheet(sheet.name);
    const nonEmpty = sheet.rows.filter((r) => r.some((c) => c != null && String(c).trim() !== '')).length;
    if (kind === 'LEADER_VIEW') {
      log.info(
        'SHEET_SKIPPED_LEADER_VIEW',
        `"${sheet.name}" is a per-design-lead copy of the master goal rows (${nonEmpty} rows). Not imported — reproduced in the app as a Design Lead filter.`,
        { workbook, sheet: sheet.name },
      );
      log.count('sheetsSkippedLeaderView');
    } else if (kind === 'DERIVED') {
      log.info(
        'SHEET_SKIPPED_DERIVED',
        `"${sheet.name}" is a summary/pivot recomputed by the dashboard (${nonEmpty} rows). Not imported.`,
        { workbook, sheet: sheet.name },
      );
      log.count('sheetsSkippedDerived');
    } else {
      log.warn(
        'SHEET_UNCLASSIFIED',
        `"${sheet.name}" was not recognised (${nonEmpty} non-empty rows). Review before relying on it.`,
        { workbook, sheet: sheet.name },
      );
      log.count('sheetsUnclassified');
    }
  }
}
