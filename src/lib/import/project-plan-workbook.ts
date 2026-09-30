/**
 * Mapper for a project delivery-plan workbook — the Violet Hill
 * "0118_Violet Hill_ 03YPlan…xlsx" is the reference shape.
 *
 * Nothing here is Violet-Hill-specific. The project is identified from the
 * workbook's own header cell / file name and then treated as one Project row
 * like any other (spec §28, §29).
 *
 *   Design Fee            → packages + per-discipline fee weighting
 *   Packages deliverables → package durations + the deliverable list per
 *                           discipline for each batch
 *   Drawing list | *      → the drawing register, with planned quarter,
 *                           actual issue quarter and date of receipt
 *   Assumption Cost /
 *   BOQ cost              → commercial assumptions, captured as project
 *                           settings (not modelled as delivery records)
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '@/db';
import { appSettings, drawings as drawingsTable, packages as packagesTable, projects as projectsTable } from '@/db/schema';
import { codeify } from '@/lib/ids';
import { addDays, calendarQuarter, endOfDay, utc } from '@/lib/periods';
import {
  cellAt,
  col,
  date,
  int,
  num,
  text,
  type Row,
  type SheetData,
  type WorkbookData,
} from './workbook';
import type { ImportLogger } from './logger';
import {
  disciplineIdFor,
  findPackageByName,
  hash6,
  normaliseName,
  upsertDeliverable,
  upsertDependency,
  upsertDrawing,
  upsertPackage,
  upsertPackageFee,
  upsertPhase,
  upsertProject,
} from './upsert';
import { matchProject } from './goals-workbook';

interface PlanContext {
  projectId: string;
  projectCode: string;
  projectName: string;
  phaseId: string | null;
  planStart: Date;
  workbook: string;
}

const FEE_DISCIPLINE_COLUMNS = [
  { pct: 'E', val: 'F', discipline: 'AR' },
  { pct: 'G', val: 'H', discipline: 'ST' },
  { pct: 'I', val: 'J', discipline: 'MEP' },
  { pct: 'K', val: 'L', discipline: 'LS' },
];

const DELIVERABLE_DISCIPLINE_COLUMNS = [
  { name: 'D', status: 'E', discipline: 'Master Planning' },
  { name: 'F', status: 'G', discipline: 'Infra Consultants' },
  { name: 'H', status: 'I', discipline: 'PHE' },
  { name: 'J', status: 'K', discipline: 'ELE' },
  { name: 'L', status: 'M', discipline: 'IBMS' },
  { name: 'N', status: 'O', discipline: 'Structural' },
  { name: 'P', status: 'Q', discipline: 'Landscape' },
];

const PACKAGE_CODE_RE = /^([A-Z]{2})\s?(\d{2})$/;
const BATCH_RE = /^Batch\s*(\d{1,2})$/i;

// ---------------------------------------------------------------------------
// Project identity
// ---------------------------------------------------------------------------

/** "0118_Violet Hill_ 03YPlan_01012026 - Ph 1 trail.xlsx" → code + name + start */
export function parsePlanFileName(fileName: string): {
  projectNumber: string | null;
  projectName: string | null;
  planStart: Date | null;
  phaseLabel: string | null;
} {
  const base = fileName.replace(/\.xlsx?$/i, '');
  const numMatch = /^(\d{3,5})[_\s-]+/.exec(base);
  const projectNumber = numMatch ? numMatch[1] : null;
  const rest = numMatch ? base.slice(numMatch[0].length) : base;
  const nameMatch = /^([^_]+)/.exec(rest);
  const projectName = nameMatch ? nameMatch[1].trim().replace(/\s+/g, ' ') : null;
  const dateMatch = /_(\d{8})/.exec(base);
  let planStart: Date | null = null;
  if (dateMatch) {
    const s = dateMatch[1];
    const a = Number(s.slice(0, 2));
    const b = Number(s.slice(2, 4));
    const y = Number(s.slice(4));
    // Both orderings agree for 01/01; prefer dd-mm which is how the source
    // workbook titles are written.
    const day = a <= 31 ? a : b;
    const month = a <= 12 && b > 12 ? a : b <= 12 ? b : 1;
    planStart = utc(y, month, day);
  }
  const phaseMatch = /-\s*(Ph[^-]*?)(?:\s+tr?ail|\s+trial)?$/i.exec(base);
  return {
    projectNumber,
    projectName,
    planStart,
    phaseLabel: phaseMatch ? phaseMatch[1].trim() : null,
  };
}

