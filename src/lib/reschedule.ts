/**
 * Rescheduling engine — Asta-inspired, deliberately small.
 *
 * What it borrows from Asta Powerproject:
 *   - a baseline that is never overwritten, so slippage stays measurable
 *   - a current/forecast date that moves, with a recorded reason
 *   - links between items (FS / SS / FF with positive or negative lag)
 *   - progressed work is protected: completed items never move
 *   - an impact preview before anything is committed
 *
 * What it deliberately does NOT do: resource levelling, calendars/shifts,
 * full CPM float analysis, or multi-baseline sets. This is a design-delivery
 * control tool, not a replacement for a planning suite.
 */
import { and, eq, inArray, or } from 'drizzle-orm';
import { db, type DbLike } from '@/db';
import { dependencies as depTable, rescheduleHistory } from '@/db/schema';
import { newId } from './ids';
import { addDays, diffDays, startOfDay } from './periods';
import { assessSchedule } from './schedule';
import type { DependencyType, EntityType, RescheduleScope } from './domain';
import {
  DATE_FIELDS,
  loadEntities,
  writeExpectedDate,
  type ScheduleEntity,
} from './repo/entities';
import { recordAudit } from './audit';

export interface RescheduleOptions {
  preserveCompletedDates: boolean;
  recalculateDependents: boolean;
  updateForecast: boolean;
  recordHistory: boolean;
}

export const DEFAULT_OPTIONS: RescheduleOptions = {
  preserveCompletedDates: true,
  recalculateDependents: true,
  updateForecast: true,
  recordHistory: true,
};

export interface RescheduleRequest {
  entityType: EntityType;
  entityIds: string[];
  /** Either an explicit target date (single item) or a uniform shift in days. */
  newExpectedDate?: Date | null;
  shiftDays?: number | null;
  reason: string;
  scope: RescheduleScope;
  options?: Partial<RescheduleOptions>;
}

export interface PlannedChange {
  entityType: EntityType;
  entityId: string;
  code: string;
  label: string;
  projectId: string;
  oldDate: Date | null;
  newDate: Date;
  shiftDays: number;
  cascaded: boolean;
  reasonCode: 'DIRECT' | 'DEPENDENCY';
  dependencyType?: DependencyType;
  lagDays?: number;
}

export interface SkippedItem {
  entityType: EntityType;
  entityId: string;
  code: string;
  reason: string;
}

export interface RescheduleImpact {
  requested: {
    entityType: EntityType;
    scope: RescheduleScope;
    reason: string;
    options: RescheduleOptions;
  };
  directChanges: PlannedChange[];
  cascadedChanges: PlannedChange[];
  skipped: SkippedItem[];
  affectedSuccessors: number;
  affectedGoalIds: string[];
  affectedPackageIds: string[];
  affectedProjectIds: string[];
  maxShiftDays: number;
  projectForecast: {
    projectId: string;
    beforeCompletion: Date | null;
    afterCompletion: Date | null;
    shiftDays: number;
  }[];
  quarterImpact: { period: string; before: number; after: number; delta: number }[];
  totalRecords: number;
}

function normaliseOptions(o?: Partial<RescheduleOptions>): RescheduleOptions {
  return { ...DEFAULT_OPTIONS, ...(o ?? {}) };
}

/** Successor finish is pushed only when the link is actually violated. */
function requiredSuccessorFinish(
  predecessor: { start: Date; finish: Date },
  successor: { durationDays: number },
  type: DependencyType,
  lagDays: number,
): Date {
  switch (type) {
    case 'SS':
      return addDays(predecessor.start, lagDays + successor.durationDays);
    case 'FF':
      return addDays(predecessor.finish, lagDays);
    case 'FS':
    default:
      return addDays(predecessor.finish, lagDays + successor.durationDays + 1);
  }
}

function startOf(e: { expectedDate: Date | null; durationDays: number }, finish: Date): Date {
  return addDays(finish, -Math.max(0, e.durationDays));
}

