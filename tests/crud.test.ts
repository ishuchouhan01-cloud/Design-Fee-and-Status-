import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { auditLog, deliverables, drawings, goals, projects } from '@/db/schema';
import { applyBulk, createGoal, setCompletion, updateEntity } from '@/lib/services/updates';
import { queryDeliverables, queryDrawings, queryGoals } from '@/lib/services/queries';
import { auditForEntity } from '@/lib/audit';
import { deliverableUpdateSchema, drawingUpdateSchema, goalUpdateSchema, rejectForbiddenFields } from '@/lib/validation';
import { assessSchedule } from '@/lib/schedule';

const actor = { id: null, label: 'Test user (ADMIN)' };

async function anyOpenDeliverable() {
  const [row] = await db
    .select()
    .from(deliverables)
    .where(eq(deliverables.completionStatus, 'NOT_COMPLETED'))
    .limit(1);
  return row;
}

describe('goal CRUD', () => {
  it('creates a goal with an immutable baseline set from the quarter end', async () => {
    const [project] = await db.select().from(projects).limit(1);
    const { id } = await createGoal(
      {
        projectId: project.id,
        goalDescription: 'TEST — LoD 350 sample goal',
        fiscalYear: 'FY26-27',
        quarter: 3,
        plannedQuantity: 40,
        plannedValue: 1.25,
        priority: 'HIGH',
      },
      actor,
    );
    const [g] = await db.select().from(goals).where(eq(goals.id, id)).limit(1);
    expect(g.baselineTargetDate.toISOString().slice(0, 10)).toBe('2026-12-31');
    expect(g.currentExpectedDate.toISOString()).toBe(g.baselineTargetDate.toISOString());
    expect(g.completionStatus).toBe('NOT_COMPLETED');
    expect(g.plannedQuantity).toBe(40);
    const audit = await auditForEntity('GOAL', id);
    expect(audit.some((a) => a.action === 'CREATE')).toBe(true);
  });

  it('updates a goal and audits each changed field', async () => {
    const [g] = await db.select().from(goals).where(eq(goals.plannedQuantity, 40)).limit(1);
    const res = await updateEntity(
      'GOAL',
      g.id,
      { plannedQuantity: 45, remarks: 'Scope increased after client review' },
      actor,
      'Client added a block',
    );
    expect(res.changes.map((c) => c.field).sort()).toEqual(['plannedQuantity', 'remarks']);
    const audit = await auditForEntity('GOAL', g.id);
    expect(audit.filter((a) => a.field === 'plannedQuantity')[0].newValue).toBe('45');
    expect(audit.filter((a) => a.field === 'plannedQuantity')[0].reason).toBe('Client added a block');
  });

  it('refuses to change the baseline target date', async () => {
    const [g] = await db.select().from(goals).limit(1);
    await expect(
      updateEntity('GOAL', g.id, { baselineTargetDate: new Date() }, actor),
    ).rejects.toThrow(/immutable/i);
  });

  it('rejects a percentage or baseline field at the validation boundary', () => {
    expect(() => rejectForbiddenFields({ completionPercent: 65 })).toThrow(/percentages do not exist/i);
    expect(() => rejectForbiddenFields({ baselineReleaseDate: '2026-01-01' })).toThrow(/immutable/i);
    expect(goalUpdateSchema.safeParse({ completionStatus: 'IN_PROGRESS' }).success).toBe(false);
    expect(deliverableUpdateSchema.safeParse({ completionStatus: 'IN_PROGRESS' }).success).toBe(false);
    expect(drawingUpdateSchema.safeParse({ completionStatus: 'PARTIAL' }).success).toBe(false);
    expect(deliverableUpdateSchema.safeParse({ completionStatus: 'COMPLETED' }).success).toBe(true);
  });
});