async function resolveProject(wb: WorkbookData, log: ImportLogger): Promise<PlanContext | null> {
  const parsed = parsePlanFileName(wb.fileName);
  // The drawing-list sheets carry the authoritative project header, e.g.
  // "0118 Violet Hill" in cell B1.
  let headerName: string | null = null;
  for (const sheet of wb.sheets) {
    if (!/^Drawing list/i.test(sheet.name)) continue;
    const b1 = text(cellAt(sheet.rows[0], col('B')));
    if (b1) {
      headerName = b1.replace(/^\d{3,5}\s+/, '').trim();
      break;
    }
  }
  const name = headerName ?? parsed.projectName;
  if (!name) {
    log.error('PLAN_PROJECT_UNKNOWN', `Could not determine the project for ${wb.fileName}`, {
      workbook: wb.fileName,
    });
    return null;
  }
  let projectId = await matchProject(name);
  if (!projectId) {
    projectId = await upsertProject({
      name,
      portfolio: 'New Projects',
      description: parsed.projectNumber ? `Project no. ${parsed.projectNumber}` : null,
    });
    log.info('PLAN_PROJECT_CREATED', `Project "${name}" was not in the goals master list; created from the plan workbook`, {
      workbook: wb.fileName,
    });
  } else if (parsed.projectNumber) {
    await db
      .update(projectsTable)
      .set({ description: `Project no. ${parsed.projectNumber}`, updatedAt: new Date() })
      .where(eq(projectsTable.id, projectId));
  }
  const [proj] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).limit(1);
  const phaseId = parsed.phaseLabel ? await upsertPhase(projectId, parsed.phaseLabel, 10) : null;
  const planStart =
    (process.env.PLAN_START_DATE ? date(process.env.PLAN_START_DATE) : null) ??
    parsed.planStart ??
    utc(new Date().getUTCFullYear(), 1, 1);
  return {
    projectId,
    projectCode: proj?.projectCode ?? codeify(name),
    projectName: proj?.projectName ?? name,
    phaseId,
    planStart,
    workbook: wb.fileName,
  };
}

// ---------------------------------------------------------------------------
// 1. Design Fee → packages + fee weighting
// ---------------------------------------------------------------------------

export async function importDesignFee(sheet: SheetData, ctx: PlanContext, log: ImportLogger) {
  let group: string | null = null;
  let sequence = 0;
  let packagesCount = 0;
  let feeRows = 0;

  for (let i = 0; i < sheet.rows.length; i += 1) {
    const row = sheet.rows[i];
    const b = text(cellAt(row, col('B')));
    const c = text(cellAt(row, col('C')));
    const d = text(cellAt(row, col('D')));
    if (!c) continue;

    // Group heading rows: a stage name in C with nothing in D.
    if (!d && /^[A-Z][A-Z\s&-]+$/.test(c) && !PACKAGE_CODE_RE.test(c)) {
      group = c;
      continue;
    }
    // Stage rollup rows carry a numeric index in B ("2 | MP | Master Plan").
    const isStageRollup = b != null && /^\d+$/.test(b);
    if (isStageRollup && c.length <= 3) {
      if (/^(DESIGN CONCEPT|CONSTRUCTION DOCUMENTS|POST-CONSTRUCTION)$/i.test(d ?? '')) group = d!;
      // A stage with no sub-packages (e.g. "MA — Master Archives") is itself a
      // package; detected by looking ahead for a "<code> NN" row.
      const next = sheet.rows[i + 1];
      const nextCode = text(cellAt(next, col('C')));
      if (nextCode && PACKAGE_CODE_RE.test(nextCode) && nextCode.startsWith(c)) continue;
    }
    const isPackage = PACKAGE_CODE_RE.test(c) || (isStageRollup && c.length <= 3);
    if (!isPackage || !d) continue;

    sequence += 10;
    const packageId = await upsertPackage({
      projectId: ctx.projectId,
      phaseId: ctx.phaseId,
      packageCode: c,
      packageName: d,
      packageGroup: group,
      sequence,
    });
    packagesCount += 1;

    for (const fc of FEE_DISCIPLINE_COLUMNS) {
      const pct = num(cellAt(row, col(fc.pct)));
      const val = num(cellAt(row, col(fc.val)));
      if (pct == null && val == null) continue;
      const disciplineId = await disciplineIdFor(fc.discipline);
      if (!disciplineId) continue;
      await upsertPackageFee(packageId, disciplineId, pct, val);
      feeRows += 1;
    }
  }
  log.count('packages', packagesCount);
  log.count('packageFees', feeRows);
  log.info('DESIGN_FEE', `${packagesCount} packages and ${feeRows} fee weightings imported`, {
    workbook: ctx.workbook,
    sheet: sheet.name,
  });
}