async function loadDependenciesFor(keys: { type: EntityType; id: string }[]) {
  if (keys.length === 0) return [];
  const clauses = keys.map((k) =>
    and(eq(depTable.predecessorType, k.type), eq(depTable.predecessorId, k.id)),
  );
  return db.select().from(depTable).where(or(...clauses));
}

/**
 * Compute every change a reschedule would make, without writing anything.
 * This is what the confirmation dialog renders (spec §13, §37).
 */
export async function previewReschedule(req: RescheduleRequest): Promise<RescheduleImpact> {
  const options = normaliseOptions(req.options);
  const targets = await loadEntities(req.entityType, req.entityIds);
  const skipped: SkippedItem[] = [];
  const directChanges: PlannedChange[] = [];

  for (const e of targets) {
    if (e.completionStatus === 'COMPLETED' && options.preserveCompletedDates) {
      skipped.push({
        entityType: e.type,
        entityId: e.id,
        code: e.code,
        reason: 'Completed — actual date preserved, item not moved',
      });
      continue;
    }
    const oldDate = e.expectedDate;
    let newDate: Date | null = null;
    if (req.newExpectedDate) {
      newDate = startOfDay(req.newExpectedDate);
    } else if (req.shiftDays != null && oldDate) {
      newDate = addDays(oldDate, req.shiftDays);
    } else if (req.shiftDays != null && !oldDate) {
      skipped.push({ entityType: e.type, entityId: e.id, code: e.code, reason: 'No current expected date to shift' });
      continue;
    }
    if (!newDate) {
      skipped.push({ entityType: e.type, entityId: e.id, code: e.code, reason: 'No new date resolved' });
      continue;
    }
    const shift = oldDate ? diffDays(newDate, oldDate) : 0;
    if (oldDate && shift === 0) {
      skipped.push({ entityType: e.type, entityId: e.id, code: e.code, reason: 'Already on that date' });
      continue;
    }
    directChanges.push({
      entityType: e.type,
      entityId: e.id,
      code: e.code,
      label: e.label,
      projectId: e.projectId,
      oldDate,
      newDate,
      shiftDays: shift,
      cascaded: false,
      reasonCode: 'DIRECT',
    });
  }

  // --- dependency cascade -------------------------------------------------
  const cascadedChanges: PlannedChange[] = [];
  if (options.recalculateDependents && directChanges.length > 0) {
    const resolved = new Map<string, Date>(); // "TYPE:id" → new finish
    const entityCache = new Map<string, ScheduleEntity>();
    for (const e of targets) entityCache.set(`${e.type}:${e.id}`, e);
    for (const c of directChanges) resolved.set(`${c.entityType}:${c.entityId}`, c.newDate);

    let frontier = directChanges.map((c) => ({ type: c.entityType, id: c.entityId }));
    const visited = new Set(frontier.map((f) => `${f.type}:${f.id}`));
    let depth = 0;

    while (frontier.length > 0 && depth < 25) {
      depth += 1;
      const links = await loadDependenciesFor(frontier);
      if (links.length === 0) break;

      const byType = new Map<EntityType, Set<string>>();
      for (const l of links) {
        const t = l.successorType as EntityType;
        if (!byType.has(t)) byType.set(t, new Set());
        byType.get(t)!.add(l.successorId);
      }
      for (const [t, idSet] of byType) {
        const loaded = await loadEntities(t, [...idSet]);
        for (const e of loaded) entityCache.set(`${e.type}:${e.id}`, e);
      }
      // also make sure predecessors are cached
      for (const f of frontier) {
        if (!entityCache.has(`${f.type}:${f.id}`)) {
          const loaded = await loadEntities(f.type, [f.id]);
          for (const e of loaded) entityCache.set(`${e.type}:${e.id}`, e);
        }
      }

      const nextFrontier: { type: EntityType; id: string }[] = [];
      for (const l of links) {
        const predKey = `${l.predecessorType}:${l.predecessorId}`;
        const succKey = `${l.successorType}:${l.successorId}`;
        const pred = entityCache.get(predKey);
        const succ = entityCache.get(succKey);
        if (!pred || !succ) continue;
        if (succ.completionStatus === 'COMPLETED' && options.preserveCompletedDates) {
          skipped.push({
            entityType: succ.type,
            entityId: succ.id,
            code: succ.code,
            reason: 'Successor already completed — not moved',
          });
          continue;
        }
        const predFinish = resolved.get(predKey) ?? pred.expectedDate;
        if (!predFinish) continue;
        const predStart = startOf(pred, predFinish);
        const need = requiredSuccessorFinish(
          { start: predStart, finish: predFinish },
          { durationDays: succ.durationDays },
          (l.dependencyType as DependencyType) ?? 'FS',
          l.lagDays,
        );
        const current = resolved.get(succKey) ?? succ.expectedDate;
        if (current && need.getTime() <= startOfDay(current).getTime()) continue; // link satisfied
        const oldDate = succ.expectedDate;
        const shift = oldDate ? diffDays(need, oldDate) : 0;
        resolved.set(succKey, need);
        const existing = cascadedChanges.find(
          (c) => c.entityId === succ.id && c.entityType === succ.type,
        );
        if (existing) {
          if (need.getTime() > existing.newDate.getTime()) {
            existing.newDate = need;
            existing.shiftDays = shift;
          }
        } else {
          cascadedChanges.push({
            entityType: succ.type,
            entityId: succ.id,
            code: succ.code,
            label: succ.label,
            projectId: succ.projectId,
            oldDate,
            newDate: need,
            shiftDays: shift,
            cascaded: true,
            reasonCode: 'DEPENDENCY',
            dependencyType: (l.dependencyType as DependencyType) ?? 'FS',
            lagDays: l.lagDays,
          });
        }
        if (!visited.has(succKey)) {
          visited.add(succKey);
          nextFrontier.push({ type: succ.type, id: succ.id });
        }
      }
      frontier = nextFrontier;
    }
  }

  const all = [...directChanges, ...cascadedChanges];
  const affectedProjectIds = [...new Set(all.map((c) => c.projectId))];
  const affectedGoalIds = [
    ...new Set(
      [...targets, ...(await loadRelated(all))]
        .map((e) => e.goalId)
        .filter((v): v is string => Boolean(v)),
    ),
  ];
  const affectedPackageIds = [
    ...new Set(
      [...targets, ...(await loadRelated(all))]
        .map((e) => e.packageId)
        .filter((v): v is string => Boolean(v)),
    ),
  ];

  const projectForecast = await forecastImpact(all, affectedProjectIds);
  const quarterImpact = quarterDelta(all);

  return {
    requested: {
      entityType: req.entityType,
      scope: req.scope,
      reason: req.reason,
      options,
    },
    directChanges,
    cascadedChanges,
    skipped,
    affectedSuccessors: cascadedChanges.length,
    affectedGoalIds,
    affectedPackageIds,
    affectedProjectIds,
    maxShiftDays: all.reduce((m, c) => Math.max(m, c.shiftDays), 0),
    projectForecast,
    quarterImpact,
    totalRecords: all.length,
  };
}