describe('deliverable and drawing completion', () => {
  it('marking completed sets the actual date to today and calculates the schedule status', async () => {
    const row = await anyOpenDeliverable();
    const res = await setCompletion('DELIVERABLE', row.id, 'COMPLETED', actor, { reason: 'Released to site' });
    expect(res.changes.some((c) => c.field === 'completionStatus' && c.newValue === 'COMPLETED')).toBe(true);
    const [after] = await db.select().from(deliverables).where(eq(deliverables.id, row.id)).limit(1);
    expect(after.completionStatus).toBe('COMPLETED');
    expect(after.actualReleaseDate).not.toBeNull();
    expect(after.baselineReleaseDate.toISOString()).toBe(row.baselineReleaseDate.toISOString());
    const a = assessSchedule({
      completionStatus: after.completionStatus,
      baselineDate: after.baselineReleaseDate,
      expectedDate: after.currentExpectedReleaseDate,
      actualDate: after.actualReleaseDate,
    });
    expect(['COMPLETED_ON_TIME', 'COMPLETED_LATE']).toContain(a.status);
    const audit = await auditForEntity('DELIVERABLE', row.id);
    expect(audit.some((x) => x.action === 'COMPLETE')).toBe(true);
  });

  it('marking not completed clears the actual date and audits the correction', async () => {
    const [row] = await db
      .select()
      .from(deliverables)
      .where(eq(deliverables.completionStatus, 'COMPLETED'))
      .limit(1);
    await setCompletion('DELIVERABLE', row.id, 'NOT_COMPLETED', actor, { reason: 'Marked complete in error' });
    const [after] = await db.select().from(deliverables).where(eq(deliverables.id, row.id)).limit(1);
    expect(after.completionStatus).toBe('NOT_COMPLETED');
    expect(after.actualReleaseDate).toBeNull();
    const audit = await auditForEntity('DELIVERABLE', row.id);
    expect(audit.some((x) => x.action === 'UNCOMPLETE')).toBe(true);
  });

  it('marking a drawing completed accepts an explicit actual release date', async () => {
    const [row] = await db.select().from(drawings).limit(1);
    await setCompletion('DRAWING', row.id, 'COMPLETED', actor, {
      actualDate: new Date(Date.UTC(2026, 6, 4)),
      reason: 'Issued GFC',
    });
    const [after] = await db.select().from(drawings).where(eq(drawings.id, row.id)).limit(1);
    expect(after.actualReleaseDate?.toISOString().slice(0, 10)).toBe('2026-07-04');
  });

  it('updates revision and remarks without touching dates', async () => {
    const [row] = await db.select().from(drawings).limit(1);
    const res = await updateEntity('DRAWING', row.id, { revision: 'R7', remarks: 'Re-issued for coordination' }, actor);
    expect(res.changes.length).toBe(2);
    const [after] = await db.select().from(drawings).where(eq(drawings.id, row.id)).limit(1);
    expect(after.revision).toBe('R7');
    expect(after.baselineReleaseDate?.toISOString()).toBe(row.baselineReleaseDate?.toISOString());
  });
});

describe('bulk update', () => {
  it('validates the whole request before writing anything', async () => {
    const rows = await db.select().from(deliverables).limit(3);
    const res = await applyBulk(
      { entityType: 'DELIVERABLE', ids: rows.map((r) => r.id), action: 'CHANGE_EXPECTED_DATE' },
      actor,
    );
    expect(res.validation.length).toBeGreaterThan(0);
    expect(res.applied).toBe(0);
  });

  it('marks a selection completed and reports unchanged rows separately', async () => {
    const rows = await db
      .select()
      .from(deliverables)
      .where(eq(deliverables.completionStatus, 'NOT_COMPLETED'))
      .limit(5);
    const ids = rows.map((r) => r.id);
    const first = await applyBulk(
      { entityType: 'DELIVERABLE', ids, action: 'MARK_COMPLETED', reason: 'Batch released' },
      actor,
    );
    expect(first.applied).toBe(ids.length);
    const second = await applyBulk({ entityType: 'DELIVERABLE', ids, action: 'MARK_COMPLETED' }, actor);
    expect(second.applied).toBe(0);
    expect(second.unchanged).toBe(ids.length);
    // put them back
    await applyBulk({ entityType: 'DELIVERABLE', ids, action: 'MARK_NOT_COMPLETED', reason: 'test cleanup' }, actor);
  });

  it('reports records that do not exist rather than failing the batch', async () => {
    const [row] = await db.select().from(deliverables).limit(1);
    const res = await applyBulk(
      { entityType: 'DELIVERABLE', ids: [row.id, 'does-not-exist'], action: 'ADD_REMARK', remark: 'bulk note' },
      actor,
    );
    expect(res.rejected.map((r) => r.id)).toContain('does-not-exist');
    expect(res.applied).toBe(1);
  });

  it('appends remarks rather than replacing them', async () => {
    const [row] = await db.select().from(deliverables).limit(1);
    const before = row.remarks ?? '';
    await applyBulk({ entityType: 'DELIVERABLE', ids: [row.id], action: 'ADD_REMARK', remark: 'second note' }, actor);
    const [after] = await db.select().from(deliverables).where(eq(deliverables.id, row.id)).limit(1);
    expect(after.remarks).toContain('second note');
    if (before) expect(after.remarks).toContain(before);
  });
});