// ---------------------------------------------------------------------------
// 2. Packages deliverables → durations + deliverable list
// ---------------------------------------------------------------------------

interface BatchRef {
  batchNo: number;
  batchLabel: string;
  description: string;
  durationDays: number | null;
  packageId: string;
}

export async function importPackagesDeliverables(sheet: SheetData, ctx: PlanContext, log: ImportLogger) {
  const batches: BatchRef[] = [];
  let current: BatchRef | null = null;
  let deliverablesCreated = 0;
  let deliverablesUpdated = 0;
  let orphanDeliverables = 0;
  let sequence = 0;
  let currentGroup: string | null = null;
  void currentGroup;

  // Rows 1-2 are the two-tier discipline header; data starts at row 3.
  const DISCIPLINE_LABELS = new Set(
    DELIVERABLE_DISCIPLINE_COLUMNS.map((d) => d.discipline.toUpperCase()).concat(['MEP', 'RELEASED STATUS']),
  );
  for (let i = 2; i < sheet.rows.length; i += 1) {
    const row = sheet.rows[i];
    const b = text(cellAt(row, col('B')));
    const batchMatch = b ? BATCH_RE.exec(b) : null;

    if (batchMatch) {
      const description = text(cellAt(row, col('C'))) ?? b!;
      // Column A holds the planned duration in days; "15 -Std" appears once.
      const durationRaw = text(cellAt(row, col('A')));
      const durationDays = durationRaw ? int(durationRaw.replace(/[^\d.-]/g, '')) : null;
      sequence += 10;
      // Prefer the package already created from Design Fee with the same
      // description ("Batch 01 — Infra - Grading" is "MP 01 — Infra - Grading").
      const matchedId = await findPackageByName(ctx.projectId, description);
      let packageId: string;
      if (matchedId) {
        packageId = matchedId;
        await db
          .update(packagesTable)
          .set({ durationDays, updatedAt: new Date() })
          .where(eq(packagesTable.id, matchedId));
      } else {
        packageId = await upsertPackage({
          projectId: ctx.projectId,
          phaseId: ctx.phaseId,
          packageCode: b!.replace(/\s+/g, ' '),
          packageName: description,
          packageGroup: 'CONSTRUCTION DOCUMENTS',
          sequence: 500 + sequence,
          durationDays,
        });
        log.info('BATCH_PACKAGE_CREATED', `Batch "${b}" had no Design Fee package with the same description; created "${b}"`, {
          workbook: ctx.workbook,
          sheet: sheet.name,
          rowNumber: i + 1,
        });
      }
      current = {
        batchNo: Number(batchMatch[1]),
        batchLabel: b!.replace(/\s+/g, ' '),
        description,
        durationDays,
        packageId,
      };
      batches.push(current);
      continue;
    }

    // Section headings in column B without a batch number. Two kinds exist:
    //   "Construction Documents"        → a group marker; the batches follow
    //   "Master Planning - Schematic"   → a stage that owns deliverables of
    //                                     its own, so it becomes a package
    // They are told apart by looking ahead: if deliverable cells appear before
    // the next heading, the heading is a package.
    if (b && !batchMatch) {
      const hasDeliverableCells = DELIVERABLE_DISCIPLINE_COLUMNS.some((dc) => text(cellAt(row, col(dc.name))));
      if (!hasDeliverableCells) {
        const owns = sectionOwnsDeliverables(sheet.rows, i);
        if (owns) {
          sequence += 10;
          const matchedId = await findPackageByName(ctx.projectId, b);
          const packageId =
            matchedId ??
            (await upsertPackage({
              projectId: ctx.projectId,
              phaseId: ctx.phaseId,
              packageCode: b,
              packageName: b,
              packageGroup: 'DESIGN CONCEPT',
              sequence,
            }));
          current = {
            batchNo: 0,
            batchLabel: b,
            description: b,
            durationDays: null,
            packageId,
          };
          log.info('SECTION_PACKAGE', `Stage section "${b}" owns deliverables directly; mapped to a package`, {
            workbook: ctx.workbook,
            sheet: sheet.name,
            rowNumber: i + 1,
          });
          continue;
        }
        currentGroup = b;
        current = null;
        continue;
      }
    }

    for (const dc of DELIVERABLE_DISCIPLINE_COLUMNS) {
      const name = text(cellAt(row, col(dc.name)));
      if (!name) continue;
      if (DISCIPLINE_LABELS.has(name.toUpperCase())) continue;
      const status = text(cellAt(row, col(dc.status)));
      const disciplineId = await disciplineIdFor(dc.discipline);
      if (!current) {
        orphanDeliverables += 1;
        log.warn(
          'DELIVERABLE_NO_BATCH',
          `Deliverable "${name}" (${dc.discipline}) sits outside any batch block and was attached to the project without a package`,
          { workbook: ctx.workbook, sheet: sheet.name, rowNumber: i + 1 },
        );
      }
      const completed = Boolean(status && /^(released|issued|yes|y|complete|completed|done|1)$/i.test(status));
      const code = `D-${ctx.projectCode}-${current ? (current.batchNo > 0 ? `B${String(current.batchNo).padStart(2, '0')}` : `S${hash6(current.batchLabel)}`) : 'NOBATCH'}-${
        (await disciplineCode(dc.discipline)) ?? 'GEN'
      }-${hash6(name)}`;
      const res = await upsertDeliverable(code, {
        projectId: ctx.projectId,
        phaseId: ctx.phaseId,
        packageId: current?.packageId ?? null,
        disciplineId,
        deliverableDescription: name,
        // Placeholder; replaced by the package schedule pass below.
        baselineReleaseDate: ctx.planStart,
        completionStatus: completed ? 'COMPLETED' : 'NOT_COMPLETED',
        remarks: status && !completed ? `Released status in source: ${status}` : null,
        sourceSheet: sheet.name,
      });
      if (res.created) deliverablesCreated += 1;
      else deliverablesUpdated += 1;
    }
  }

  log.count('deliverablesCreated', deliverablesCreated);
  log.count('deliverablesUpdated', deliverablesUpdated);
  log.info(
    'PACKAGES_DELIVERABLES',
    `${batches.length} batches, ${deliverablesCreated} deliverables created, ${deliverablesUpdated} updated, ${orphanDeliverables} outside a batch`,
    { workbook: ctx.workbook, sheet: sheet.name },
  );
  return batches;
}