async function loadRelated(changes: PlannedChange[]): Promise<ScheduleEntity[]> {
  const byType = new Map<EntityType, string[]>();
  for (const c of changes) {
    const list = byType.get(c.entityType) ?? [];
    list.push(c.entityId);
    byType.set(c.entityType, list);
  }
  const out: ScheduleEntity[] = [];
  for (const [t, ids] of byType) out.push(...(await loadEntities(t, ids)));
  return out;
}

/** New forecast completion date per project, before vs after the change. */
async function forecastImpact(changes: PlannedChange[], projectIds: string[]) {
  const out: RescheduleImpact['projectForecast'] = [];
  for (const projectId of projectIds) {
    const { deliverables, drawings, goals } = await import('@/db/schema');
    const [d1, d2, g1] = await Promise.all([
      db
        .select({ date: deliverables.currentExpectedReleaseDate, id: deliverables.id })
        .from(deliverables)
        .where(and(eq(deliverables.projectId, projectId), eq(deliverables.completionStatus, 'NOT_COMPLETED'))),
      db
        .select({ date: drawings.currentExpectedReleaseDate, id: drawings.id })
        .from(drawings)
        .where(and(eq(drawings.projectId, projectId), eq(drawings.completionStatus, 'NOT_COMPLETED'))),
      db
        .select({ date: goals.currentExpectedDate, id: goals.id })
        .from(goals)
        .where(and(eq(goals.projectId, projectId), eq(goals.completionStatus, 'NOT_COMPLETED'))),
    ]);
    const rows = [...d1, ...d2, ...g1].filter((r) => r.date);
    const before = rows.reduce<Date | null>(
      (max, r) => (!max || (r.date as Date).getTime() > max.getTime() ? (r.date as Date) : max),
      null,
    );
    const overrides = new Map(changes.filter((c) => c.projectId === projectId).map((c) => [c.entityId, c.newDate]));
    const after = rows.reduce<Date | null>((max, r) => {
      const d = overrides.get(r.id) ?? (r.date as Date);
      return !max || d.getTime() > max.getTime() ? d : max;
    }, null);
    out.push({
      projectId,
      beforeCompletion: before,
      afterCompletion: after,
      shiftDays: before && after ? diffDays(after, before) : 0,
    });
  }
  return out;
}

