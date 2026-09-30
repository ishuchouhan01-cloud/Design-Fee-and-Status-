/**
 * Drawing Control workflows: add, number assignment, release, revisions,
 * department dependencies, rescheduling through the engine, edit protection
 * on re-import (PoaRR and Violet Hill), conflict resolution and the fixed
 * defects. Runs after drawings-a-import (the PoaRR register is in place).
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  auditLog,
  dependencies,
  drawingConflicts,
  drawingDependencies,
  drawingImportIssues,
  drawingRevisions,
  drawings,
  projects,
  rescheduleHistory,
} from '@/db/schema';
import { runDrawingImport } from '@/lib/import/drawing-register';
import { applyReschedule } from '@/lib/reschedule';
import { resolveScopeIds } from '@/lib/repo/entities';
import {
  addDrawingDependency,
  addRevision,
  createDrawing,
  deleteDrawing,
  deleteDrawingDependency,
  releaseDrawing,
  resolveConflict,
  updateDrawing,
  updateDrawingDependency,
} from '@/lib/services/drawing-control';
import { drawingKpis, drawingLookAhead, listDrawings } from '@/lib/services/drawing-register';
import { queryDrawings } from '@/lib/services/queries';
import { applyBulk } from '@/lib/services/updates';
import { addDays, startOfDay } from '@/lib/periods';

const MANIFEST = path.resolve(process.cwd(), 'data/drawing-sources/poarr.json');
const available = fs.existsSync(MANIFEST);
const actor = { id: null, label: 'Drawing tester (EDITOR)' };

async function project(code: string) {
  const [p] = await db.select().from(projects).where(eq(projects.projectCode, code)).limit(1);
  return p;
}

async function one(id: string) {
  const [d] = await db.select().from(drawings).where(eq(drawings.id, id)).limit(1);
  return d;
}

async function auditActions(id: string) {
  const rows = await db.select().from(auditLog).where(and(eq(auditLog.entityType, 'DRAWING'), eq(auditLog.entityId, id)));
  return rows.map((r) => r.action);
}

describe.skipIf(!available)('Drawing Control', () => {
  let t08: Awaited<ReturnType<typeof project>>;
  beforeAll(async () => {
    t08 = await project('POARR-T08');
  });

  describe('add drawing and number assignment', () => {
    it('adds a not-yet-numbered drawing: NOT RELEASED, no actual date, audited', async () => {
      const { id, drawingCode } = await createDrawing(
        { projectId: t08.id, drawingName: 'TEST — Lift lobby ceiling detail', batchCode: 'BB01-9', expectedReleaseDate: addDays(startOfDay(new Date()), 30) },
        actor,
      );
      const d = await one(id);
      expect(d.numberStatus).toBe('NOT_YET_NUMBERED');
      expect(drawingCode).toMatch(/^NYN-M-/);
      expect(d.completionStatus).toBe('NOT_COMPLETED');
      expect(d.actualReleaseDate).toBeNull();
      expect(d.baselineReleaseDate?.toISOString()).toBe(d.currentExpectedReleaseDate?.toISOString());
      expect(d.isManual).toBe(true);
      expect(await auditActions(id)).toContain('CREATE_DRAWING');
    });

    it('assigning a number updates the same record — it does not create a second drawing', async () => {
      const [nyn] = await db
        .select()
        .from(drawings)
        .where(and(eq(drawings.projectId, t08.id), eq(drawings.numberStatus, 'NOT_YET_NUMBERED'), eq(drawings.isManual, false)))
        .limit(1);
      const before = await db.select({ n: sql<number>`count(*)::int` }).from(drawings);
      await updateDrawing(nyn.id, { drawingNumber: 'A-T8-TEST-0001' }, actor, 'Number assigned');
      const after = await one(nyn.id);
      expect(after.drawingCode).toBe('A-T8-TEST-0001');
      expect(after.drawingNumber).toBe('A-T8-TEST-0001');
      expect(after.numberStatus).toBe('NUMBERED');
      expect(after.sourceKey).toBe(nyn.sourceKey); // the import key is kept
      expect(await db.select({ n: sql<number>`count(*)::int` }).from(drawings)).toEqual(before);
      expect(await auditActions(nyn.id)).toContain('UPDATE_DRAWING');
    });

    it('refuses a number that already exists in the project', async () => {
      const [a, b] = await db.select().from(drawings).where(and(eq(drawings.projectId, t08.id), eq(drawings.numberStatus, 'NUMBERED'))).limit(2);
      await expect(updateDrawing(b.id, { drawingNumber: a.drawingCode }, actor)).rejects.toThrow(/already exists/);
    });

    it('never writes the expected date, release, revision or baseline through an edit', async () => {
      const [d] = await db.select().from(drawings).where(eq(drawings.projectId, t08.id)).limit(1);
      await expect(updateDrawing(d.id, { currentExpectedReleaseDate: new Date() } as never, actor)).rejects.toThrow(/Reschedule/);
      await expect(updateDrawing(d.id, { completionStatus: 'COMPLETED' } as never, actor)).rejects.toThrow(/Mark as Released/);
      await expect(updateDrawing(d.id, { revision: 'R9' } as never, actor)).rejects.toThrow(/Add Revision/);
      await expect(updateDrawing(d.id, { baselineReleaseDate: new Date() } as never, actor)).rejects.toThrow(/immutable/);
    });
  });

  describe('release and revisions', () => {
    let id: string;
    beforeAll(async () => {
      const [d] = await db
        .select()
        .from(drawings)
        .where(and(eq(drawings.projectId, t08.id), eq(drawings.completionStatus, 'NOT_COMPLETED'), eq(drawings.numberStatus, 'NUMBERED')))
        .limit(1);
      id = d.id;
    });

    it('Mark as Released records the actual date, who, the revision row and a RELEASE_DRAWING audit', async () => {
      const before = await one(id);
      const date = startOfDay(new Date());
      await releaseDrawing(id, { actualReleaseDate: date, remarks: 'Issued for construction' }, actor);
      const d = await one(id);
      expect(d.completionStatus).toBe('COMPLETED');
      expect(d.actualReleaseDate?.toISOString()).toBe(date.toISOString());
      expect(d.releasedByLabel).toBe(actor.label);
      expect(d.releasedAt).toBeInstanceOf(Date);
      expect(d.baselineReleaseDate?.toISOString()).toBe(before.baselineReleaseDate?.toISOString());
      const revs = await db.select().from(drawingRevisions).where(eq(drawingRevisions.drawingId, id));
      const cur = revs.find((r) => r.revision === d.revision);
      expect(cur?.completionStatus).toBe('COMPLETED');
      expect(cur?.releasedByLabel).toBe(actor.label);
      expect(await auditActions(id)).toContain('RELEASE_DRAWING');
      expect(d.userEditedFields).toMatch(/completionStatus/);
    });

    it('refuses a future release date and a second release of the same revision', async () => {
      await expect(releaseDrawing(id, { actualReleaseDate: addDays(new Date(), 3) }, actor)).rejects.toThrow(/future/);
      await expect(releaseDrawing(id, { actualReleaseDate: new Date() }, actor)).rejects.toThrow(/already RELEASED/);
    });

    it('Add Revision keeps every earlier revision and makes the new one current', async () => {
      const before = await one(id);
      const revsBefore = await db.select().from(drawingRevisions).where(eq(drawingRevisions.drawingId, id));
      const next = `R${(Number(/\d+/.exec(before.revision ?? 'R0')?.[0] ?? 0) + 1)}`;
      await addRevision(id, { revision: next, remarks: 'Client comments' }, actor);
      const d = await one(id);
      expect(d.revision).toBe(next);
      expect(d.completionStatus).toBe('COMPLETED'); // the drawing was released; the new revision is pending
      const revs = await db.select().from(drawingRevisions).where(eq(drawingRevisions.drawingId, id));
      expect(revs.length).toBe(revsBefore.length + 1);
      for (const r of revsBefore) {
        const still = revs.find((x) => x.id === r.id)!;
        expect(still.revision).toBe(r.revision);
        expect(still.completionStatus).toBe(r.completionStatus);
      }
      expect(revs.find((r) => r.revision === next)?.completionStatus).toBe('NOT_COMPLETED');
      await expect(addRevision(id, { revision: next }, actor)).rejects.toThrow(/never overwritten/);
      expect(await auditActions(id)).toContain('CREATE_REVISION');
      // Releasing the new revision keeps the drawing's first actual release date.
      await releaseDrawing(id, { actualReleaseDate: new Date() }, actor);
      const after = await one(id);
      expect(after.actualReleaseDate?.toISOString()).toBe(d.actualReleaseDate?.toISOString());
      const [r2] = await db.select().from(drawingRevisions).where(and(eq(drawingRevisions.drawingId, id), eq(drawingRevisions.revision, next)));
      expect(r2.completionStatus).toBe('COMPLETED');
    });
  });

  describe('department dependencies', () => {
    it('adds, closes, reopens and deletes — each audited, separate from scheduling links', async () => {
      const [d] = await db.select().from(drawings).where(eq(drawings.projectId, t08.id)).limit(1);
      const linksBefore = await db.select({ n: sql<number>`count(*)::int` }).from(dependencies);
      const { id } = await addDrawingDependency(
        d.id,
        { department: 'PHE', description: 'Percolation pit location & size', targetDate: addDays(new Date(), 10), ownerText: 'PHE consultant' },
        actor,
      );
      let [dep] = await db.select().from(drawingDependencies).where(eq(drawingDependencies.id, id));
      expect(dep.status).toBe('OPEN');
      expect(dep.isManual).toBe(true);
      await updateDrawingDependency(id, { status: 'CLOSED' }, actor);
      [dep] = await db.select().from(drawingDependencies).where(eq(drawingDependencies.id, id));
      expect(dep.status).toBe('CLOSED');
      expect(dep.closureDate).toBeInstanceOf(Date);
      await updateDrawingDependency(id, { status: 'OPEN' }, actor);
      [dep] = await db.select().from(drawingDependencies).where(eq(drawingDependencies.id, id));
      expect(dep.status).toBe('OPEN');
      expect(dep.closureDate).toBeNull();
      await deleteDrawingDependency(id, actor);
      expect(await db.select().from(drawingDependencies).where(eq(drawingDependencies.id, id))).toHaveLength(0);
      const acts = await auditActions(d.id);
      for (const a of ['ADD_DEPENDENCY', 'UPDATE_DEPENDENCY', 'DELETE_DEPENDENCY']) expect(acts).toContain(a);
      expect(await db.select({ n: sql<number>`count(*)::int` }).from(dependencies)).toEqual(linksBefore);
    });
  });

  describe('rescheduling', () => {
    it('moves the expected date only through the engine: history, count, audit; baseline untouched', async () => {
      const [d] = await db
        .select()
        .from(drawings)
        .where(and(eq(drawings.projectId, t08.id), eq(drawings.completionStatus, 'NOT_COMPLETED'), sql`${drawings.currentExpectedReleaseDate} is not null`))
        .limit(1);
      const target = addDays(startOfDay(d.currentExpectedReleaseDate!), 21);
      const res = await applyReschedule(
        { entityType: 'DRAWING', entityIds: [d.id], newExpectedDate: target, reason: 'Structural input late', scope: 'ITEM' },
        actor,
      );
      expect(res.applied).toBe(1);
      const after = await one(d.id);
      expect(after.currentExpectedReleaseDate?.toISOString()).toBe(target.toISOString());
      expect(after.baselineReleaseDate?.toISOString()).toBe(d.baselineReleaseDate?.toISOString());
      expect(after.rescheduleCount).toBe(d.rescheduleCount + 1);
      expect(after.userEditedFields).toMatch(/currentExpectedReleaseDate/);
      const [h] = await db
        .select()
        .from(rescheduleHistory)
        .where(and(eq(rescheduleHistory.entityId, d.id), eq(rescheduleHistory.reason, 'Structural input late')));
      expect(h.daysShift).toBe(21);
      expect(await auditActions(d.id)).toContain('RESCHEDULE_DRAWING');
    });

    it('never moves a released drawing, even when its predecessor moves', async () => {
      const [pred] = await db
        .select()
        .from(drawings)
        .where(and(eq(drawings.projectId, t08.id), eq(drawings.completionStatus, 'NOT_COMPLETED'), sql`${drawings.currentExpectedReleaseDate} is not null`))
        .limit(1)
        .offset(3);
      const [succ] = await db
        .select()
        .from(drawings)
        .where(and(eq(drawings.projectId, t08.id), eq(drawings.completionStatus, 'COMPLETED'), sql`${drawings.currentExpectedReleaseDate} is not null`))
        .limit(1);
      await db.insert(dependencies).values({
        id: `dp_test_${Date.now()}`,
        predecessorType: 'DRAWING',
        predecessorId: pred.id,
        successorType: 'DRAWING',
        successorId: succ.id,
        dependencyType: 'FS',
        lagDays: 0,
      });
      const res = await applyReschedule(
        { entityType: 'DRAWING', entityIds: [pred.id], shiftDays: 120, reason: 'Big slip', scope: 'ITEM' },
        actor,
      );
      expect(res.impact.skipped.some((s) => s.entityId === succ.id)).toBe(true);
      const after = await one(succ.id);
      expect(after.currentExpectedReleaseDate?.toISOString()).toBe(succ.currentExpectedReleaseDate?.toISOString());
      expect(after.actualReleaseDate?.toISOString() ?? null).toBe(succ.actualReleaseDate?.toISOString() ?? null);
      await db.delete(dependencies).where(and(eq(dependencies.predecessorId, pred.id), eq(dependencies.successorId, succ.id)));
    });

    it('bulk expected-date changes go through the engine (history rows) and skip released drawings', async () => {
      const open = await db
        .select()
        .from(drawings)
        .where(and(eq(drawings.projectId, t08.id), eq(drawings.completionStatus, 'NOT_COMPLETED'), sql`${drawings.currentExpectedReleaseDate} is not null`))
        .limit(2)
        .offset(6);
      const [rel] = await db.select().from(drawings).where(and(eq(drawings.projectId, t08.id), eq(drawings.completionStatus, 'COMPLETED'))).limit(1);
      const date = addDays(startOfDay(new Date()), 45);
      const noReason = await applyBulk({ entityType: 'DRAWING', ids: open.map((o) => o.id), action: 'CHANGE_EXPECTED_DATE', expectedDate: date }, actor);
      expect(noReason.applied).toBe(0);
      expect(noReason.validation.join(' ')).toMatch(/reason/i);
      const res = await applyBulk(
        { entityType: 'DRAWING', ids: [...open.map((o) => o.id), rel.id], action: 'CHANGE_EXPECTED_DATE', expectedDate: date, reason: 'Bulk re-plan' },
        actor,
      );
      expect(res.applied).toBe(2);
      expect(res.rejected.map((r) => r.id)).toContain(rel.id);
      const hist = await db
        .select()
        .from(rescheduleHistory)
        .where(and(inArray(rescheduleHistory.entityId, open.map((o) => o.id)), eq(rescheduleHistory.reason, 'Bulk re-plan')));
      expect(hist).toHaveLength(2);
    });

    it('rejects reschedule scope GOAL for drawings with a clear message (no goal link exists)', async () => {
      await expect(resolveScopeIds({ type: 'DRAWING', scope: 'GOAL', ids: [], goalId: 'x' })).rejects.toThrow(/no goal link/);
    });
  });

  describe('register queries', () => {
    it('filters schedule status in SQL before paging, so totals match the pages', async () => {
      const f = { projectId: t08.id, scheduleStatus: 'DELAYED', pageSize: 7 };
      const p1 = await listDrawings({ ...f, page: 1 });
      expect(p1.total).toBeGreaterThan(7);
      expect(p1.rows).toHaveLength(7);
      expect(p1.rows.every((r) => r.scheduleStatus === 'DELAYED')).toBe(true);
      const all = await listDrawings({ ...f, pageSize: 500 });
      expect(all.rows.length).toBe(p1.total);
      const legacy = await queryDrawings({ projectId: t08.id, scheduleStatus: 'DELAYED', pageSize: 7 });
      expect(legacy.total).toBe(p1.total);
      expect(legacy.rows.every((r) => r.schedule.status === 'DELAYED')).toBe(true);
    });

    it('searches case-insensitively across number, title and batch', async () => {
      const a = await listDrawings({ search: 's-t08-cl0003' });
      expect(a.rows.some((r) => r.drawingCode === 'S-T08-CL0003')).toBe(true);
      const b = await listDrawings({ search: 'bb01-2', projectId: t08.id, pageSize: 5 });
      expect(b.total).toBeGreaterThan(0);
    });

    it('counts "released this week / month" from actual dates only', async () => {
      const k = await drawingKpis({});
      // The drawing released today in this file is counted; evidence-only releases never are.
      expect(k.releasedThisWeek).toBeGreaterThanOrEqual(1);
      expect(k.releasedThisMonth).toBeGreaterThanOrEqual(k.releasedThisWeek);
      const [withDate] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(drawings)
        .where(sql`${drawings.actualReleaseDate} >= date_trunc('month', now() at time zone 'UTC')`);
      expect(k.releasedThisMonth).toBe(withDate.n);
      expect(k.releaseDateNotRecorded).toBeGreaterThan(12000);
    });

    it('look-ahead lists NOT RELEASED drawings only, bucketed by current expected date', async () => {
      const la = await drawingLookAhead({});
      const rows = [...la.rows.OVERDUE, ...la.rows.THIS_WEEK, ...la.rows.NEXT_WEEK];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.completionStatus === 'NOT_COMPLETED')).toBe(true);
      const today = startOfDay(new Date());
      expect(la.rows.OVERDUE.every((r) => r.currentExpectedReleaseDate! < today)).toBe(true);
      expect(la.rows.THIS_WEEK.every((r) => r.currentExpectedReleaseDate! >= today)).toBe(true);
    });
  });

  describe('manual edits survive re-import', () => {
    it('keeps edited title, number and rescheduled date; logs FIELD_PROTECTED_USER_EDIT; no duplicates', async () => {
      const [d] = await db
        .select()
        .from(drawings)
        .where(and(eq(drawings.projectId, t08.id), eq(drawings.isManual, false), eq(drawings.completionStatus, 'NOT_COMPLETED'), eq(drawings.numberStatus, 'NUMBERED')))
        .limit(1)
        .offset(10);
      await updateDrawing(d.id, { drawingName: 'EDITED IN DRAWING CONTROL' }, actor, 'Title corrected');
      const count = await db.select({ n: sql<number>`count(*)::int` }).from(drawings);
      const res = await runDrawingImport({ manifestPath: MANIFEST, apply: true, actor });
      expect(res.valid).toBe(true);
      const after = await one(d.id);
      expect(after.drawingName).toBe('EDITED IN DRAWING CONTROL');
      const numbered = await db.select().from(drawings).where(eq(drawings.drawingCode, 'A-T8-TEST-0001'));
      expect(numbered).toHaveLength(1); // the user-assigned number survived, no NYN duplicate was created
      expect(await db.select({ n: sql<number>`count(*)::int` }).from(drawings)).toEqual(count);
      const issues = await db
        .select()
        .from(drawingImportIssues)
        .where(and(eq(drawingImportIssues.batchId, res.batchId), eq(drawingImportIssues.code, 'FIELD_PROTECTED_USER_EDIT')));
      expect(issues.some((i) => i.drawingNumber === d.drawingCode && /drawingName/.test(i.message))).toBe(true);
      // The rescheduled drawing kept its user date.
      const [moved] = await db
        .select()
        .from(drawings)
        .where(sql`position('currentExpectedReleaseDate' in ${drawings.userEditedFields}) > 0 and ${drawings.projectId} = ${t08.id} and not ${drawings.isManual}`)
        .limit(1);
      const hist = await db.select().from(rescheduleHistory).where(eq(rescheduleHistory.entityId, moved.id)).orderBy(desc(rescheduleHistory.changedAt)).limit(1);
      expect(moved.currentExpectedReleaseDate?.toISOString()).toBe(hist[0].newDate?.toISOString());
    }, 300_000);

    it('the Violet Hill importer keeps user-edited fields and logs FIELD_PROTECTED_USER_EDIT', async () => {
      const { ImportLogger } = await import('@/lib/import/logger');
      const { readWorkbook } = await import('@/lib/import/workbook');
      const { importProjectPlanWorkbook } = await import('@/lib/import/project-plan-workbook');
      const [vh] = await db.select().from(projects).where(eq(projects.projectCode, 'VIOLET-HILL'));
      const [d] = await db.select().from(drawings).where(eq(drawings.projectId, vh.id)).limit(1).offset(5);
      await updateDrawing(d.id, { drawingName: 'VH TITLE EDITED BY USER' }, actor);
      const log = new ImportLogger();
      await importProjectPlanWorkbook(readWorkbook(path.resolve(process.cwd(), process.env.EXCEL_PROJECT_PLAN_WORKBOOKS!)), log);
      const after = await one(d.id);
      expect(after.drawingName).toBe('VH TITLE EDITED BY USER');
      expect(log.issues.some((i) => i.code === 'FIELD_PROTECTED_USER_EDIT' && i.message.includes(d.drawingCode))).toBe(true);
      const vhCount = await db.select({ n: sql<number>`count(*)::int` }).from(drawings).where(eq(drawings.projectId, vh.id));
      expect(vhCount[0].n).toBeGreaterThan(80);
    }, 300_000);
  });

  describe('admin: conflicts and delete', () => {
    it('resolving a conflict creates the chosen drawing once; later imports respect it', async () => {
      const [c] = await db.select().from(drawingConflicts).where(and(eq(drawingConflicts.drawingNumber, 'HVAC-T09-1112'), eq(drawingConflicts.status, 'OPEN')));
      const { id } = await resolveConflict(c.id, { candidateIndex: 0, note: 'Checked with MEP lead' }, actor);
      const d = await one(id);
      expect(d.drawingCode).toBe('HVAC-T09-1112');
      const [after] = await db.select().from(drawingConflicts).where(eq(drawingConflicts.id, c.id));
      expect(after.status).toBe('RESOLVED');
      expect(after.resolvedDrawingId).toBe(id);
      await expect(resolveConflict(c.id, { candidateIndex: 1, note: 'again' }, actor)).rejects.toThrow(/already RESOLVED/);
      const res = await runDrawingImport({ manifestPath: MANIFEST, apply: true, actor });
      expect(res.valid).toBe(true);
      expect(res.applied!.conflictsResolved).toBe(1);
      expect(await db.select().from(drawings).where(eq(drawings.drawingCode, 'HVAC-T09-1112'))).toHaveLength(1);
      expect(await auditActions(id)).toContain('RESOLVE_CONFLICT');
    }, 300_000);

    it('deletes only manually added, never-released drawings', async () => {
      const [imported] = await db.select().from(drawings).where(and(eq(drawings.projectId, t08.id), eq(drawings.isManual, false))).limit(1);
      await expect(deleteDrawing(imported.id, 'test', actor)).rejects.toThrow(/Imported drawings cannot be deleted/);
      const [manual] = await db.select().from(drawings).where(and(eq(drawings.isManual, true), eq(drawings.completionStatus, 'NOT_COMPLETED'), isNull(drawings.actualReleaseDate))).limit(1);
      await deleteDrawing(manual.id, 'Added in error', actor);
      expect(await one(manual.id)).toBeUndefined();
      const [a] = await db.select().from(auditLog).where(and(eq(auditLog.entityId, manual.id), eq(auditLog.action, 'DELETE_DRAWING')));
      expect(a.reason).toBe('Added in error');
    });
  });
});