describe('filtering, sorting and paging happen in SQL', () => {
  it('filters goals by project, period and completion', async () => {
    const [project] = await db
      .select({ id: goals.projectId, n: sql<number>`count(*)::int` })
      .from(goals)
      .groupBy(goals.projectId)
      .orderBy(sql`count(*) desc`)
      .limit(1);
    const res = await queryGoals({ projectId: project.id, fiscalYear: 'FY26-27', pageSize: 10, page: 1 });
    expect(res.rows.length).toBeLessThanOrEqual(10);
    expect(res.rows.every((r) => r.projectId === project.id)).toBe(true);
    expect(res.rows.every((r) => r.fiscalYear === 'FY26-27')).toBe(true);
    const open = await queryGoals({ completion: 'NOT_COMPLETED', pageSize: 20 });
    expect(open.rows.every((r) => r.completionStatus === 'NOT_COMPLETED')).toBe(true);
  });

  it('pages consistently and reports a total independent of the page', async () => {
    const p1 = await queryDrawings({ page: 1, pageSize: 10, sort: 'code', dir: 'asc' });
    const p2 = await queryDrawings({ page: 2, pageSize: 10, sort: 'code', dir: 'asc' });
    expect(p1.total).toBe(p2.total);
    expect(p1.rows.map((r) => r.id)).not.toEqual(p2.rows.map((r) => r.id));
    expect(p1.pageCount).toBe(Math.ceil(p1.total / 10));
  });

  it('searches across code, description and project name', async () => {
    const res = await queryDrawings({ search: 'MASTER PLAN', pageSize: 20 });
    expect(res.total).toBeGreaterThan(0);
    expect(
      res.rows.every(
        (r) =>
          /master plan/i.test(r.drawingName) ||
          /master plan/i.test(r.drawingCode) ||
          /master plan/i.test(r.areaOfWorks ?? '') ||
          /master plan/i.test(r.projectName ?? ''),
      ),
    ).toBe(true);
  });

  it('filters deliverables by schedule status', async () => {
    const res = await queryDeliverables({ scheduleStatus: 'DELAYED', pageSize: 50 });
    expect(res.rows.every((r) => r.schedule.status === 'DELAYED')).toBe(true);
  });

  it('sorts ascending and descending', async () => {
    const asc = await queryDrawings({ sort: 'code', dir: 'asc', pageSize: 5 });
    const desc = await queryDrawings({ sort: 'code', dir: 'desc', pageSize: 5 });
    expect(asc.rows[0].drawingCode <= asc.rows[asc.rows.length - 1].drawingCode).toBe(true);
    expect(desc.rows[0].drawingCode >= desc.rows[desc.rows.length - 1].drawingCode).toBe(true);
  });
});

describe('audit log', () => {
  it('records who, what, from, to, when and why', async () => {
    const [row] = await db.select().from(drawings).limit(1);
    await updateEntity('DRAWING', row.id, { remarks: 'audit shape check' }, actor, 'because the test says so');
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'DRAWING'), eq(auditLog.entityId, row.id), eq(auditLog.field, 'remarks')))
      .orderBy(sql`${auditLog.timestamp} desc`)
      .limit(1);
    expect(entry.userLabel).toBe(actor.label);
    expect(entry.action).toBe('UPDATE');
    expect(entry.newValue).toBe('audit shape check');
    expect(entry.reason).toBe('because the test says so');
    expect(entry.timestamp).toBeInstanceOf(Date);
    expect(entry.projectId).toBe(row.projectId);
  });

  it('writes nothing when a patch changes nothing', async () => {
    const [row] = await db.select().from(drawings).limit(1);
    const before = (await auditForEntity('DRAWING', row.id, 500)).length;
    const res = await updateEntity('DRAWING', row.id, { revision: row.revision }, actor);
    expect(res.changes).toEqual([]);
    const after = (await auditForEntity('DRAWING', row.id, 500)).length;
    expect(after).toBe(before);
  });
});
