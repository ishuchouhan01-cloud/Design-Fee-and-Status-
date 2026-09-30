/**
 * Drawing Register import — the Stage 2 acceptance targets, against the real
 * PoaRR workbooks in data/drawing-sources/poarr/.
 *
 * Runs before the other drawing tests (alphabetical order) and leaves the
 * imported register in place for them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  drawingConflicts,
  drawingImportIssues,
  drawingLocationPhaseMap,
  drawingRevisions,
  drawingSnapshots,
  drawings,
  projectPhases,
  projects,
  rescheduleHistory,
} from '@/db/schema';
import { runDrawingImport, type DrawingImportResult } from '@/lib/import/drawing-register';
import { assessDrawing, drawingScheduleStatusSql } from '@/lib/services/drawing-register';

const MANIFEST = path.resolve(process.cwd(), 'data/drawing-sources/poarr.json');
const available = fs.existsSync(MANIFEST) && fs.existsSync(path.resolve(process.cwd(), 'data/drawing-sources/poarr'));
const actor = { id: null, label: 'drawing import test' };

async function projectIds() {
  const rows = await db.select().from(projects).where(inArray(projects.projectCode, ['POARR-RES', 'POARR-T08', 'POARR-T09']));
  return Object.fromEntries(rows.map((r) => [r.projectCode, r.id])) as Record<string, string>;
}

async function countsBy(projectId: string) {
  const [r] = await db
    .select({
      n: sql<number>`count(*)::int`,
      released: sql<number>`count(*) filter (where ${drawings.completionStatus} = 'COMPLETED')::int`,
      notReleased: sql<number>`count(*) filter (where ${drawings.completionStatus} = 'NOT_COMPLETED')::int`,
      nyn: sql<number>`count(*) filter (where ${drawings.numberStatus} = 'NOT_YET_NUMBERED')::int`,
      actual: sql<number>`count(${drawings.actualReleaseDate})::int`,
    })
    .from(drawings)
    .where(eq(drawings.projectId, projectId));
  return r;
}

describe.skipIf(!available)('Drawing Register import (PoaRR)', () => {
  let preview: DrawingImportResult;
  let applied: DrawingImportResult;
  let ids: Record<string, string>;

  beforeAll(async () => {
    ids = await projectIds();
    preview = await runDrawingImport({ manifestPath: MANIFEST, apply: false, actor });
    applied = await runDrawingImport({ manifestPath: MANIFEST, apply: true, actor });
  }, 300_000);

  it('previews without writing drawing data, and the plan matches every target', async () => {
    expect(preview.mode).toBe('PREVIEW');
    expect(preview.validation).toEqual([]);
    expect(preview.valid).toBe(true);
    expect(preview.counts.total).toMatchObject({
      drawings: 14426,
      released: 13788,
      notReleased: 638,
      notYetNumbered: 1362,
      numberConflicts: 112,
      accOnlyConflicts: 5,
      actualDates: 1404,
    });
    expect(preview.counts.historicalSnapshotRows.total).toBe(18517);
    expect(preview.changes.create).toBe(14426);
  });

  it('imports exactly 14,426 current drawings with the validated split per project', async () => {
    expect(applied.mode).toBe('APPLIED');
    expect(applied.applied!.created).toBe(14426);
    const res = await countsBy(ids['POARR-RES']);
    const t08 = await countsBy(ids['POARR-T08']);
    const t09 = await countsBy(ids['POARR-T09']);
    expect(res).toEqual({ n: 11403, released: 11235, notReleased: 168, nyn: 813, actual: 0 });
    expect(t08).toEqual({ n: 1524, released: 1149, notReleased: 375, nyn: 549, actual: 0 });
    expect(t09).toEqual({ n: 1499, released: 1404, notReleased: 95, nyn: 0, actual: 1404 });
    expect(res.n + t08.n + t09.n).toBe(14426);
    expect(res.released + t08.released + t09.released).toBe(13788);
    expect(res.notReleased + t08.notReleased + t09.notReleased).toBe(638);
    expect(res.nyn + t08.nyn + t09.nyn).toBe(1362);
  });

  it('preserves 18,517 historical snapshot rows, per workbook', async () => {
    const rows = await db
      .select({ wb: drawingSnapshots.sourceWorkbook, n: sql<number>`count(*)::int` })
      .from(drawingSnapshots)
      .where(eq(drawingSnapshots.snapshotRole, 'HISTORICAL'))
      .groupBy(drawingSnapshots.sourceWorkbook);
    const by = Object.fromEntries(rows.map((r) => [r.wb, r.n]));
    expect(by).toEqual({
      '0059_PoaRR_Residential_03YPlan_01012024.xlsm': 3284,
      '0059_PoaRR_Residential_03YPlan_01012025.xlsm': 11699,
      '0059_PoaRR_Tower08_03YPlan_01012024.xlsx': 1528,
      '0059_PoaRR_Tower08_03YPlan_01012025.xlsm': 1434,
      '0059_PoaRR_Commercial_03YPlan.xlsx': 572,
    });
  });

  it('holds 112 number conflicts and 5 ACC-only numbers back as OPEN conflicts, not drawings', async () => {
    const rows = await db
      .select({ t: drawingConflicts.conflictType, n: sql<number>`count(*)::int` })
      .from(drawingConflicts)
      .where(eq(drawingConflicts.status, 'OPEN'))
      .groupBy(drawingConflicts.conflictType);
    expect(Object.fromEntries(rows.map((r) => [r.t, r.n]))).toEqual({ NUMBER_TITLE_CONFLICT: 112, ACC_ONLY_NUMBER: 5 });
    // A same-number/different-title pair in the current T09 register is held back.
    const [c] = await db.select().from(drawingConflicts).where(eq(drawingConflicts.drawingNumber, 'HVAC-T09-1112'));
    expect(c.conflictType).toBe('NUMBER_TITLE_CONFLICT');
    expect(c.candidateCount).toBeGreaterThanOrEqual(2);
    const held = await db.select().from(drawings).where(and(eq(drawings.projectId, ids['POARR-T09']), eq(drawings.drawingCode, 'HVAC-T09-1112')));
    expect(held).toHaveLength(0);
    // A-T9-4804 is used for doors D02A and D02C in the Commercial plan: flagged,
    // never merged. The current register (one row, D02A) is the drawing; the
    // D02C row is preserved as an unlinked historical snapshot.
    const dw = await db.select().from(drawings).where(and(eq(drawings.projectId, ids['POARR-T09']), eq(drawings.drawingCode, 'A-T9-4804')));
    expect(dw).toHaveLength(1);
    expect(dw[0].drawingName).toBe('DOOR DETAILS - D02A');
    const flagged = await db
      .select()
      .from(drawingImportIssues)
      .where(and(eq(drawingImportIssues.batchId, applied.batchId), eq(drawingImportIssues.code, 'NUMBER_TITLE_CONFLICT_HISTORICAL'), eq(drawingImportIssues.drawingNumber, 'A-T9-4804')));
    expect(flagged).toHaveLength(1);
    const d02c = await db
      .select()
      .from(drawingSnapshots)
      .where(and(eq(drawingSnapshots.drawingNumber, 'A-T9-4804'), eq(drawingSnapshots.title, 'DOOR DETAILS - D02C')));
    expect(d02c).toHaveLength(1);
    expect(d02c[0].drawingId).toBeNull();
    const acc = await db.select().from(drawingConflicts).where(eq(drawingConflicts.drawingNumber, '5-T09-BM1204'));
    expect(acc[0]?.conflictType).toBe('ACC_ONLY_NUMBER');
    const issues = await db
      .select({ code: drawingImportIssues.code, n: sql<number>`count(*)::int` })
      .from(drawingImportIssues)
      .where(eq(drawingImportIssues.batchId, applied.batchId))
      .groupBy(drawingImportIssues.code);
    const byCode = Object.fromEntries(issues.map((i) => [i.code, i.n]));
    expect(byCode.NUMBER_TITLE_CONFLICT).toBe(112);
    expect(byCode.ACC_ONLY_NUMBER).toBe(5);
    expect(byCode.REVISION_REGRESSION).toBeGreaterThan(0);
    expect(byCode.UNMAPPED_DRAWING_LOCATION).toBeGreaterThan(0);
  });

  it('identity is project + drawing number: a re-issue in a later batch is one drawing', async () => {
    const dups = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(drawings)
      .groupBy(drawings.projectId, drawings.drawingCode)
      .having(sql`count(*) > 1`);
    expect(dups).toEqual([]);
    // S-T08-CL0003 is listed in BB01-1 and BB01-2 — one drawing, both listings kept as snapshots.
    const d = await db.select().from(drawings).where(and(eq(drawings.projectId, ids['POARR-T08']), eq(drawings.drawingCode, 'S-T08-CL0003')));
    expect(d).toHaveLength(1);
    const snaps = await db
      .select()
      .from(drawingSnapshots)
      .where(and(eq(drawingSnapshots.drawingId, d[0].id), eq(drawingSnapshots.snapshotRole, 'CURRENT')));
    expect(new Set(snaps.map((s) => s.batchCode)).size).toBeGreaterThanOrEqual(2);
  });

  it('keeps not-yet-numbered drawings with project, phase, discipline, batch, title, dates and source', async () => {
    const rows = await db
      .select()
      .from(drawings)
      .where(and(eq(drawings.numberStatus, 'NOT_YET_NUMBERED'), eq(drawings.projectId, ids['POARR-T08'])))
      .limit(50);
    expect(rows.length).toBe(50);
    for (const r of rows) {
      expect(r.drawingNumber).toBeNull();
      expect(r.drawingName.length).toBeGreaterThan(0);
      expect(r.disciplineId).not.toBeNull();
      expect(r.phaseId).not.toBeNull(); // T08 → T08
      expect(r.sourceWorkbook).toMatch(/Tower08_03YPlan_01012026/);
      expect(r.sourceKey).toMatch(/^NYN:/);
    }
  });

  it('released without an actual date: COMPLETED, date NULL, evidence recorded — never an invented date', async () => {
    const [noDate] = await db
      .select({
        n: sql<number>`count(*)::int`,
        withEvidence: sql<number>`count(${drawings.releaseEvidence})::int`,
      })
      .from(drawings)
      .where(and(eq(drawings.completionStatus, 'COMPLETED'), isNull(drawings.actualReleaseDate), inArray(drawings.projectId, Object.values(ids))));
    expect(noDate.n).toBe(13788 - 1404);
    expect(noDate.withEvidence).toBe(noDate.n);
    const [sample] = await db
      .select()
      .from(drawings)
      .where(and(eq(drawings.projectId, ids['POARR-RES']), eq(drawings.releaseEvidence, 'Issued before 01-Jan-2026')))
      .limit(1);
    expect(sample.completionStatus).toBe('COMPLETED');
    expect(sample.actualReleaseDate).toBeNull();
    // Residential / Tower08 carry no actual dates at all (quarter-ends, snapshot and import dates are not dates of release).
    const [resDates] = await db
      .select({ n: sql<number>`count(${drawings.actualReleaseDate})::int` })
      .from(drawings)
      .where(inArray(drawings.projectId, [ids['POARR-RES'], ids['POARR-T08']]));
    expect(resDates.n).toBe(0);
  });

  it('T09: actual dates come from ACC "Date of Release", never from "Created at"', async () => {
    const rows = await db
      .select()
      .from(drawings)
      .where(and(eq(drawings.projectId, ids['POARR-T09']), isNotNull(drawings.actualReleaseDate)));
    expect(rows).toHaveLength(1404);
    // Every actual date equals the ACC "Date of Release" of the drawing's ACC row.
    const acc = await db
      .select({ drawingId: drawingSnapshots.drawingId, rel: drawingSnapshots.accReleaseDate, created: drawingSnapshots.accCreatedAt })
      .from(drawingSnapshots)
      .where(and(eq(drawingSnapshots.sourceKind, 'ACC'), isNotNull(drawingSnapshots.drawingId)));
    const relOf = new Map(acc.map((a) => [a.drawingId, a.rel?.toISOString()]));
    const wrong = rows.filter((r) => relOf.get(r.id) !== r.actualReleaseDate!.toISOString());
    expect(wrong.map((r) => r.drawingCode)).toEqual([]);
    // "Created at" is a bulk-upload time: it is stored, but it is not what the actual date came from.
    const createdOnly = acc.filter((a) => !a.rel && a.created);
    expect(createdOnly).toEqual([]);
    for (const r of rows.slice(0, 100)) {
      expect(r.releaseEvidence).toMatch(/^ACC release /);
      expect(r.collection).not.toBeNull();
      expect(r.versionCount).toBeGreaterThanOrEqual(1);
    }
  });

  it('maps phases only through the explicit location → phase table', async () => {
    const [t08Phase] = await db
      .select()
      .from(projectPhases)
      .where(and(eq(projectPhases.projectId, ids['POARR-T08']), eq(projectPhases.code, 'T08')));
    const [t08] = await db
      .select({ n: sql<number>`count(*)::int`, withPhase: sql<number>`count(*) filter (where ${drawings.phaseId} = ${t08Phase.id})::int` })
      .from(drawings)
      .where(eq(drawings.projectId, ids['POARR-T08']));
    expect(t08.withPhase).toBe(t08.n);
    const [t09] = await db
      .select({ n: sql<number>`count(${drawings.phaseId})::int` })
      .from(drawings)
      .where(eq(drawings.projectId, ids['POARR-T09']));
    expect(t09.n).toBe(0);
    const map = await db.select().from(drawingLocationPhaseMap).where(eq(drawingLocationPhaseMap.projectId, ids['POARR-RES']));
    expect(map.length).toBeGreaterThan(40);
    // Every Residential drawing with a phase got it from a map row for its location.
    const orphan = await db.execute(sql`
      select count(*)::int as n from drawings d
       where d.project_id = ${ids['POARR-RES']} and d.phase_id is not null
         and not exists (select 1 from drawing_location_phase_map m
                          where m.project_id = d.project_id and m.location_code = d.location and m.phase_id = d.phase_id)`);
    expect(Number((orphan.rows[0] as { n: number }).n)).toBe(0);
  });

  it('records revision history and plan moves between snapshots', async () => {
    const [rev] = await db.select({ n: sql<number>`count(*)::int` }).from(drawingRevisions);
    expect(rev.n).toBe(applied.counts.revisions);
    const [moves] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(rescheduleHistory)
      .where(and(eq(rescheduleHistory.entityType, 'DRAWING'), eq(rescheduleHistory.scope, 'IMPORT')));
    expect(moves.n).toBe(applied.counts.planMoves);
    // A drawing's baseline is its earliest plan; history never rewrites it.
    const [bad] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(drawings)
      .where(sql`${drawings.baselineReleaseDate} is not null and ${drawings.rescheduleCount} = 0 and ${drawings.baselineReleaseDate} <> ${drawings.currentExpectedReleaseDate}`);
    expect(bad.n).toBe(0);
  });

  it('computes schedule status in SQL exactly as assessSchedule() does (null when released without a date)', async () => {
    const rows = await db
      .select({
        completionStatus: drawings.completionStatus,
        baselineReleaseDate: drawings.baselineReleaseDate,
        currentExpectedReleaseDate: drawings.currentExpectedReleaseDate,
        actualReleaseDate: drawings.actualReleaseDate,
        rescheduleCount: drawings.rescheduleCount,
        status: drawingScheduleStatusSql(),
      })
      .from(drawings);
    const mismatches = rows.filter((r) => (assessDrawing(r)?.status ?? null) !== r.status);
    expect(mismatches.slice(0, 5)).toEqual([]);
    expect(rows.some((r) => r.status === null)).toBe(true);
    expect(rows.some((r) => r.status === 'DELAYED')).toBe(true);
  });

  it('is idempotent: a second import changes nothing and duplicates nothing', async () => {
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(drawings);
    const [revBefore] = await db.select({ n: sql<number>`count(*)::int` }).from(drawingRevisions);
    const [histBefore] = await db.select({ n: sql<number>`count(*)::int` }).from(rescheduleHistory);
    const again = await runDrawingImport({ manifestPath: MANIFEST, apply: true, actor });
    expect(again.applied!.created).toBe(0);
    expect(again.applied!.updated).toBe(0);
    expect(again.applied!.unchanged).toBe(14426);
    expect(await db.select({ n: sql<number>`count(*)::int` }).from(drawings)).toEqual(before);
    const [revAfter] = await db.select({ n: sql<number>`count(*)::int` }).from(drawingRevisions);
    const [histAfter] = await db.select({ n: sql<number>`count(*)::int` }).from(rescheduleHistory);
    expect(revAfter.n).toBe(revBefore.n);
    expect(histAfter.n).toBe(histBefore.n);
  }, 300_000);

  it('left the Violet Hill drawings exactly as they were', async () => {
    const [vh] = await db.select().from(projects).where(eq(projects.projectCode, 'VIOLET-HILL'));
    const rows = await db.select().from(drawings).where(eq(drawings.projectId, vh.id));
    expect(rows.length).toBeGreaterThan(80);
    expect(rows.every((r) => r.sourceKey == null && r.importBatchId == null)).toBe(true);
  });
});
