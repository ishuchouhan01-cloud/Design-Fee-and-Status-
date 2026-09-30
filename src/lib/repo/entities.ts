/**
 * Generic accessor over the four schedulable entity types, so the rescheduling
 * engine, the audit trail and the Gantt view never need per-type branches in
 * their business logic.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db';
import { deliverables, drawings, goals, packages } from '@/db/schema';
import type { EntityType } from '@/lib/domain';
import { type DbLike } from '@/db';

export interface ScheduleEntity {
  type: EntityType;
  id: string;
  code: string;
  label: string;
  projectId: string;
  phaseId: string | null;
  packageId: string | null;
  disciplineId: string | null;
  goalId: string | null;
  completionStatus: string;
  baselineDate: Date | null;
  expectedDate: Date | null;
  actualDate: Date | null;
  durationDays: number;
  rescheduleCount: number;
  priority?: string;
  value?: number;
}

function asDate(v: unknown): Date | null {
  if (v == null) return null;
  return v instanceof Date ? v : new Date(v as number);
}

export async function loadEntities(type: EntityType, ids: string[]): Promise<ScheduleEntity[]> {
  if (ids.length === 0) return [];
  switch (type) {
    case 'GOAL': {
      const rows = await db.select().from(goals).where(inArray(goals.id, ids));
      return rows.map(goalToEntity);
    }
    case 'DELIVERABLE': {
      const rows = await db.select().from(deliverables).where(inArray(deliverables.id, ids));
      return rows.map(deliverableToEntity);
    }
    case 'DRAWING': {
      const rows = await db.select().from(drawings).where(inArray(drawings.id, ids));
      return rows.map(drawingToEntity);
    }
    case 'PACKAGE': {
      const rows = await db.select().from(packages).where(inArray(packages.id, ids));
      return rows.map(packageToEntity);
    }
  }
}

export async function loadEntity(type: EntityType, id: string): Promise<ScheduleEntity | null> {
  const [e] = await loadEntities(type, [id]);
  return e ?? null;
}

export function goalToEntity(g: typeof goals.$inferSelect): ScheduleEntity {
  return {
    type: 'GOAL',
    id: g.id,
    code: g.goalCode,
    label: g.goalDescription,
    projectId: g.projectId,
    phaseId: g.phaseId,
    packageId: null,
    disciplineId: g.disciplineId,
    goalId: g.id,
    completionStatus: g.completionStatus,
    baselineDate: asDate(g.baselineTargetDate),
    expectedDate: asDate(g.currentExpectedDate),
    actualDate: asDate(g.actualCompletionDate),
    durationDays: 0,
    rescheduleCount: g.rescheduleCount,
    priority: g.priority,
    value: g.plannedValue,
  };
}

export function deliverableToEntity(d: typeof deliverables.$inferSelect): ScheduleEntity {
  return {
    type: 'DELIVERABLE',
    id: d.id,
    code: d.deliverableCode,
    label: d.deliverableDescription,
    projectId: d.projectId,
    phaseId: d.phaseId,
    packageId: d.packageId,
    disciplineId: d.disciplineId,
    goalId: d.goalId,
    completionStatus: d.completionStatus,
    baselineDate: asDate(d.baselineReleaseDate),
    expectedDate: asDate(d.currentExpectedReleaseDate),
    actualDate: asDate(d.actualReleaseDate),
    durationDays: 0,
    rescheduleCount: d.rescheduleCount,
  };
}

export function drawingToEntity(d: typeof drawings.$inferSelect): ScheduleEntity {
  return {
    type: 'DRAWING',
    id: d.id,
    code: d.drawingCode,
    label: d.drawingName,
    projectId: d.projectId,
    phaseId: d.phaseId,
    packageId: d.packageId,
    disciplineId: d.disciplineId,
    goalId: null,
    completionStatus: d.completionStatus,
    baselineDate: asDate(d.baselineReleaseDate),
    expectedDate: asDate(d.currentExpectedReleaseDate),
    actualDate: asDate(d.actualReleaseDate),
    durationDays: 0,
    rescheduleCount: d.rescheduleCount,
  };
}

export function packageToEntity(p: typeof packages.$inferSelect): ScheduleEntity {
  return {
    type: 'PACKAGE',
    id: p.id,
    code: p.packageCode,
    label: p.packageName,
    projectId: p.projectId,
    phaseId: p.phaseId,
    packageId: p.id,
    disciplineId: null,
    goalId: null,
    completionStatus: p.actualReleaseDate ? 'COMPLETED' : 'NOT_COMPLETED',
    baselineDate: asDate(p.baselineReleaseDate),
    expectedDate: asDate(p.currentExpectedReleaseDate),
    actualDate: asDate(p.actualReleaseDate),
    durationDays: p.durationDays ?? 0,
    rescheduleCount: p.rescheduleCount,
  };
}

/** Date-field names per entity type, used for generic writes. */
export const DATE_FIELDS = {
  GOAL: { baseline: 'baselineTargetDate', expected: 'currentExpectedDate', actual: 'actualCompletionDate' },
  DELIVERABLE: { baseline: 'baselineReleaseDate', expected: 'currentExpectedReleaseDate', actual: 'actualReleaseDate' },
  DRAWING: { baseline: 'baselineReleaseDate', expected: 'currentExpectedReleaseDate', actual: 'actualReleaseDate' },
  PACKAGE: { baseline: 'baselineReleaseDate', expected: 'currentExpectedReleaseDate', actual: 'actualReleaseDate' },
} as const;

