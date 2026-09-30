/**
 * Migration orchestrator. Repeatable and idempotent: every record is matched on
 * a natural key, so running it twice produces updates, not duplicates.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { importIssues, importRuns } from '@/db/schema';
import { newId } from '@/lib/ids';
import { recordAudit } from '@/lib/audit';
import { ImportLogger } from './logger';
import { readWorkbook, type WorkbookData } from './workbook';

/** Formula cells whose value could not be worked out were left empty; say so. */
function logFormulaIssues(wb: WorkbookData, log: { warn: (code: string, message: string, ctx?: Record<string, unknown>) => unknown }) {
  for (const s of wb.sheets) {
    for (const f of s.formulaIssues ?? []) {
      log.warn('FORMULA_NOT_EVALUATED', `A formula in ${s.name} row ${f.row} (${f.formula}) could not be worked out (${f.reason}); the cell is treated as empty.`, {
        workbook: wb.fileName,
        sheet: s.name,
        rowNumber: f.row,
      });
    }
  }
}
import { importGoalsWorkbook } from './goals-workbook';
import { importProjectPlanWorkbook } from './project-plan-workbook';
import { logDataQuality } from './quality';
import { resetCaches } from './upsert';

export interface ImportOptions {
  goalsWorkbook?: string;
  projectPlanWorkbooks?: string[];
  deriveDependencies?: boolean;
  actor?: { id: string | null; label: string };
}

export interface ImportSummary {
  runId: string;
  workbooks: string[];
  counts: Record<string, number>;
  warnings: number;
  errors: number;
  infos: number;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  issues: { severity: string; code: string; message: string; sheet?: string; rowNumber?: number }[];
  totals: {
    projects: number;
    goals: number;
    deliverables: number;
    drawings: number;
    packages: number;
    dependencies: number;
  };
  durationMs: number;
}

export async function runImport(opts: ImportOptions): Promise<ImportSummary> {
  const started = Date.now();
  const log = new ImportLogger();
  resetCaches();

  const workbookPaths = [
    ...(opts.goalsWorkbook ? [opts.goalsWorkbook] : []),
    ...(opts.projectPlanWorkbooks ?? []),
  ];
  const runId = newId('ir_');
  await db.insert(importRuns).values({
    id: runId,
    workbook: workbookPaths.map((p) => p.split(/[\\/]/).pop()).join(', ') || '(none)',
    status: 'RUNNING',
    startedAt: new Date(),
  });

  try {
    if (opts.goalsWorkbook) {
      const wb = readWorkbook(opts.goalsWorkbook);
      log.info('WORKBOOK_OPEN', `Opened ${wb.fileName} with ${wb.sheets.length} sheets`, { workbook: wb.fileName });
      logFormulaIssues(wb, log);
      await importGoalsWorkbook(wb, log);
    } else {
      log.warn('NO_GOALS_WORKBOOK', 'No goals workbook configured (EXCEL_GOALS_WORKBOOK)');
    }

    for (const path of opts.projectPlanWorkbooks ?? []) {
      const wb = readWorkbook(path);
      log.info('WORKBOOK_OPEN', `Opened ${wb.fileName} with ${wb.sheets.length} sheets`, { workbook: wb.fileName });
      logFormulaIssues(wb, log);
      await importProjectPlanWorkbook(wb, log, opts.deriveDependencies ?? true);
    }

    await logDataQuality(log);
  } catch (err) {
    log.error('IMPORT_FAILED', err instanceof Error ? err.message : String(err));
  }

  // Persist the issue log so it can be reviewed later from Settings.
  const rows = log.issues.map((i) => ({
    id: newId('ii_'),
    importRunId: runId,
    severity: i.severity,
    workbook: i.workbook ?? null,
    sheet: i.sheet ?? null,
    rowNumber: i.rowNumber ?? null,
    code: i.code,
    message: i.message,
    payload: i.payload ? JSON.stringify(i.payload).slice(0, 4000) : null,
  }));
  for (let i = 0; i < rows.length; i += 200) {
    await db.insert(importIssues).values(rows.slice(i, i + 200));
  }

  const totals = await currentTotals();
  const status: ImportSummary['status'] = log.errors > 0 ? 'PARTIAL' : 'SUCCESS';
  const counts = log.counts;

  await db
    .update(importRuns)
    .set({
      finishedAt: new Date(),
      status,
      summaryJson: JSON.stringify({ counts, totals }),
      createdCount:
        (counts.goalsCreated ?? 0) + (counts.deliverablesCreated ?? 0) + (counts.drawingsCreated ?? 0),
      updatedCount:
        (counts.goalsUpdated ?? 0) + (counts.deliverablesUpdated ?? 0) + (counts.drawingsUpdated ?? 0),
      skippedCount: (counts.sheetsSkippedDerived ?? 0) + (counts.sheetsSkippedLeaderView ?? 0),
      warningCount: log.warnings,
      errorCount: log.errors,
    })
    .where(eq(importRuns.id, runId));

  await recordAudit({
    actor: opts.actor ?? { id: null, label: 'Excel migration' },
    entityType: 'IMPORT_RUN',
    entityId: runId,
    entityLabel: workbookPaths.join(', '),
    action: 'IMPORT',
    newValue: JSON.stringify(totals),
    reason: 'Excel migration',
  });

  return {
    runId,
    workbooks: workbookPaths,
    counts,
    warnings: log.warnings,
    errors: log.errors,
    infos: log.infos,
    status,
    issues: log.issues.map((i) => ({
      severity: i.severity,
      code: i.code,
      message: i.message,
      sheet: i.sheet,
      rowNumber: i.rowNumber,
    })),
    totals,
    durationMs: Date.now() - started,
  };
}

