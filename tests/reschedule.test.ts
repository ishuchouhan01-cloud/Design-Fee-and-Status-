import { describe, expect, it, beforeAll } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { deliverables, dependencies, goals, packages, projects, rescheduleHistory } from '@/db/schema';
import { applyReschedule, previewReschedule } from '@/lib/reschedule';
import { setCompletion } from '@/lib/services/updates';
import { newId } from '@/lib/ids';
import { addDays, diffDays, utc } from '@/lib/periods';
import { auditForEntity } from '@/lib/audit';
import { resolveScopeIds } from '@/lib/repo/entities';

const actor = { id: null, label: 'Test manager (MANAGER)' };

let projectId: string;
let chain: { id: string; code: string; expected: Date }[] = [];

beforeAll(async () => {
  const [vh] = await db.select().from(projects).where(eq(projects.projectCode, 'VIOLET-HILL')).limit(1);
  projectId = vh.id;

  // Build a deterministic 4-link chain of deliverables so the dependency maths
  // is tested against something we control, not against imported defaults.
  const rows = await db
    .select()
    .from(deliverables)
    .where(and(eq(deliverables.projectId, projectId), eq(deliverables.completionStatus, 'NOT_COMPLETED')))
    .limit(4);
  chain = rows.map((r) => ({ id: r.id, code: r.deliverableCode, expected: r.currentExpectedReleaseDate }));
  const base = utc(2026, 10, 1);
  for (let i = 0; i < chain.length; i += 1) {
    await db
      .update(deliverables)
      .set({ currentExpectedReleaseDate: addDays(base, i * 10), baselineReleaseDate: addDays(base, i * 10) })
      .where(eq(deliverables.id, chain[i].id));
    chain[i].expected = addDays(base, i * 10);
  }
  for (let i = 1; i < chain.length; i += 1) {
    await db.insert(dependencies).values({
      id: newId('dp_'),
      predecessorType: 'DELIVERABLE',
      predecessorId: chain[i - 1].id,
      successorType: 'DELIVERABLE',
      successorId: chain[i].id,
      dependencyType: 'FS',
      lagDays: 0,
      createdAt: new Date(),
    });
  }
});

describe('reschedule preview writes nothing', () => {
  it('returns the impact without changing any date', async () => {
    const target = chain[0];
    const before = await db.select().from(deliverables).where(eq(deliverables.id, target.id)).limit(1);
    const impact = await previewReschedule({
      entityType: 'DELIVERABLE',
      entityIds: [target.id],
      newExpectedDate: utc(2026, 10, 22),
      reason: 'Preview only',
      scope: 'ITEM',
    });
    expect(impact.directChanges).toHaveLength(1);
    expect(impact.directChanges[0].shiftDays).toBe(21);
    const after = await db.select().from(deliverables).where(eq(deliverables.id, target.id)).limit(1);
    expect(after[0].currentExpectedReleaseDate.toISOString()).toBe(before[0].currentExpectedReleaseDate.toISOString());
    const history = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(rescheduleHistory)
      .where(eq(rescheduleHistory.entityId, target.id));
    expect(Number(history[0].n)).toBe(0);
  });

  it('shows the dependency cascade in the preview', async () => {
    const impact = await previewReschedule({
      entityType: 'DELIVERABLE',
      entityIds: [chain[0].id],
      shiftDays: 30,
      reason: 'Preview cascade',
      scope: 'ITEM',
    });
    expect(impact.affectedSuccessors).toBeGreaterThanOrEqual(3);
    expect(impact.cascadedChanges.every((c) => c.reasonCode === 'DEPENDENCY')).toBe(true);
    expect(impact.projectForecast[0].shiftDays).toBeGreaterThanOrEqual(0);
  });
});