/** Does this column-B heading own deliverable rows before the next heading? */
function sectionOwnsDeliverables(rows: Row[], headingIndex: number): boolean {
  for (let i = headingIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    const b = text(cellAt(row, col('B')));
    const hasDeliverableCells = DELIVERABLE_DISCIPLINE_COLUMNS.some((dc) => text(cellAt(row, col(dc.name))));
    if (hasDeliverableCells) return true;
    if (b) return false; // reached the next heading with nothing in between
  }
  return false;
}

const disciplineCodeCache = new Map<string, string | null>();
async function disciplineCode(name: string): Promise<string | null> {
  if (disciplineCodeCache.has(name)) return disciplineCodeCache.get(name)!;
  const { canonicalDisciplineCode } = await import('@/lib/seed');
  const code = canonicalDisciplineCode(name);
  disciplineCodeCache.set(name, code);
  return code;
}

// ---------------------------------------------------------------------------
// 3. Drawing registers
// ---------------------------------------------------------------------------

interface QuarterBlocks {
  plan: { year: number; cols: number[] }[];
  actual: { year: number; cols: number[] }[];
}

/** Row 1 carries P26 / A26 / P27 / A27 block markers. */
export function locateQuarterBlocks(rows: Row[]): QuarterBlocks {
  const header = rows[0] ?? [];
  const plan: QuarterBlocks['plan'] = [];
  const actual: QuarterBlocks['actual'] = [];
  for (let c = 0; c < header.length; c += 1) {
    const v = text(header[c]);
    if (!v) continue;
    const m = /^([PA])(\d{2})$/.exec(v);
    if (!m) continue;
    const year = 2000 + Number(m[2]);
    const cols = [c + 1, c + 2, c + 3, c + 4];
    if (m[1] === 'P') plan.push({ year, cols });
    else actual.push({ year, cols });
  }
  return { plan, actual };
}

