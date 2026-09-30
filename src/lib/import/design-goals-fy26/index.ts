/**
 * Design Goals FY 26 importer.
 *
 *   preview   read every workbook, classify every row, produce the validation
 *             table and the issue log. Writes nothing but the batch record.
 *   apply     the same, then write the hierarchy in one transaction.
 *
 * Re-running is safe: every entity has a natural key, and fields a user has
 * edited are never overwritten (see `upsert.ts`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { fy26ImportBatches, fy26ImportIssues, fy26PackageDependencies, fy26Packages } from '@/db/schema';
import { recordAudit, type Actor } from '@/lib/audit';
import { users } from '@/db/schema';
import { slug } from '@/lib/ids';
import { newId } from '@/lib/ids';
import { buildProjectLegacyIndex, readFy26Workbook, type ParsedPackage, type ReadIssue } from './read-sheet';
import { loadLegacyProjectIds, loadScopeMap, seedScopeMap } from './scope-map';
import {
  applyIncoming,
  assignOccurrences,
  dependencyNaturalKey,
  disciplineIdFor,
  newCaches,
  packageNaturalKey,
  parseEditedFields,
  upsertPhase,
  upsertProject,
  userIdFor,
} from './upsert';

/**
 * Validation targets, confirmed against the source workbooks.
 *
 * `planBillingCr` includes the two split package rows (SftW row 48 into its
 * parent at row 46, ITQE row 133 into its parent at row 129), which contribute
 * 6.324750 Cr between them. An earlier figure of 157.1177 excluded them.
 */
export const EXPECTED_TOTALS = {
  projects: 27,
  phases: 22,
  packages: 435,
  dependencies: 334,
  planBillingCr: 163.4425,
} as const;

export type ExpectedKey = keyof typeof EXPECTED_TOTALS;

export interface ValidationRow {
  metric: ExpectedKey;
  expected: number;
  actual: number;
  difference: number;
  status: 'PASS' | 'FAIL';
}

export interface ImportTotals {
  projects: number;
  phases: number;
  packages: number;
  dependencies: number;
  dependenciesWithoutStepLabel: number;
  planBillingCr: number;
  plannedPackageQuantity: number;
  actualBillingCr: number;
  actualPackageQuantity: number;
}

export interface Fy26ImportResult {
  batchId: string;
  applied: boolean;
  workbooks: number;
  totals: ImportTotals;
  validation: ValidationRow[];
  valid: boolean;
  issues: ReadIssue[];
  issuesByCode: Record<string, number>;
  created: number;
  updated: number;
  protectedFields: number;
}

export interface Fy26ImportOptions {
  /** Folder holding the FY26 workbooks. Defaults to `FY26_SOURCE_DIR` or `data/fy26`. */
  sourceDir?: string;
  /** `false` (the default) writes nothing but the batch record. */
  apply?: boolean;
  actor?: Actor;
}

function listWorkbooks(dir: string): string[] {
  if (!fs.existsSync(dir)) throw new Error(`FY26 source folder not found: ${dir}`);
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.xlsx') && !f.startsWith('~$'))
    .sort()
    .map((f) => path.join(dir, f));
}

function round(n: number, dp = 4): number {
  return Number(n.toFixed(dp));
}

function buildValidation(totals: ImportTotals): ValidationRow[] {
  return (Object.keys(EXPECTED_TOTALS) as ExpectedKey[]).map((metric) => {
    const expected = EXPECTED_TOTALS[metric];
    const actual = round(totals[metric]);
    const difference = round(actual - expected);
    return {
      metric,
      expected,
      actual,
      difference,
      status: difference === 0 ? 'PASS' : 'FAIL',
    };
  });
}

export function formatValidation(rows: ValidationRow[]): string {
  const head = `| Metric | Expected | Actual | Difference | Status |\n|---|---:|---:|---:|---|`;
  const body = rows
    .map((r) => `| ${r.metric} | ${r.expected} | ${r.actual} | ${r.difference} | ${r.status} |`)
    .join('\n');
  return `${head}\n${body}`;
}