describe('applying a reschedule', () => {
  it('moves the current expected date, preserves the baseline and records history + audit', async () => {
    const target = chain[1];
    const [before] = await db.select().from(deliverables).where(eq(deliverables.id, target.id)).limit(1);
    const res = await applyReschedule(
      {
        entityType: 'DELIVERABLE',
        entityIds: [target.id],
        newExpectedDate: addDays(before.currentExpectedReleaseDate, 7),
        reason: 'Client information delayed',
        scope: 'ITEM',
        options: { recalculateDependents: false },
      },
      actor,
    );
    expect(res.applied).toBe(1);
    const [after] = await db.select().from(deliverables).where(eq(deliverables.id, target.id)).limit(1);
    expect(after.baselineReleaseDate.toISOString()).toBe(before.baselineReleaseDate.toISOString());
    expect(diffDays(after.currentExpectedReleaseDate, before.currentExpectedReleaseDate)).toBe(7);
    expect(after.rescheduleCount).toBe(before.rescheduleCount + 1);

    const history = await db
      .select()
      .from(rescheduleHistory)
      .where(eq(rescheduleHistory.entityId, target.id));
    expect(history).toHaveLength(1);
    expect(history[0].daysShift).toBe(7);
    expect(history[0].reason).toBe('Client information delayed');
    expect(history[0].changedByLabel).toBe(actor.label);

    const audit = await auditForEntity('DELIVERABLE', target.id);
    expect(audit.some((a) => a.action === 'RESCHEDULE')).toBe(true);
  });

  it('keeps a full history when the same item moves twice', async () => {
    const target = chain[1];
    const [mid] = await db.select().from(deliverables).where(eq(deliverables.id, target.id)).limit(1);
    await applyReschedule(
      {
        entityType: 'DELIVERABLE',
        entityIds: [target.id],
        newExpectedDate: addDays(mid.currentExpectedReleaseDate, 8),
        reason: 'Client comment',
        scope: 'ITEM',
        options: { recalculateDependents: false },
      },
      actor,
    );
    const history = await db
      .select()
      .from(rescheduleHistory)
      .where(eq(rescheduleHistory.entityId, target.id))
      .orderBy(rescheduleHistory.changedAt);
    expect(history).toHaveLength(2);
    expect(history.map((h) => h.daysShift)).toEqual([7, 8]);
    const [after] = await db.select().from(deliverables).where(eq(deliverables.id, target.id)).limit(1);
    expect(after.baselineReleaseDate.toISOString()).toBe(chain[1].expected.toISOString());
  });

  it('recalculates dependent dates only when the link is violated', async () => {
    // Reset the chain
    const base = utc(2026, 10, 1);
    for (let i = 0; i < chain.length; i += 1) {
      await db
        .update(deliverables)
        .set({ currentExpectedReleaseDate: addDays(base, i * 10), rescheduleCount: 0 })
        .where(eq(deliverables.id, chain[i].id));
    }
    // Pull the predecessor 5 days EARLIER: nothing downstream should move.
    const early = await applyReschedule(
      {
        entityType: 'DELIVERABLE',
        entityIds: [chain[0].id],
        shiftDays: -5,
        reason: 'Pulled forward',
        scope: 'ITEM',
      },
      actor,
    );
    expect(early.cascaded).toBe(0);

    // Push it 30 days LATER: successors must be pushed to satisfy FS.
    const late = await applyReschedule(
      {
        entityType: 'DELIVERABLE',
        entityIds: [chain[0].id],
        shiftDays: 30,
        reason: 'Consultant delay',
        scope: 'ITEM',
      },
      actor,
    );
    // Predecessor lands on base+25. Links 0→1 and 1→2 are violated and move;
    // link 2→3 is still satisfied (base+30 > base+28), so item 3 does NOT move.
    // That is the rule: dependents shift only when the link is actually broken.
    expect(late.cascaded).toBe(2);
    const rows = await db
      .select()
      .from(deliverables)
      .where(eq(deliverables.projectId, projectId));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const pred = byId.get(chain[0].id)!;
    for (let i = 1; i < chain.length; i += 1) {
      const succ = byId.get(chain[i].id)!;
      expect(succ.currentExpectedReleaseDate.getTime()).toBeGreaterThan(pred.currentExpectedReleaseDate.getTime());
      // baseline untouched throughout the cascade
      expect(succ.baselineReleaseDate.toISOString()).toBe(chain[i].expected.toISOString());
    }
    expect(byId.get(chain[3].id)!.currentExpectedReleaseDate.toISOString()).toBe(
      addDays(base, 30).toISOString(),
    );
    const cascadedHistory = await db
      .select()
      .from(rescheduleHistory)
      .where(and(eq(rescheduleHistory.entityId, chain[2].id), eq(rescheduleHistory.cascaded, true)));
    expect(cascadedHistory.length).toBeGreaterThan(0);
    expect(cascadedHistory[0].reason).toMatch(/cascaded via FS/);
  });

  it('honours lag, including negative lag', async () => {
    const [a, b] = chain;
    await db
      .update(dependencies)
      .set({ lagDays: 10 })
      .where(and(eq(dependencies.predecessorId, a.id), eq(dependencies.successorId, b.id)));
    const base = utc(2026, 11, 1);
    await db.update(deliverables).set({ currentExpectedReleaseDate: base }).where(eq(deliverables.id, a.id));
    await db.update(deliverables).set({ currentExpectedReleaseDate: base }).where(eq(deliverables.id, b.id));
    const impact = await previewReschedule({
      entityType: 'DELIVERABLE',
      entityIds: [a.id],
      shiftDays: 5,
      reason: 'lag test',
      scope: 'ITEM',
    });
    const successor = impact.cascadedChanges.find((c) => c.entityId === b.id);
    expect(successor).toBeTruthy();
    // FS + 10d lag: successor finish must be at least predecessor finish + 11 days
    expect(diffDays(new Date(successor!.newDate), addDays(base, 5))).toBe(11);

    await db
      .update(dependencies)
      .set({ lagDays: -3 })
      .where(and(eq(dependencies.predecessorId, a.id), eq(dependencies.successorId, b.id)));
    const negative = await previewReschedule({
      entityType: 'DELIVERABLE',
      entityIds: [a.id],
      shiftDays: 5,
      reason: 'negative lag test',
      scope: 'ITEM',
    });
    const succNeg = negative.cascadedChanges.find((c) => c.entityId === b.id);
    expect(diffDays(new Date(succNeg!.newDate), addDays(base, 5))).toBe(-2);
    await db
      .update(dependencies)
      .set({ lagDays: 0 })
      .where(and(eq(dependencies.predecessorId, a.id), eq(dependencies.successorId, b.id)));
  });

  it('never moves completed work, and says so in the preview', async () => {
    const target = chain[3];
    await setCompletion('DELIVERABLE', target.id, 'COMPLETED', actor, { reason: 'released' });
    const [completed] = await db.select().from(deliverables).where(eq(deliverables.id, target.id)).limit(1);

    const direct = await previewReschedule({
      entityType: 'DELIVERABLE',
      entityIds: [target.id],
      shiftDays: 30,
      reason: 'attempt to move completed work',
      scope: 'ITEM',
    });
    expect(direct.directChanges).toHaveLength(0);
    expect(direct.skipped[0].reason).toMatch(/completed/i);

    const cascade = await previewReschedule({
      entityType: 'DELIVERABLE',
      entityIds: [chain[0].id],
      shiftDays: 120,
      reason: 'big push',
      scope: 'ITEM',
    });
    expect(cascade.cascadedChanges.some((c) => c.entityId === target.id)).toBe(false);
    expect(cascade.skipped.some((s) => /already completed/i.test(s.reason))).toBe(true);

    const [stillSame] = await db.select().from(deliverables).where(eq(deliverables.id, target.id)).limit(1);
    expect(stillSame.actualReleaseDate?.toISOString()).toBe(completed.actualReleaseDate?.toISOString());
    await setCompletion('DELIVERABLE', target.id, 'NOT_COMPLETED', actor, { reason: 'test cleanup' });
  });

  it('rescheduling a goal keeps the original commitment visible and writes a goal revision', async () => {
    const [goal] = await db
      .select()
      .from(goals)
      .where(and(eq(goals.projectId, projectId), eq(goals.completionStatus, 'NOT_COMPLETED')))
      .limit(1);
    const original = goal.baselineTargetDate;
    const res = await applyReschedule(
      {
        entityType: 'GOAL',
        entityIds: [goal.id],
        newExpectedDate: addDays(goal.currentExpectedDate, 15),
        reason: 'Client design information delayed',
        scope: 'GOAL',
      },
      actor,
    );
    expect(res.applied).toBe(1);
    const [after] = await db.select().from(goals).where(eq(goals.id, goal.id)).limit(1);
    expect(after.baselineTargetDate.toISOString()).toBe(original.toISOString());
    expect(diffDays(after.currentExpectedDate, goal.currentExpectedDate)).toBe(15);
    const { goalRevisions } = await import('@/db/schema');
    const revs = await db.select().from(goalRevisions).where(eq(goalRevisions.goalId, goal.id));
    expect(revs.some((r) => r.reason === 'Client design information delayed')).toBe(true);
    expect(revs.find((r) => r.reason === 'Client design information delayed')?.impactSummary).toMatch(/\+15 days/);
  });

  it('shifts an entire package scope in one action', async () => {
    // Pick a package that actually contains incomplete deliverables.
    const [candidate] = await db
      .select({ packageId: deliverables.packageId, n: sql<number>`count(*)::int` })
      .from(deliverables)
      .where(and(eq(deliverables.projectId, projectId), eq(deliverables.completionStatus, 'NOT_COMPLETED')))
      .groupBy(deliverables.packageId)
      .having(sql`count(*) > 2 and ${deliverables.packageId} is not null`)
      .limit(1);
    const [pkg] = await db.select().from(packages).where(eq(packages.id, candidate.packageId!)).limit(1);
    const ids = await resolveScopeIds({
      type: 'DELIVERABLE',
      scope: 'PACKAGE',
      ids: [],
      projectId,
      packageId: pkg.id,
    });
    expect(ids.length).toBeGreaterThan(0);
    const res = await applyReschedule(
      {
        entityType: 'DELIVERABLE',
        entityIds: ids,
        shiftDays: 14,
        reason: 'Package-wide slip after design review',
        scope: 'PACKAGE',
        options: { recalculateDependents: false },
      },
      actor,
    );
    expect(res.applied).toBe(ids.length);
    const history = await db
      .select()
      .from(rescheduleHistory)
      .where(eq(rescheduleHistory.scope, 'PACKAGE'));
    expect(history.length).toBeGreaterThanOrEqual(ids.length);
    expect(new Set(history.map((h) => h.batchId)).size).toBeGreaterThanOrEqual(1);
  });

  it('a rescheduled item is still NOT COMPLETED — completion and schedule are independent', async () => {
    const [row] = await db
      .select()
      .from(deliverables)
      .where(sql`${deliverables.rescheduleCount} > 0`)
      .limit(1);
    expect(row.completionStatus).toBe('NOT_COMPLETED');
  });
});