function firstFlaggedQuarter(row: Row, blocks: { year: number; cols: number[] }[]): { year: number; quarter: number } | null {
  for (const block of blocks) {
    for (let q = 0; q < 4; q += 1) {
      const v = num(cellAt(row, block.cols[q]));
      if (v && v > 0) return { year: block.year, quarter: q + 1 };
    }
  }
  return null;
}

export async function importDrawingList(sheet: SheetData, ctx: PlanContext, log: ImportLogger, batches: BatchRef[]) {
  const blocks = locateQuarterBlocks(sheet.rows);
  if (blocks.plan.length === 0) {
    log.warn('DRAWING_BLOCKS_NOT_FOUND', 'Plan/actual quarter blocks not found; drawing list skipped', {
      workbook: ctx.workbook,
      sheet: sheet.name,
    });
    return;
  }
  const batchByNo = new Map(batches.map((b) => [b.batchNo, b]));
  let created = 0;
  let updated = 0;
  let issueType: string | null = null;
  let sectionName: string | null = null;
  let mismatches = 0;
  let missingDates = 0;

  for (let i = 3; i < sheet.rows.length; i += 1) {
    const row = sheet.rows[i];
    const rowNumber = i + 1;

    // Section header rows put "GFC | INFRA - GRADING" in column D and nothing
    // in the drawing-number columns.
    const dCell = text(cellAt(row, col('D')));
    const eCell = text(cellAt(row, col('E')));
    if (dCell && !eCell && dCell.includes('|')) {
      const [type, name] = dCell.split('|').map((s) => s.trim());
      issueType = type || null;
      sectionName = name || null;
      continue;
    }

    const drawingCode = text(cellAt(row, col('E')));
    const drawingName = text(cellAt(row, col('F')));
    if (!drawingCode || !drawingName) continue;
    if (/^dwg\.?\s*no/i.test(drawingCode)) continue;

    const stageCode = text(cellAt(row, col('A')));
    const disciplineRaw = text(cellAt(row, col('B')));
    const areaOfWorks = text(cellAt(row, col('C')));
    const sheetNo = text(cellAt(row, col('D')));
    const location = text(cellAt(row, col('G')));
    const batchCode = text(cellAt(row, col('H')));
    const batchLabel = text(cellAt(row, col('I')));
    const issuedTillDec = int(cellAt(row, col('J'))) === 1;
    const receipt = date(cellAt(row, col('K')));
    const revision = text(cellAt(row, col('L')));

    const planQ = firstFlaggedQuarter(row, blocks.plan);
    const actualQ = firstFlaggedQuarter(row, blocks.actual);
    const completed = issuedTillDec || actualQ != null;

    let baseline: Date | null = null;
    if (planQ) baseline = calendarQuarter(planQ.year, planQ.quarter).end;
    else if (completed && receipt) baseline = endOfDay(receipt);

    const actualDate = completed ? receipt : null;
    if (completed && !receipt) {
      missingDates += 1;
      log.warn('DRAWING_COMPLETED_NO_DATE', `Drawing ${drawingCode} is marked issued but has no date of receipt`, {
        workbook: ctx.workbook,
        sheet: sheet.name,
        rowNumber,
      });
    }
    if (actualQ && receipt) {
      const receiptQ = Math.floor(receipt.getUTCMonth() / 3) + 1;
      if (receipt.getUTCFullYear() !== actualQ.year || receiptQ !== actualQ.quarter) {
        mismatches += 1;
        log.warn(
          'ISSUE_QUARTER_MISMATCH',
          `Drawing ${drawingCode}: source flags issue in ${actualQ.year} Q${actualQ.quarter}, but the date of receipt is ${receipt.toISOString().slice(0, 10)}. The date of receipt is treated as authoritative.`,
          { workbook: ctx.workbook, sheet: sheet.name, rowNumber },
        );
      }
    }

    const batchNo = batchCode ? Number(batchCode) : NaN;
    const batch = Number.isFinite(batchNo) ? batchByNo.get(batchNo) : undefined;
    let packageId = batch?.packageId ?? null;
    if (!packageId && sectionName) {
      packageId = await findPackageByName(ctx.projectId, sectionName);
    }
    if (!packageId && batchCode) {
      log.warn('DRAWING_PACKAGE_UNMATCHED', `Drawing ${drawingCode} references batch "${batchCode}" with no matching package`, {
        workbook: ctx.workbook,
        sheet: sheet.name,
        rowNumber,
      });
    }

    const res = await upsertDrawing({
      projectId: ctx.projectId,
      phaseId: ctx.phaseId,
      packageId,
      disciplineId: await disciplineIdFor(disciplineRaw),
      drawingCode,
      drawingNumber: sheetNo,
      drawingName,
      areaOfWorks,
      location,
      stageCode,
      batchCode: batchCode ?? '',
      batch: batchLabel,
      issueType,
      revision,
      baselineReleaseDate: baseline,
      currentExpectedReleaseDate: baseline,
      actualReleaseDate: actualDate,
      completionStatus: completed ? 'COMPLETED' : 'NOT_COMPLETED',
      planPeriodLabel: planQ ? `CY${planQ.year} Q${planQ.quarter}` : null,
      remarks: sectionName ? `Source section: ${issueType ?? ''} ${sectionName}`.trim() : null,
    });
    if (res.created) created += 1;
    else updated += 1;
    for (const f of res.protectedFields) {
      log.info(
        'FIELD_PROTECTED_USER_EDIT',
        `Drawing ${drawingCode}: ${f.field} was edited by a user — database value kept (${String(f.kept instanceof Date ? f.kept.toISOString().slice(0, 10) : f.kept)}), source has ${String(f.source instanceof Date ? f.source.toISOString().slice(0, 10) : f.source)}.`,
        { workbook: ctx.workbook, sheet: sheet.name, rowNumber },
      );
    }
  }

  log.count('drawingsCreated', created);
  log.count('drawingsUpdated', updated);
  log.count('drawingQuarterMismatches', mismatches);
  log.info(
    'DRAWING_LIST',
    `${created} created, ${updated} updated, ${mismatches} plan/actual quarter mismatches, ${missingDates} issued without a date`,
    { workbook: ctx.workbook, sheet: sheet.name },
  );
}