function quarterKey(d: Date): string {
  return `CY${d.getUTCFullYear()} Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

/** How many items move out of / into each calendar quarter. */
function quarterDelta(changes: PlannedChange[]) {
  const before = new Map<string, number>();
  const after = new Map<string, number>();
  for (const c of changes) {
    if (c.oldDate) before.set(quarterKey(c.oldDate), (before.get(quarterKey(c.oldDate)) ?? 0) + 1);
    after.set(quarterKey(c.newDate), (after.get(quarterKey(c.newDate)) ?? 0) + 1);
  }
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  return keys.map((period) => {
    const b = before.get(period) ?? 0;
    const a = after.get(period) ?? 0;
    return { period, before: b, after: a, delta: a - b };
  });
}

export interface RescheduleWriteMeta {
  reason: string;
  /** Reason written to the audit row (defaults to `reason`). */
  auditReason?: string;
  scope: string;
  batchId: string;
  actor: { id: string | null; label: string };
  impactedRecords: number;
  stamp: Date;
  recordHistory: boolean;
  /** Record the move as a user edit so importers do not overwrite it
   *  (drawings only). An import-driven move passes false. */
  markUserEdited?: boolean;
}

/**
 * Append one row to `reschedule_history`. The engine and the drawing importer
 * both write history through here, so every recorded move has the same shape.
 */
export async function recordRescheduleHistory(
  tx: DbLike,
  c: Pick<PlannedChange, 'entityType' | 'entityId' | 'code' | 'label' | 'projectId' | 'oldDate' | 'newDate' | 'shiftDays' | 'cascaded'>,
  meta: Pick<RescheduleWriteMeta, 'reason' | 'scope' | 'batchId' | 'actor' | 'impactedRecords' | 'stamp'>,
) {
  await tx.insert(rescheduleHistory).values({
    id: newId('rh_'),
    entityType: c.entityType,
    entityId: c.entityId,
    entityLabel: `${c.code} \u2014 ${c.label}`,
    oldDate: c.oldDate,
    newDate: c.newDate,
    daysShift: c.shiftDays,
    reason: meta.reason,
    scope: meta.scope,
    batchId: meta.batchId,
    cascaded: c.cascaded,
    changedById: meta.actor.id,
    changedByLabel: meta.actor.label,
    impactedRecords: meta.impactedRecords,
    projectId: c.projectId,
    changedAt: meta.stamp,
  });
}

/**
 * The single write path for a current-expected date change: the new date
 * (baseline untouched, reschedule count +1), a history row and an audit row,
 * all on the caller's transaction. Nothing else in the application moves an
 * expected date.
 */
export async function writeRescheduleChange(
  tx: DbLike,
  c: Pick<PlannedChange, 'entityType' | 'entityId' | 'code' | 'label' | 'projectId' | 'oldDate' | 'newDate' | 'shiftDays' | 'cascaded'>,
  meta: RescheduleWriteMeta,
) {
  await writeExpectedDate(tx, c.entityType, c.entityId, c.newDate, { markUserEdited: meta.markUserEdited ?? true });
  if (meta.recordHistory) await recordRescheduleHistory(tx, c, meta);
  await recordAudit(
    {
      actor: meta.actor,
      entityType: c.entityType,
      entityId: c.entityId,
      entityLabel: `${c.code} \u2014 ${c.label}`,
      action: c.entityType === 'DRAWING' ? 'RESCHEDULE_DRAWING' : 'RESCHEDULE',
      field: DATE_FIELDS[c.entityType].expected,
      oldValue: c.oldDate ? c.oldDate.toISOString() : null,
      newValue: c.newDate.toISOString(),
      reason: meta.auditReason ?? meta.reason,
      projectId: c.projectId,
    },
    tx,
  );
}

export interface ApplyResult {
  batchId: string;
  applied: number;
  cascaded: number;
  skipped: number;
  impact: RescheduleImpact;
}

/**
 * Apply a reschedule. Never called without the caller having seen the preview:
 * the API requires an explicit `confirm` flag.
 */
export async function applyReschedule(
  req: RescheduleRequest,
  actor: { id: string | null; label: string },
): Promise<ApplyResult> {
  const impact = await previewReschedule(req);
  const options = impact.requested.options;
  const batchId = newId('rs_');
  const all = [...impact.directChanges, ...impact.cascadedChanges];
  const { goalRevisions } = await import('@/db/schema');
  const stamp = new Date();

  // The whole write phase runs inside one PostgreSQL transaction: either every
  // date, history row and audit row lands, or none of them do. node-postgres is
  // asynchronous, so the callback is async and every statement is awaited —
  // an un-awaited statement here would silently escape the transaction.
  await db.transaction(async (tx) => {
    for (const c of all) {
      await writeRescheduleChange(tx, c, {
        reason: c.cascaded
          ? `${req.reason} [cascaded via ${c.dependencyType ?? 'FS'}${c.lagDays ? ` ${c.lagDays >= 0 ? '+' : ''}${c.lagDays}d lag` : ''}]`
          : req.reason,
        auditReason: req.reason,
        scope: req.scope,
        batchId,
        actor,
        impactedRecords: all.length,
        stamp,
        recordHistory: options.recordHistory,
      });
    }

    // Goal-level revision records keep the original commitment visible (spec 15).
    if (req.entityType === 'GOAL' && options.recordHistory) {
      for (const c of impact.directChanges) {
        await tx.insert(goalRevisions).values({
          id: newId('gr_'),
          goalId: c.entityId,
          previousExpectedDate: c.oldDate,
          newExpectedDate: c.newDate,
          reason: req.reason,
          changedById: actor.id,
          changedAt: stamp,
          impactSummary: `${c.shiftDays >= 0 ? '+' : ''}${c.shiftDays} days; ${impact.affectedSuccessors} successor(s) recalculated`,
        });
      }
    }
  });

  return {
    batchId,
    applied: impact.directChanges.length,
    cascaded: impact.cascadedChanges.length,
    skipped: impact.skipped.length,
    impact,
  };
}

/** Convenience wrapper used by tests and the schedule screen. */
export async function scheduleSummary(entity: ScheduleEntity) {
  return assessSchedule(entity);
}

export async function listDependencies(type: EntityType, ids: string[]) {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(depTable)
    .where(
      or(
        and(eq(depTable.predecessorType, type), inArray(depTable.predecessorId, ids)),
        and(eq(depTable.successorType, type), inArray(depTable.successorId, ids)),
      ),
    );
}
