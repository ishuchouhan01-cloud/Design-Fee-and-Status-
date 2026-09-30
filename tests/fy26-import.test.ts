/**
 * End-to-end import of the 17 FY26 workbooks into the test database.
 *
 * The validation targets are asserted exactly. If a workbook changes and the
 * totals move, this fails rather than quietly importing a different number of
 * records.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  fy26ImportIssues,
  fy26PackageDependencies,
  fy26Packages,
  fy26Phases,
  fy26Projects,
  fy26ScopeMap,
  projects,
} from '@/db/schema';
import { EXPECTED_TOTALS, runFy26Import, type Fy26ImportResult } from '@/lib/import/design-goals-fy26';

const SOURCE_DIR = path.resolve(process.cwd(), process.env.FY26_SOURCE_DIR ?? 'data/fy26');
const available = fs.existsSync(SOURCE_DIR) && fs.readdirSync(SOURCE_DIR).some((f) => f.endsWith('.xlsx'));

describe.skipIf(!available)('Design Goals FY 26 import', () => {
  let result: Fy26ImportResult;

  beforeAll(async () => {
    result = await runFy26Import({ sourceDir: SOURCE_DIR, apply: true, actor: { id: null, label: 'test setup' } });
  }, 300_000);

  it('reads all 17 workbooks', () => {
    expect(result.workbooks).toBe(17);
  });

  it('meets every validation target exactly', () => {
    for (const row of result.validation) {
      expect(`${row.metric}=${row.actual}`).toBe(`${row.metric}=${EXPECTED_TOTALS[row.metric]}`);
      expect(row.status).toBe('PASS');
    }
    expect(result.valid).toBe(true);
  });

  it('writes the hierarchy it reported', async () => {
    // Dependencies are counted with `is_manual = false`: another test file may
    // have added rows through "+ Add Dependency", and those are not the
    // importer's output.
    const counts = await Promise.all([
      db.select({ n: sql<number>`count(*)::int` }).from(fy26Projects),
      db.select({ n: sql<number>`count(*)::int` }).from(fy26Phases),
      db.select({ n: sql<number>`count(*)::int` }).from(fy26Packages),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(fy26PackageDependencies)
        .where(eq(fy26PackageDependencies.isManual, false)),
    ]);
    expect(counts[0][0].n).toBe(EXPECTED_TOTALS.projects);
    expect(counts[1][0].n).toBe(EXPECTED_TOTALS.phases);
    expect(counts[2][0].n).toBe(EXPECTED_TOTALS.packages);
    expect(counts[3][0].n).toBe(EXPECTED_TOTALS.dependencies);
  });

  it('keeps the 65 dependencies that have no Step label', async () => {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(fy26PackageDependencies)
      .where(and(isNull(fy26PackageDependencies.stepLabel), eq(fy26PackageDependencies.isManual, false)));
    expect(n).toBe(65);
    expect(result.totals.dependenciesWithoutStepLabel).toBe(65);
  });

  it('excludes the template rows and the empty step markers', () => {
    expect(result.issuesByCode.TEMPLATE_ROW_SKIPPED).toBe(533);
    expect(result.issuesByCode.EMPTY_STEP_MARKER).toBe(10);
  });

  it('never guesses a scope label', () => {
    expect(result.issuesByCode.UNMAPPED_SCOPE_LABEL ?? 0).toBe(0);
    expect(result.issues.filter((i) => i.severity === 'ERROR')).toHaveLength(0);
  });

  it('skips the stale duplicate sheet exactly once', () => {
    expect(result.issuesByCode.DUPLICATE_SHEET_SKIPPED).toBe(1);
    const issue = result.issues.find((i) => i.code === 'DUPLICATE_SHEET_SKIPPED');
    expect(issue?.sheet).toBe('New Projects - Goals FY 26-27Q3');
  });

  it('records the two mistitled SftH status sheets as an ambiguity rather than importing them', () => {
    const ambiguous = result.issues.filter((i) => i.code === 'SOURCE_DATA_AMBIGUITY');
    expect(ambiguous).toHaveLength(2);
    for (const i of ambiguous) {
      expect(i.workbook).toContain('0106 SftH');
      expect(i.message).toMatch(/Songs From The Wood/);
      expect(i.message).toMatch(/excluded rather than guessed/);
    }
  });

  it('still imports the SftH goals themselves', async () => {
    const [project] = await db.select().from(fy26Projects).where(eq(fy26Projects.projectName, 'SftH')).limit(1);
    expect(project).toBeDefined();
    // SftH is a new project: it must NOT be attached to any legacy record.
    expect(project.legacyProjectId).toBeNull();

    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(fy26Packages)
      .where(eq(fy26Packages.fy26ProjectId, project.id));
    expect(n).toBe(43);

    const phases = await db.select().from(fy26Phases).where(eq(fy26Phases.fy26ProjectId, project.id));
    expect(phases.map((p) => p.phaseName).sort()).toEqual([
      'Commercial - North Block',
      'Commercial - South Block',
      'South Block - Residential',
    ]);
  });

  it('models OTR as one project with four phases, linked to TEHPL-OTR', async () => {
    const [otr] = await db.select().from(fy26Projects).where(eq(fy26Projects.projectName, 'OTR')).limit(1);
    expect(otr).toBeDefined();

    const [legacy] = await db.select().from(projects).where(eq(projects.id, otr.legacyProjectId!)).limit(1);
    expect(legacy.projectCode).toBe('TEHPL-OTR');

    const phases = await db.select().from(fy26Phases).where(eq(fy26Phases.fy26ProjectId, otr.id));
    expect(phases.map((p) => p.phaseName).sort()).toEqual(['MUSEUM', 'OOTA', 'PH01', 'PH02']);

    // The legacy OTR-PH01 record is still its own project and is untouched; the
    // FY26 phase links to it rather than replacing it.
    const ph01 = phases.find((p) => p.phaseName === 'PH01')!;
    const [legacyPh01] = await db.select().from(projects).where(eq(projects.id, ph01.legacyProjectId!)).limit(1);
    expect(legacyPh01.projectCode).toBe('OTR-PH01');
  });

  it('models ITQE phases under one ITQE project, not as separate projects', async () => {
    const [itqe] = await db.select().from(fy26Projects).where(eq(fy26Projects.projectName, 'ITQE')).limit(1);
    const phases = await db.select().from(fy26Phases).where(eq(fy26Phases.fy26ProjectId, itqe.id));
    expect(phases.map((p) => p.phaseName).sort()).toEqual([
      'Ph1',
      'Ph2b',
      'Ph2c [T9]',
      'Ph3a [T10-12 & 31 Villas]',
    ]);
  });

  it('does not make a sibling project into a phase', async () => {
    // "Blue in Green" sits under the OTF banner in the workbook but is project
    // 0098, not a phase of 0099.
    const [big] = await db
      .select()
      .from(fy26Projects)
      .where(eq(fy26Projects.projectName, 'Blue in Green'))
      .limit(1);
    expect(big).toBeDefined();

    const [otf] = await db.select().from(fy26Projects).where(eq(fy26Projects.projectName, 'OtF')).limit(1);
    const otfPhases = await db.select().from(fy26Phases).where(eq(fy26Phases.fy26ProjectId, otf.id));
    expect(otfPhases.map((p) => p.phaseName)).not.toContain('Blue in Green');
  });

  it('merges both split package rows into their parents and keeps the phase conflict visible', async () => {
    expect(result.issuesByCode.PACKAGE_ROW_SPLIT_MERGED).toBe(2);
    expect(result.issuesByCode.PHASE_CONFLICT_ON_SPLIT_ROW).toBe(1);

    const merged = result.issues.filter((i) => i.code === 'PACKAGE_ROW_SPLIT_MERGED');
    const rows = merged.map((i) => `${i.workbook?.slice(0, 4)}:${i.rowNumber}`).sort();
    expect(rows).toEqual(['0057:48', '0063:133']);
    for (const i of merged) expect(i.message).toMatch(/Merged into the package at row (46|129)/);

    // The SftW parent at row 46 carries the orphan row's billing.
    const [parent] = await db
      .select()
      .from(fy26Packages)
      .where(and(sql`${fy26Packages.sourceWorkbook} like '0057%'`, eq(fy26Packages.sourceRow, 46)))
      .limit(1);
    expect(parent.planBillingCr).toBeCloseTo(0.00371275425, 10);
    expect(parent.plannedPackageQuantity).toBe(1);

    // The conflicting phase from the orphan row was reported, never applied.
    const conflict = result.issues.find((i) => i.code === 'PHASE_CONFLICT_ON_SPLIT_ROW')!;
    expect(conflict.message).toMatch(/Vdrhl-Res/);
    expect(conflict.message).toMatch(/NOT applied/);
  });

  it('sets the baseline from the source and never invents an actual date', async () => {
    // 406 of the 435 packages carry a release date in the source; the other 29
    // are imported without one rather than given an invented date.
    const [{ withBaseline, noDate }] = await db
      .select({
        withBaseline: sql<number>`count(*) filter (where ${fy26Packages.baselineReleaseDate} is not null)::int`,
        noDate: sql<number>`count(*) filter (where ${fy26Packages.baselineReleaseDate} is null)::int`,
      })
      .from(fy26Packages);
    expect(withBaseline).toBe(406);
    expect(noDate).toBe(29);
    expect(withBaseline + noDate).toBe(EXPECTED_TOTALS.packages);

    // The importer never writes an actual release date — the source has none.
    const [{ actuals }] = await db
      .select({ actuals: sql<number>`count(*) filter (where ${fy26Packages.actualReleaseDate} is not null)::int` })
      .from(fy26Packages);
    expect(actuals).toBe(0);
  });

  it('leaves the baseline untouched when a re-import runs after the expected date was moved', async () => {
    const [pkg] = await db
      .select()
      .from(fy26Packages)
      .where(sql`${fy26Packages.baselineReleaseDate} is not null`)
      .limit(1);
    const baselineBefore = pkg.baselineReleaseDate!.toISOString();

    await db
      .update(fy26Packages)
      .set({ currentExpectedReleaseDate: new Date(Date.UTC(2028, 0, 1)) })
      .where(eq(fy26Packages.id, pkg.id));

    await runFy26Import({ sourceDir: SOURCE_DIR, apply: true, actor: { id: null, label: 'test setup' } });

    const [after] = await db.select().from(fy26Packages).where(eq(fy26Packages.id, pkg.id)).limit(1);
    expect(after.baselineReleaseDate!.toISOString()).toBe(baselineBefore);
  }, 300_000);

  it('seeds the scope map and records every source label', async () => {
    const rows = await db.select().from(fy26ScopeMap);
    expect(rows.length).toBe(57);
    for (const r of rows) {
      expect(r.sourceLabel.length).toBeGreaterThan(0);
      expect(r.sourceWorkbook.length).toBeGreaterThan(0);
    }
  });

  it('keeps the verbatim source label and full traceability on every package', async () => {
    const rows = await db.select().from(fy26Packages).limit(50);
    for (const r of rows) {
      expect(r.sourceWorkbook).toMatch(/\.xlsx$/);
      expect(r.sourceSheet.length).toBeGreaterThan(0);
      expect(r.sourceRow).toBeGreaterThan(0);
      expect(r.importBatchId).toBeTruthy();
    }
  });

  it('is idempotent — a second run creates nothing', async () => {
    const second = await runFy26Import({
      sourceDir: SOURCE_DIR,
      apply: true,
      actor: { id: null, label: 'test setup' },
    });
    expect(second.created).toBe(0);
    expect(second.valid).toBe(true);

    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(fy26Packages);
    expect(n).toBe(EXPECTED_TOTALS.packages);
  }, 300_000);

  it('persists the issue log against the batch', async () => {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(fy26ImportIssues)
      .where(eq(fy26ImportIssues.batchId, result.batchId));
    expect(n).toBe(result.issues.length);
  });
});