// ---------------------------------------------------------------------------
// 4. Package schedule + derived sequence links
// ---------------------------------------------------------------------------

/**
 * Packages get their baseline release date from the drawings they contain.
 * Packages with no drawings are scheduled by chaining their planned durations
 * from the plan start date recorded in the workbook title. Both are recorded
 * as the BASELINE, so any later movement shows up as slippage rather than
 * quietly rewriting the plan.
 */
export async function scheduleAndLinkPackages(ctx: PlanContext, log: ImportLogger, deriveLinks: boolean) {
  const pkgs = await db
    .select()
    .from(packagesTable)
    .where(eq(packagesTable.projectId, ctx.projectId));
  pkgs.sort((a, b) => a.sequence - b.sequence || a.packageCode.localeCompare(b.packageCode));

  const allDrawings = await db
    .select({
      packageId: drawingsTable.packageId,
      baseline: drawingsTable.baselineReleaseDate,
    })
    .from(drawingsTable)
    .where(eq(drawingsTable.projectId, ctx.projectId));
  const maxByPackage = new Map<string, Date>();
  for (const d of allDrawings) {
    if (!d.packageId || !d.baseline) continue;
    const cur = maxByPackage.get(d.packageId);
    if (!cur || d.baseline.getTime() > cur.getTime()) maxByPackage.set(d.packageId, d.baseline);
  }

  let cursor = ctx.planStart;
  let scheduled = 0;
  let chained = 0;
  for (const p of pkgs) {
    const fromDrawings = maxByPackage.get(p.id) ?? null;
    let baseline = p.baselineReleaseDate ?? fromDrawings;
    if (!baseline) {
      const duration = p.durationDays ?? 15;
      baseline = endOfDay(addDays(cursor, duration));
      chained += 1;
    }
    cursor = baseline;
    await db
      .update(packagesTable)
      .set({
        baselineStartDate: addDays(baseline, -(p.durationDays ?? 15)),
        baselineReleaseDate: baseline,
        currentExpectedReleaseDate: p.currentExpectedReleaseDate ?? baseline,
        updatedAt: new Date(),
      })
      .where(eq(packagesTable.id, p.id));
    scheduled += 1;
  }
  log.info(
    'PACKAGE_SCHEDULE',
    `${scheduled} packages given a baseline release date (${chained} chained from planned durations because they contain no dated drawings)`,
    { workbook: ctx.workbook },
  );

  // Deliverables inherit their package's baseline.
  const { deliverables: deliverablesTable } = await import('@/db/schema');
  const refreshed = await db.select().from(packagesTable).where(eq(packagesTable.projectId, ctx.projectId));
  for (const p of refreshed) {
    if (!p.baselineReleaseDate) continue;
    await db
      .update(deliverablesTable)
      .set({
        baselineReleaseDate: p.baselineReleaseDate,
        currentExpectedReleaseDate: p.currentExpectedReleaseDate ?? p.baselineReleaseDate,
        updatedAt: new Date(),
      })
      .where(eq(deliverablesTable.packageId, p.id));
  }

  if (!deriveLinks) return;

  // Sequence links: within a package group, batches run in code order. This is
  // the only relationship the source workbook actually expresses (numbered
  // batches with durations), and it is editable in the Schedule screen.
  const byGroup = new Map<string, typeof refreshed>();
  for (const p of refreshed) {
    const key = p.packageGroup ?? 'UNGROUPED';
    const list = byGroup.get(key) ?? [];
    list.push(p);
    byGroup.set(key, list);
  }
  let links = 0;
  const { deliverables: dlTable } = await import('@/db/schema');
  for (const [, list] of byGroup) {
    list.sort((a, b) => a.sequence - b.sequence || a.packageCode.localeCompare(b.packageCode));
    for (let i = 1; i < list.length; i += 1) {
      await upsertDependency({
        predecessorType: 'PACKAGE',
        predecessorId: list[i - 1].id,
        successorType: 'PACKAGE',
        successorId: list[i].id,
        dependencyType: 'FS',
        lagDays: 0,
      });
      links += 1;
      // Every deliverable in the successor package also waits on the
      // predecessor package's release.
      const succDeliverables = await db.select({ id: dlTable.id }).from(dlTable).where(eq(dlTable.packageId, list[i].id));
      for (const d of succDeliverables) {
        await upsertDependency({
          predecessorType: 'PACKAGE',
          predecessorId: list[i - 1].id,
          successorType: 'DELIVERABLE',
          successorId: d.id,
          dependencyType: 'FS',
          lagDays: 0,
        });
        links += 1;
      }
    }
  }
  log.count('dependencies', links);
  log.info(
    'DERIVED_DEPENDENCIES',
    `${links} finish-to-start links set from the numbered batch sequence. These are editable defaults, not source data.`,
    { workbook: ctx.workbook },
  );
}