export async function currentTotals() {
  const { sql } = await import('drizzle-orm');
  const {
    projects,
    goals,
    deliverables,
    drawings,
    packages,
    dependencies,
  } = await import('@/db/schema');
  const one = async (table: typeof projects | typeof goals | typeof deliverables | typeof drawings | typeof packages | typeof dependencies) =>
    Number((await db.select({ n: sql<number>`count(*)::int` }).from(table as typeof projects))[0]?.n ?? 0);
  return {
    projects: await one(projects),
    goals: await one(goals),
    deliverables: await one(deliverables),
    drawings: await one(drawings),
    packages: await one(packages),
    dependencies: await one(dependencies),
  };
}

export function formatSummary(s: ImportSummary): string {
  const lines: string[] = [];
  lines.push('='.repeat(72));
  lines.push('EXCEL MIGRATION SUMMARY');
  lines.push('='.repeat(72));
  lines.push(`Run id      : ${s.runId}`);
  lines.push(`Status      : ${s.status}`);
  lines.push(`Duration    : ${(s.durationMs / 1000).toFixed(1)}s`);
  lines.push(`Workbooks   :`);
  for (const w of s.workbooks) lines.push(`  - ${w}`);
  lines.push('');
  lines.push('Database totals after import');
  lines.push(`  projects        ${String(s.totals.projects).padStart(6)}`);
  lines.push(`  packages        ${String(s.totals.packages).padStart(6)}`);
  lines.push(`  goals           ${String(s.totals.goals).padStart(6)}`);
  lines.push(`  deliverables    ${String(s.totals.deliverables).padStart(6)}`);
  lines.push(`  drawings        ${String(s.totals.drawings).padStart(6)}`);
  lines.push(`  dependencies    ${String(s.totals.dependencies).padStart(6)}`);
  lines.push('');
  lines.push('Import counters');
  for (const [k, v] of Object.entries(s.counts)) lines.push(`  ${k.padEnd(28)} ${String(v).padStart(6)}`);
  lines.push('');
  lines.push(`Warnings: ${s.warnings}   Errors: ${s.errors}   Notes: ${s.infos}`);
  const problems = s.issues.filter((i) => i.severity !== 'INFO');
  if (problems.length) {
    lines.push('');
    lines.push('Items needing review (first 40)');
    for (const p of problems.slice(0, 40)) {
      lines.push(`  [${p.severity}] ${p.code}${p.sheet ? ` (${p.sheet}${p.rowNumber ? `:${p.rowNumber}` : ''})` : ''}`);
      lines.push(`      ${p.message}`);
    }
    if (problems.length > 40) lines.push(`  … ${problems.length - 40} more (see Settings → Import log)`);
  }
  lines.push('='.repeat(72));
  return lines.join('\n');
}