export async function runFy26Import(options: Fy26ImportOptions = {}): Promise<Fy26ImportResult> {
  const sourceDir = options.sourceDir ?? process.env.FY26_SOURCE_DIR ?? path.join(process.cwd(), 'data', 'fy26');
  const apply = options.apply ?? false;
  const actor: Actor = options.actor ?? { id: null, label: 'import' };

  const files = listWorkbooks(sourceDir);

  await seedScopeMap();
  const scopeMap = await loadScopeMap();
  const projectLegacy = buildProjectLegacyIndex(scopeMap);
  const legacyIds = await loadLegacyProjectIds();

  // ---- read phase: pure, no writes -------------------------------------
  const issues: ReadIssue[] = [];
  const parsed: ParsedPackage[] = [];
  for (const file of files) {
    const wb = readFy26Workbook(file, scopeMap, projectLegacy);
    issues.push(...wb.issues);
    for (const sheet of wb.sheets) {
      issues.push(...sheet.issues);
      parsed.push(...sheet.packages);
    }
  }

  assignOccurrences(parsed);

  // Resolve responsible names during the read phase, so the preview reports
  // unmatched names too — not only an applied run.
  const userRows = await db.select({ name: users.name }).from(users);
  const knownUsers = new Set(userRows.map((u) => slug(u.name)));
  for (const pkg of parsed) {
    if (pkg.responsibleSourceText && !knownUsers.has(slug(pkg.responsibleSourceText))) {
      issues.push({
        severity: 'WARNING',
        code: 'UNRESOLVED_USER',
        workbook: pkg.sourceWorkbook,
        sheet: pkg.sourceSheet,
        rowNumber: pkg.sourceRow,
        message: `Responsible "${pkg.responsibleSourceText}" does not match a user. Kept as source text only.`,
      });
    }
  }

  const projectNames = new Set<string>();
  const phaseKeys = new Set<string>();
  const totals: ImportTotals = {
    projects: 0,
    phases: 0,
    packages: parsed.length,
    dependencies: 0,
    dependenciesWithoutStepLabel: 0,
    planBillingCr: 0,
    plannedPackageQuantity: 0,
    actualBillingCr: 0,
    actualPackageQuantity: 0,
  };
  for (const pkg of parsed) {
    projectNames.add(pkg.projectName);
    if (pkg.phaseName) phaseKeys.add(`${pkg.projectName}|${pkg.phaseName}`);
    totals.planBillingCr += pkg.planBillingCr ?? 0;
    totals.actualBillingCr += pkg.actualBillingCr ?? 0;
    totals.plannedPackageQuantity += pkg.plannedPackageQuantity ?? 0;
    totals.actualPackageQuantity += pkg.actualPackageQuantity ?? 0;
    totals.dependencies += pkg.dependencies.length;
    totals.dependenciesWithoutStepLabel += pkg.dependencies.filter((d) => !d.stepLabel).length;
  }
  totals.projects = projectNames.size;
  totals.phases = phaseKeys.size;
  totals.planBillingCr = round(totals.planBillingCr);
  totals.actualBillingCr = round(totals.actualBillingCr);

  const validation = buildValidation(totals);
  const valid = validation.every((v) => v.status === 'PASS');

  const batchId = newId('fib_');
  await db.insert(fy26ImportBatches).values({
    id: batchId,
    status: 'PREVIEW',
    sourceFolder: sourceDir,
    workbookCount: files.length,
    startedById: actor.id,
  });

  let created = 0;
  let updated = 0;
  let protectedCount = 0;

  if (apply) {
    const caches = newCaches();
    // The whole hierarchy is written in ONE transaction. If anything throws,
    // PostgreSQL rolls back every insert and update, so a failed import never
    // leaves a partial dataset behind; the batch row is then marked FAILED.
    try {
      await db.transaction(async (tx) => {
        let phaseSeq = 0;
        for (const pkg of parsed) {
          const fy26ProjectId = await upsertProject(
            tx,
            {
              projectName: pkg.projectName,
              legacyProjectId: pkg.legacyProjectCode ? (legacyIds.get(pkg.legacyProjectCode) ?? null) : null,
              projectCode: /^\d{4}/.exec(pkg.sourceWorkbook)?.[0] ?? null,
            },
            caches,
          );

          let fy26PhaseId: string | null = null;
          if (pkg.phaseName) {
            phaseSeq += 10;
            fy26PhaseId = await upsertPhase(
              tx,
              {
                fy26ProjectId,
                phaseName: pkg.phaseName,
                sourceLabel: pkg.phaseSourceLabel ?? pkg.sourceScopeLabel,
                legacyProjectId: pkg.legacyPhaseProjectCode
                  ? (legacyIds.get(pkg.legacyPhaseProjectCode) ?? null)
                  : null,
                sequence: phaseSeq,
              },
              caches,
            );
          }

          const disciplineId = await disciplineIdFor(tx, pkg.disciplineLabel, caches);
          const responsibleUserId = await userIdFor(tx, pkg.responsibleSourceText, caches);

          const naturalKey = packageNaturalKey(pkg);
          const incoming = {
            fy26ProjectId,
            fy26PhaseId,
            disciplineId,
            packageDescription: pkg.packageDescription,
            sourceScopeLabel: pkg.sourceScopeLabel,
            responsibleUserId,
            responsibleSourceText: pkg.responsibleSourceText,
            currentExpectedReleaseDate: pkg.releaseDate,
            planBillingCr: pkg.planBillingCr,
            actualBillingCr: pkg.actualBillingCr,
            plannedPackageQuantity: pkg.plannedPackageQuantity,
            actualPackageQuantity: pkg.actualPackageQuantity,
            remarks: pkg.remarks,
            sourceWorkbook: pkg.sourceWorkbook,
            sourceSheet: pkg.sourceSheet,
            sourceRow: pkg.sourceRow,
            importBatchId: batchId,
          };

          const [existing] = await tx
            .select()
            .from(fy26Packages)
            .where(eq(fy26Packages.naturalKey, naturalKey))
            .limit(1);

          let packageId: string;
          if (existing) {
            packageId = existing.id;
            const edited = parseEditedFields(existing.userEditedFields);
            const { patch, protectedFields } = applyIncoming(existing, incoming, edited);
            for (const p of protectedFields) {
              protectedCount += 1;
              issues.push({
                severity: 'INFO',
                code: 'FIELD_PROTECTED_USER_EDIT',
                workbook: pkg.sourceWorkbook,
                sheet: pkg.sourceSheet,
                rowNumber: pkg.sourceRow,
                message:
                  `Field "${p.field}" was edited in the application, so the Excel value ` +
                  `${JSON.stringify(p.excelValue)} was NOT applied. Kept ${JSON.stringify(p.keptValue)}.`,
              });
            }
            // The baseline is set once and never rewritten by an import.
            await tx
              .update(fy26Packages)
              .set({ ...patch, updatedAt: new Date() })
              .where(eq(fy26Packages.id, packageId));
            updated += 1;
          } else {
            packageId = newId('fpk_');
            await tx.insert(fy26Packages).values({
              id: packageId,
              naturalKey,
              ...incoming,
              baselineReleaseDate: pkg.releaseDate,
              actualReleaseDate: null,
              completionStatus: 'NOT_COMPLETED',
            });
            created += 1;
          }

          for (const dep of pkg.dependencies) {
            const depKey = dependencyNaturalKey(dep);
            const depIncoming = {
              sequence: dep.sequence,
              stepLabel: dep.stepLabel,
              description: dep.description,
              targetDate: dep.targetDate,
              responsibleText: dep.responsibleText,
              remarks: dep.remarks,
              sourceWorkbook: dep.sourceWorkbook,
              sourceSheet: dep.sourceSheet,
              sourceRow: dep.sourceRow,
              importBatchId: batchId,
            };
            const [existingDep] = await tx
              .select()
              .from(fy26PackageDependencies)
              .where(
                sql`${fy26PackageDependencies.fy26PackageId} = ${packageId} and ${fy26PackageDependencies.naturalKey} = ${depKey}`,
              )
              .limit(1);

            if (existingDep) {
              const edited = parseEditedFields(existingDep.userEditedFields);
              const { patch, protectedFields } = applyIncoming(existingDep, depIncoming, edited);
              protectedCount += protectedFields.length;
              for (const p of protectedFields) {
                issues.push({
                  severity: 'INFO',
                  code: 'FIELD_PROTECTED_USER_EDIT',
                  workbook: dep.sourceWorkbook,
                  sheet: dep.sourceSheet,
                  rowNumber: dep.sourceRow,
                  message: `Dependency field "${p.field}" was edited in the application; Excel value not applied.`,
                });
              }
              await tx
                .update(fy26PackageDependencies)
                .set({ ...patch, updatedAt: new Date() })
                .where(eq(fy26PackageDependencies.id, existingDep.id));
              updated += 1;
            } else {
              await tx.insert(fy26PackageDependencies).values({
                id: newId('fdp_'),
                naturalKey: depKey,
                fy26PackageId: packageId,
                ...depIncoming,
                completionStatus: 'NOT_COMPLETED',
                isManual: false,
              });
              created += 1;
            }
          }
        }
      });
    } catch (err) {
      await db
        .update(fy26ImportBatches)
        .set({
          status: 'FAILED',
          finishedAt: new Date(),
          previewJson: JSON.stringify({
            totals,
            validation,
            error: err instanceof Error ? err.message : String(err),
          }),
        })
        .where(eq(fy26ImportBatches.id, batchId));
      throw err;
    }
  }

  // ---- persist the issue log and finish the batch -----------------------
  const issuesByCode: Record<string, number> = {};
  for (const i of issues) issuesByCode[i.code] = (issuesByCode[i.code] ?? 0) + 1;

  if (issues.length) {
    const rows = issues.map((i) => ({
      id: newId('fii_'),
      batchId,
      severity: i.severity,
      code: i.code,
      workbook: i.workbook ?? null,
      sheet: i.sheet ?? null,
      rowNumber: i.rowNumber ?? null,
      sourceLabel: i.sourceLabel ?? null,
      message: i.message,
      payload: i.payload ? JSON.stringify(i.payload) : null,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      await db.insert(fy26ImportIssues).values(rows.slice(i, i + 500));
    }
  }

  const warningCount = issues.filter((i) => i.severity === 'WARNING').length;
  const errorCount = issues.filter((i) => i.severity === 'ERROR').length;
  const status = !apply ? 'PREVIEW' : valid && errorCount === 0 ? 'APPLIED' : 'FAILED';

  await db
    .update(fy26ImportBatches)
    .set({
      status,
      finishedAt: new Date(),
      previewJson: JSON.stringify({ totals, validation, issuesByCode }),
      createdCount: created,
      updatedCount: updated,
      skippedCount: (issuesByCode.TEMPLATE_ROW_SKIPPED ?? 0) + (issuesByCode.EMPTY_STEP_MARKER ?? 0),
      protectedCount,
      warningCount,
      errorCount,
      appliedById: apply ? actor.id : null,
      appliedAt: apply ? new Date() : null,
    })
    .where(eq(fy26ImportBatches.id, batchId));

  if (apply) {
    await recordAudit({
      actor,
      entityType: 'FY26_IMPORT',
      entityId: batchId,
      entityLabel: `Design Goals FY 26 import — ${files.length} workbooks`,
      action: 'IMPORT',
      newValue: `${totals.packages} packages, ${totals.dependencies} dependencies`,
      reason: valid ? 'Validation passed' : 'Validation reported differences',
    });
  }

  return {
    batchId,
    applied: apply,
    workbooks: files.length,
    totals,
    validation,
    valid: valid && errorCount === 0,
    issues,
    issuesByCode,
    created,
    updated,
    protectedFields: protectedCount,
  };
}

export function formatImportSummary(result: Fy26ImportResult): string {
  const lines: string[] = [];
  lines.push(`Design Goals FY 26 import — ${result.applied ? 'APPLIED' : 'PREVIEW (nothing written)'}`);
  lines.push(`Batch    : ${result.batchId}`);
  lines.push(`Workbooks: ${result.workbooks}`);
  lines.push('');
  lines.push(formatValidation(result.validation));
  lines.push('');
  lines.push(`Overall  : ${result.valid ? 'PASS' : 'FAIL — see the differences above'}`);
  lines.push(
    `Rows     : created ${result.created}, updated ${result.updated}, protected from overwrite ${result.protectedFields}`,
  );
  lines.push(`Deps without a Step label: ${result.totals.dependenciesWithoutStepLabel}`);

  // Show where the billing total comes from, so the figure can be checked
  // against a total taken straight from the workbooks. Split rows carry
  // billing that belongs to the package above them.
  const split = result.issues.filter((i) => i.code === 'PACKAGE_ROW_SPLIT_MERGED');
  if (split.length) {
    const splitBilling = split.reduce((sum, i) => {
      const b = (i.payload as { planBillingCr?: number } | undefined)?.planBillingCr;
      return sum + (typeof b === 'number' ? b : 0);
    }, 0);
    lines.push('');
    lines.push('Plan billing reconciliation:');
    for (const i of split) {
      const p = i.payload as { parentRow?: number; planBillingCr?: number } | undefined;
      lines.push(
        `  + ${(p?.planBillingCr ?? 0).toFixed(6)} Cr  ${i.workbook} row ${i.rowNumber} -> merged into its package at row ${p?.parentRow}`,
      );
    }
    lines.push(`  = ${splitBilling.toFixed(6)} Cr from split rows`);
    lines.push(
      `  Total ${result.totals.planBillingCr.toFixed(4)} Cr includes them; ` +
        `${(result.totals.planBillingCr - splitBilling).toFixed(4)} Cr would be the total if split rows were dropped.`,
    );
  }
  lines.push('');
  lines.push('Issues:');
  for (const [code, count] of Object.entries(result.issuesByCode).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${String(count).padStart(5)}  ${code}`);
  }
  return lines.join('\n');
}