// ---------------------------------------------------------------------------
// 5. Commercial assumption sheets
// ---------------------------------------------------------------------------

export async function importCommercialAssumptions(sheet: SheetData, ctx: PlanContext, log: ImportLogger) {
  // "Total" row carries the construction cost split and the design fee split.
  let totalRow: Row | null = null;
  for (const row of sheet.rows) {
    if (normaliseName(text(cellAt(row, col('B'))) ?? '') === 'TOTAL') {
      totalRow = row;
      break;
    }
  }
  if (!totalRow) {
    log.info('COMMERCIAL_NO_TOTAL', `No Total row found in "${sheet.name}"; nothing captured`, {
      workbook: ctx.workbook,
      sheet: sheet.name,
    });
    return;
  }
  const captured: Record<string, number> = {};
  const map: { key: string; column: string }[] = [
    { key: 'constructionCost.total', column: 'C' },
    { key: 'constructionCost.architectural', column: 'E' },
    { key: 'constructionCost.structural', column: 'F' },
    { key: 'constructionCost.mep', column: 'G' },
    { key: 'constructionCost.landscaping', column: 'H' },
    { key: 'designFee.architectural', column: 'J' },
    { key: 'designFee.structural', column: 'K' },
    { key: 'designFee.mep', column: 'L' },
    { key: 'designFee.landscaping', column: 'M' },
  ];
  for (const m of map) {
    const v = num(cellAt(totalRow, col(m.column)));
    if (v == null) continue;
    captured[m.key] = v;
    const key = `project.${ctx.projectCode}.${sheet.name.replace(/\s+/g, '')}.${m.key}`;
    const [existing] = await db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
    if (existing) {
      await db.update(appSettings).set({ value: String(v), updatedAt: new Date() }).where(eq(appSettings.key, key));
    } else {
      await db.insert(appSettings).values({ key, value: String(v), updatedAt: new Date() });
    }
  }
  log.info(
    'COMMERCIAL_CAPTURED',
    `Captured ${Object.keys(captured).length} commercial figures from "${sheet.name}" as project settings`,
    { workbook: ctx.workbook, sheet: sheet.name, payload: captured },
  );
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function importProjectPlanWorkbook(wb: WorkbookData, log: ImportLogger, deriveLinks = true) {
  const ctx = await resolveProject(wb, log);
  if (!ctx) return;
  log.info('PLAN_PROJECT', `Plan workbook mapped to project "${ctx.projectName}" (${ctx.projectCode})`, {
    workbook: wb.fileName,
  });

  // Once a project's drawings come from the drawing register import (Import, or
  // a drawing-sources manifest), that import keeps its Design Fee packages and
  // drawings; this older reader leaves them alone so the two never disagree.
  const [managed] = await db
    .select({ id: drawingsTable.id })
    .from(drawingsTable)
    .where(and(eq(drawingsTable.projectId, ctx.projectId), isNotNull(drawingsTable.sourceKey)))
    .limit(1);
  if (managed) {
    log.info('PLAN_KEPT_BY_REGISTER_IMPORT', `The Design Fee packages and drawings of ${ctx.projectName} are kept by the drawing register import; only its other sheets were read.`, {
      workbook: wb.fileName,
    });
  }

  const feeSheet = wb.sheets.find((s) => /^Design Fee$/i.test(s.name));
  if (feeSheet && !managed) await importDesignFee(feeSheet, ctx, log);

  let batches: BatchRef[] = [];
  const pkgSheet = wb.sheets.find((s) => /^Packages deliverables$/i.test(s.name));
  if (pkgSheet) batches = await importPackagesDeliverables(pkgSheet, ctx, log);

  for (const sheet of wb.sheets) {
    if (/^Drawing list/i.test(sheet.name) && !managed) await importDrawingList(sheet, ctx, log, batches);
  }

  if (!managed) await scheduleAndLinkPackages(ctx, log, deriveLinks);

  for (const sheet of wb.sheets) {
    if (/^(Assumption Cost|BOQ cost)$/i.test(sheet.name)) await importCommercialAssumptions(sheet, ctx, log);
  }

  const handled = /^(Design Fee|Packages deliverables|Drawing list.*|Assumption Cost|BOQ cost)$/i;
  for (const sheet of wb.sheets) {
    if (handled.test(sheet.name)) continue;
    log.warn('SHEET_UNCLASSIFIED', `"${sheet.name}" in ${wb.fileName} was not recognised`, {
      workbook: wb.fileName,
      sheet: sheet.name,
    });
  }
}