export const TABLE_FOR = {
  GOAL: goals,
  DELIVERABLE: deliverables,
  DRAWING: drawings,
  PACKAGE: packages,
} as const;

/**
 * Write a new current-expected date. The BASELINE column is never touched
 * here — that guarantee is structural, not a convention.
 *
 * Takes a `DbLike` so the caller decides whether this runs on its own or as
 * part of a transaction.
 */
export async function writeExpectedDate(
  tx: DbLike,
  type: EntityType,
  id: string,
  newDate: Date,
  opts: { markUserEdited?: boolean } = {},
): Promise<void> {
  const table = TABLE_FOR[type] as typeof goals;
  const field = DATE_FIELDS[type].expected;
  const patch: Record<string, unknown> = {
    [field]: newDate,
    updatedAt: new Date(),
    rescheduleCount: sql`${table.rescheduleCount} + 1`,
  };
  if (type === 'DRAWING' && (opts.markUserEdited ?? true)) {
    // A rescheduled drawing date is a user decision: record it so a re-import
    // never moves it back (see drawings.user_edited_fields).
    patch.userEditedFields = sql`case
      when ${drawings.userEditedFields} = '' then 'currentExpectedReleaseDate'
      when position('currentExpectedReleaseDate' in ${drawings.userEditedFields}) > 0 then ${drawings.userEditedFields}
      else ${drawings.userEditedFields} || ',currentExpectedReleaseDate' end`;
    patch.editedAt = new Date();
  }
  if (type === 'PACKAGE' && (opts.markUserEdited ?? true)) {
    // A rescheduled package date is a user decision too (packages.user_edited_fields).
    patch.userEditedFields = sql`case
      when ${packages.userEditedFields} = '' then 'currentExpectedReleaseDate'
      when position('currentExpectedReleaseDate' in ${packages.userEditedFields}) > 0 then ${packages.userEditedFields}
      else ${packages.userEditedFields} || ',currentExpectedReleaseDate' end`;
  }
  await tx.update(table).set(patch as never).where(eq(table.id, id));
}

export async function resolveScopeIds(params: {
  type: EntityType;
  scope: 'ITEM' | 'SELECTION' | 'PACKAGE' | 'DISCIPLINE' | 'GOAL' | 'PROJECT';
  ids: string[];
  projectId?: string | null;
  packageId?: string | null;
  disciplineId?: string | null;
  goalId?: string | null;
  includeCompleted?: boolean;
}): Promise<string[]> {
  const { type, scope, ids } = params;
  if (scope === 'ITEM' || scope === 'SELECTION') return ids;

  const table = TABLE_FOR[type] as typeof goals;
  const conds = [];
  if (scope === 'PROJECT') {
    if (!params.projectId) return ids;
    conds.push(eq(table.projectId, params.projectId));
  } else if (scope === 'PACKAGE') {
    if (!params.packageId || type === 'GOAL' || type === 'PACKAGE') return ids;
    conds.push(eq((table as unknown as typeof deliverables).packageId, params.packageId));
  } else if (scope === 'DISCIPLINE') {
    if (!params.disciplineId) return ids;
    conds.push(eq(table.disciplineId, params.disciplineId));
    if (params.projectId) conds.push(eq(table.projectId, params.projectId));
  } else if (scope === 'GOAL') {
    if (type === 'GOAL') return ids;
    // Only design deliverables carry a goal link. Drawings and packages have
    // no goal_id column, so a GOAL scope cannot widen their selection.
    if (type !== 'DELIVERABLE') {
      throw new Error(`Reschedule scope GOAL does not apply to ${type}: it has no goal link.`);
    }
    if (!params.goalId) return ids;
    conds.push(eq(deliverables.goalId, params.goalId));
  }
  if (!params.includeCompleted) conds.push(eq(table.completionStatus, 'NOT_COMPLETED'));
  const rows = await db.select({ id: table.id }).from(table).where(and(...conds));
  return rows.map((r) => r.id);
}
