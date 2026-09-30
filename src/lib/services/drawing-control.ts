/**
 * Drawing Control — write side. Every function takes an already-authorised
 * actor (route handlers check the permission first), validates its own
 * business rules, writes in one transaction, and audits every change.
 *
 * What cannot happen through here, by construction:
 *   - a baseline date change (no function writes one after creation);
 *   - an expected-date change (that is `applyReschedule` only, which writes
 *     reschedule history and a RESCHEDULE_DRAWING audit row);
 *   - a revision being overwritten (revisions are only ever added; a release
 *     stamps the revision row it releases);
 *   - a release without an explicit "Mark as Released" and an actual date.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, type DbLike } from '@/db';
import {
  disciplines,
  drawingConflicts,
  drawingDependencies,
  drawingLocationPhaseMap,
  drawingRevisions,
  drawingSnapshots,
  drawings,
  packages,
  projectPhases,
  projects,
} from '@/db/schema';
import { recordAudit, type Actor } from '@/lib/audit';
import { mergeEditedFields, parseEditedFields } from '@/lib/domain';
import { newId } from '@/lib/ids';
import { calendarQuarter, startOfDay } from '@/lib/periods';
import { fmtDate } from '@/lib/import/drawing-register/plan';

type DrawingRow = typeof drawings.$inferSelect;

export class DrawingRuleError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'DrawingRuleError';
  }
}

function fmt(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

async function loadDrawing(id: string, tx: DbLike = db): Promise<DrawingRow> {
  const [row] = await tx.select().from(drawings).where(eq(drawings.id, id)).limit(1);
  if (!row) throw new Error(`Drawing ${id} not found`);
  return row;
}

const labelOf = (d: Pick<DrawingRow, 'drawingCode' | 'drawingName' | 'numberStatus'>) =>
  `${d.numberStatus === 'NOT_YET_NUMBERED' ? 'Not yet numbered' : d.drawingCode} — ${d.drawingName}`;

function today() {
  return startOfDay(new Date());
}

async function assertNumberFree(tx: DbLike, projectId: string, code: string, exceptId?: string) {
  const [clash] = await tx
    .select({ id: drawings.id })
    .from(drawings)
    .where(and(eq(drawings.projectId, projectId), sql`upper(${drawings.drawingCode}) = upper(${code})`))
    .limit(1);
  if (clash && clash.id !== exceptId) {
    throw new DrawingRuleError(`Drawing number ${code} already exists in this project. One drawing per project + number.`);
  }
}

async function assertPhaseInProject(tx: DbLike, projectId: string, phaseId: string | null | undefined) {
  if (!phaseId) return;
  const [ph] = await tx.select().from(projectPhases).where(eq(projectPhases.id, phaseId)).limit(1);
  if (!ph || ph.projectId !== projectId) throw new DrawingRuleError('The phase does not belong to the drawing’s project.');
}

// ---------------------------------------------------------------------------
// Create / edit
// ---------------------------------------------------------------------------

export interface CreateDrawingInput {
  projectId: string;
  drawingNumber?: string | null;
  drawingName: string;
  phaseId?: string | null;
  disciplineId?: string | null;
  packageId?: string | null;
  location?: string | null;
  batchCode?: string | null;
  batch?: string | null;
  revision?: string | null;
  expectedReleaseDate?: Date | null;
  responsibleUserId?: string | null;
  responsibleText?: string | null;
  remarks?: string | null;
}

/** "+ Add Drawing". Starts NOT RELEASED with no actual date. */
export async function createDrawing(input: CreateDrawingInput, actor: Actor) {
  const [project] = await db.select().from(projects).where(eq(projects.id, input.projectId)).limit(1);
  if (!project) throw new Error('Project not found');
  const id = newId('dw_');
  const numbered = Boolean(input.drawingNumber?.trim());
  const code = numbered ? input.drawingNumber!.trim() : `NYN-M-${id.slice(3).toUpperCase()}`;
  const expected = input.expectedReleaseDate ? startOfDay(input.expectedReleaseDate) : null;
  const provided = Object.entries(input)
    .filter(([k, v]) => v != null && v !== '' && k !== 'projectId')
    .map(([k]) => (k === 'drawingNumber' ? 'drawingCode' : k === 'expectedReleaseDate' ? 'currentExpectedReleaseDate' : k));
  await db.transaction(async (tx) => {
    if (numbered) await assertNumberFree(tx, input.projectId, code);
    await assertPhaseInProject(tx, input.projectId, input.phaseId);
    await tx.insert(drawings).values({
      id,
      projectId: input.projectId,
      phaseId: input.phaseId ?? null,
      packageId: input.packageId ?? null,
      disciplineId: input.disciplineId ?? null,
      drawingCode: code,
      drawingNumber: numbered ? code : null,
      numberStatus: numbered ? 'NUMBERED' : 'NOT_YET_NUMBERED',
      drawingName: input.drawingName.trim(),
      location: input.location ?? null,
      batchCode: input.batchCode ?? null,
      batch: input.batch ?? null,
      revision: input.revision?.trim() || null,
      // A new drawing's first plan is its baseline; it is never changed afterwards.
      baselineReleaseDate: expected,
      currentExpectedReleaseDate: expected,
      actualReleaseDate: null,
      completionStatus: 'NOT_COMPLETED',
      responsibleUserId: input.responsibleUserId ?? null,
      responsibleText: input.responsibleText ?? null,
      remarks: input.remarks ?? null,
      planPeriodLabel: expected ? `CY${expected.getUTCFullYear()} Q${Math.floor(expected.getUTCMonth() / 3) + 1}` : null,
      isManual: true,
      userEditedFields: mergeEditedFields('', [...provided, 'drawingName', 'completionStatus']),
      updatedAt: new Date(),
      editedAt: new Date(),
    });
    if (input.revision?.trim()) {
      await tx.insert(drawingRevisions).values({
        id: newId('drv_'),
        drawingId: id,
        revision: input.revision.trim(),
        sequence: 0,
        expectedReleaseDate: expected,
        completionStatus: 'NOT_COMPLETED',
        source: 'MANUAL',
        createdById: actor.id,
        createdByLabel: actor.label,
        updatedAt: new Date(),
      });
    }
    await recordAudit(
      {
        actor,
        entityType: 'DRAWING',
        entityId: id,
        entityLabel: `${numbered ? code : 'Not yet numbered'} — ${input.drawingName}`,
        action: 'CREATE_DRAWING',
        newValue: JSON.stringify({ ...input, drawingCode: code }),
        projectId: input.projectId,
      },
      tx,
    );
  });
  return { id, drawingCode: code };
}

export type DrawingMetadataPatch = Partial<
  Pick<
    DrawingRow,
    | 'drawingName'
    | 'phaseId'
    | 'disciplineId'
    | 'packageId'
    | 'location'
    | 'areaOfWorks'
    | 'batchCode'
    | 'batch'
    | 'responsibleUserId'
    | 'responsibleText'
    | 'remarks'
  >
> & { drawingNumber?: string };

const FORBIDDEN_IN_EDIT: Record<string, string> = {
  baselineReleaseDate: 'Baseline dates are immutable.',
  currentExpectedReleaseDate: 'Change the expected date with Reschedule — every move is recorded in the reschedule history.',
  completionStatus: 'Use "Mark as Released" to release a drawing.',
  actualReleaseDate: 'The actual release date is recorded by "Mark as Released".',
  revision: 'Use "Add Revision" — revision history is never overwritten.',
};

/**
 * Edit drawing metadata. Assigning a number to a not-yet-numbered drawing
 * updates the SAME record (and keeps its import key, so a re-import still
 * finds it) rather than creating a second drawing.
 */
export async function updateDrawing(id: string, patch: DrawingMetadataPatch & Record<string, unknown>, actor: Actor, reason?: string) {
  for (const k of Object.keys(patch)) {
    if (FORBIDDEN_IN_EDIT[k] && patch[k] !== undefined) throw new DrawingRuleError(FORBIDDEN_IN_EDIT[k]);
  }
  return db.transaction(async (tx) => {
    const before = await loadDrawing(id, tx);
    const effective: Record<string, unknown> = {};
    const changes: { field: string; from: unknown; to: unknown }[] = [];
    const set = (field: keyof DrawingRow, to: unknown) => {
      const from = before[field];
      if (fmt(from) === fmt(to)) return;
      effective[field] = to;
      changes.push({ field, from, to });
    };
    if (patch.drawingNumber !== undefined) {
      const no = patch.drawingNumber.trim();
      if (no.toUpperCase() !== before.drawingCode.toUpperCase()) await assertNumberFree(tx, before.projectId, no, id);
      set('drawingCode', no);
      set('drawingNumber', no);
      set('numberStatus', 'NUMBERED');
    }
    if (patch.phaseId !== undefined) await assertPhaseInProject(tx, before.projectId, patch.phaseId);
    if (patch.packageId) {
      const [pk] = await tx.select().from(packages).where(eq(packages.id, patch.packageId)).limit(1);
      if (!pk || pk.projectId !== before.projectId) throw new DrawingRuleError('The package does not belong to the drawing’s project.');
    }
    for (const f of ['drawingName', 'phaseId', 'disciplineId', 'packageId', 'location', 'areaOfWorks', 'batchCode', 'batch', 'responsibleUserId', 'responsibleText', 'remarks'] as const) {
      if (patch[f] !== undefined) set(f, patch[f] === '' ? null : patch[f]);
    }
    if (changes.length === 0) return { id, changes: [] };
    await tx
      .update(drawings)
      .set({ ...effective, userEditedFields: mergeEditedFields(before.userEditedFields, changes.map((c) => c.field)), updatedAt: new Date(), editedAt: new Date() } as never)
      .where(eq(drawings.id, id));
    for (const c of changes) {
      await recordAudit(
        {
          actor,
          entityType: 'DRAWING',
          entityId: id,
          entityLabel: labelOf(before),
          action: 'UPDATE_DRAWING',
          field: c.field,
          oldValue: fmt(c.from),
          newValue: fmt(c.to),
          reason: reason ?? null,
          projectId: before.projectId,
        },
        tx,
      );
    }
    return { id, changes: changes.map((c) => ({ field: c.field, oldValue: fmt(c.from), newValue: fmt(c.to) })) };
  });
}

// ---------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------

/**
 * "Mark as Released". Records the actual release date, who released it and
 * when, stamps the revision row, and audits RELEASE_DRAWING. The baseline is
 * untouched, so on-time / late stays measurable.
 *
 * On a drawing that is already RELEASED this releases its current (newer)
 * revision instead; the drawing's first actual release date is kept.
 */
export async function releaseDrawing(
  id: string,
  input: { actualReleaseDate: Date; revision?: string; remarks?: string },
  actor: Actor,
) {
  const actual = startOfDay(input.actualReleaseDate);
  if (actual.getTime() > today().getTime()) throw new DrawingRuleError('The actual release date cannot be in the future.');
  return db.transaction(async (tx) => {
    const d = await loadDrawing(id, tx);
    const stamp = new Date();
    let revision = d.revision;
    if (input.revision && input.revision !== d.revision) {
      await addRevisionTx(tx, d, { revision: input.revision, remarks: input.remarks }, actor);
      revision = input.revision;
    }
    const [revRow] = await tx
      .select()
      .from(drawingRevisions)
      .where(and(eq(drawingRevisions.drawingId, id), revision == null ? isNull(drawingRevisions.revision) : eq(drawingRevisions.revision, revision)))
      .limit(1);

    const alreadyReleased = d.completionStatus === 'COMPLETED';
    if (alreadyReleased && revRow?.completionStatus === 'COMPLETED') {
      throw new DrawingRuleError(`${labelOf(d)} is already RELEASED${revision ? ` at ${revision}` : ''}. Add a new revision to issue it again.`);
    }

    if (revRow) {
      await tx
        .update(drawingRevisions)
        .set({
          completionStatus: 'COMPLETED',
          actualReleaseDate: actual,
          releasedById: actor.id,
          releasedByLabel: actor.label,
          releasedAt: stamp,
          remarks: input.remarks ? [revRow.remarks, input.remarks].filter(Boolean).join('\n') : revRow.remarks,
          updatedAt: stamp,
        })
        .where(eq(drawingRevisions.id, revRow.id));
    } else {
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(drawingRevisions).where(eq(drawingRevisions.drawingId, id));
      await tx.insert(drawingRevisions).values({
        id: newId('drv_'),
        drawingId: id,
        revision,
        sequence: n,
        expectedReleaseDate: d.currentExpectedReleaseDate,
        actualReleaseDate: actual,
        completionStatus: 'COMPLETED',
        releasedById: actor.id,
        releasedByLabel: actor.label,
        releasedAt: stamp,
        remarks: input.remarks ?? null,
        source: 'MANUAL',
        createdById: actor.id,
        createdByLabel: actor.label,
        updatedAt: stamp,
      });
    }

    if (!alreadyReleased) {
      await tx
        .update(drawings)
        .set({
          completionStatus: 'COMPLETED',
          actualReleaseDate: actual,
          releasedById: actor.id,
          releasedByLabel: actor.label,
          releasedAt: stamp,
          userEditedFields: mergeEditedFields(d.userEditedFields, ['completionStatus', 'actualReleaseDate']),
          updatedAt: stamp,
          editedAt: stamp,
        })
        .where(eq(drawings.id, id));
    }
    else await tx.update(drawings).set({ updatedAt: stamp, editedAt: stamp }).where(eq(drawings.id, id));
    await recordAudit(
      {
        actor,
        entityType: 'DRAWING',
        entityId: id,
        entityLabel: labelOf(d),
        action: 'RELEASE_DRAWING',
        field: alreadyReleased ? 'revision' : 'completionStatus',
        oldValue: alreadyReleased ? `${revision} not released` : 'NOT_COMPLETED',
        newValue: alreadyReleased ? `${revision} released ${actual.toISOString().slice(0, 10)}` : `COMPLETED ${actual.toISOString().slice(0, 10)}${revision ? ` (${revision})` : ''}`,
        reason: input.remarks ?? null,
        projectId: d.projectId,
      },
      tx,
    );
    return { id, revision, actualReleaseDate: actual, revisionOnly: alreadyReleased };
  });
}

/** Withdraw a release (admin). Clears the actual date; the revision row keeps
 *  a note of the withdrawn release rather than losing it. */
export async function unreleaseDrawing(id: string, reason: string, actor: Actor) {
  return db.transaction(async (tx) => {
    const d = await loadDrawing(id, tx);
    if (d.completionStatus !== 'COMPLETED') throw new DrawingRuleError(`${labelOf(d)} is not released.`);
    const stamp = new Date();
    const note = `Release withdrawn ${stamp.toISOString().slice(0, 10)} by ${actor.label}: ${reason}` +
      (d.actualReleaseDate ? ` (was released ${d.actualReleaseDate.toISOString().slice(0, 10)})` : '');
    await tx
      .update(drawings)
      .set({
        completionStatus: 'NOT_COMPLETED',
        actualReleaseDate: null,
        releasedById: null,
        releasedByLabel: null,
        releasedAt: null,
        userEditedFields: mergeEditedFields(d.userEditedFields, ['completionStatus', 'actualReleaseDate']),
        updatedAt: stamp,
        editedAt: stamp,
      })
      .where(eq(drawings.id, id));
    const [revRow] = await tx
      .select()
      .from(drawingRevisions)
      .where(and(eq(drawingRevisions.drawingId, id), d.revision == null ? isNull(drawingRevisions.revision) : eq(drawingRevisions.revision, d.revision)))
      .limit(1);
    if (revRow) {
      await tx
        .update(drawingRevisions)
        .set({ completionStatus: 'NOT_COMPLETED', remarks: [revRow.remarks, note].filter(Boolean).join('\n'), updatedAt: stamp })
        .where(eq(drawingRevisions.id, revRow.id));
    }
    await recordAudit(
      {
        actor,
        entityType: 'DRAWING',
        entityId: id,
        entityLabel: labelOf(d),
        action: 'UNRELEASE_DRAWING',
        field: 'completionStatus',
        oldValue: `COMPLETED${d.actualReleaseDate ? ` ${d.actualReleaseDate.toISOString().slice(0, 10)}` : ''}`,
        newValue: 'NOT_COMPLETED',
        reason,
        projectId: d.projectId,
      },
      tx,
    );
    return { id };
  });
}

// ---------------------------------------------------------------------------
// Revisions
// ---------------------------------------------------------------------------

async function addRevisionTx(
  tx: DbLike,
  d: DrawingRow,
  input: { revision: string; expectedReleaseDate?: Date | null; remarks?: string },
  actor: Actor,
) {
  const rev = input.revision.trim();
  const [exists] = await tx
    .select({ id: drawingRevisions.id })
    .from(drawingRevisions)
    .where(and(eq(drawingRevisions.drawingId, d.id), eq(drawingRevisions.revision, rev)))
    .limit(1);
  if (exists) throw new DrawingRuleError(`Revision ${rev} already exists for ${labelOf(d)}. Revisions are never overwritten.`);
  const [{ n }] = await tx.select({ n: sql<number>`coalesce(max(${drawingRevisions.sequence}) + 1, 0)::int` }).from(drawingRevisions).where(eq(drawingRevisions.drawingId, d.id));
  const revisionId = newId('drv_');
  await tx.insert(drawingRevisions).values({
    id: revisionId,
    drawingId: d.id,
    revision: rev,
    sequence: n,
    expectedReleaseDate: input.expectedReleaseDate ? startOfDay(input.expectedReleaseDate) : null,
    completionStatus: 'NOT_COMPLETED',
    remarks: input.remarks ?? null,
    source: 'MANUAL',
    createdById: actor.id,
    createdByLabel: actor.label,
    updatedAt: new Date(),
  });
  await tx
    .update(drawings)
    .set({ revision: rev, userEditedFields: mergeEditedFields(d.userEditedFields, ['revision']), updatedAt: new Date(), editedAt: new Date() })
    .where(eq(drawings.id, d.id));
  await recordAudit(
    {
      actor,
      entityType: 'DRAWING',
      entityId: d.id,
      entityLabel: labelOf(d),
      action: 'CREATE_REVISION',
      field: 'revision',
      oldValue: d.revision,
      newValue: rev,
      reason: input.remarks ?? null,
      projectId: d.projectId,
    },
    tx,
  );
  return revisionId;
}

/** "Add Revision": R1 → R2 adds a revision row and makes R2 current. The
 *  drawing's release status is unchanged; R2 itself is NOT RELEASED until it
 *  is marked released. */
export async function addRevision(id: string, input: { revision: string; expectedReleaseDate?: Date | null; remarks?: string }, actor: Actor) {
  return db.transaction(async (tx) => {
    const d = await loadDrawing(id, tx);
    const revisionId = await addRevisionTx(tx, d, input, actor);
    return { id, revisionId, revision: input.revision.trim() };
  });
}

/** Only the planned date and remarks of a revision can be edited; its label
 *  and its release record cannot. */
export async function updateRevision(revisionId: string, patch: { expectedReleaseDate?: Date | null; remarks?: string | null }, actor: Actor) {
  return db.transaction(async (tx) => {
    const [r] = await tx.select().from(drawingRevisions).where(eq(drawingRevisions.id, revisionId)).limit(1);
    if (!r) throw new Error('Revision not found');
    const d = await loadDrawing(r.drawingId, tx);
    const set: Record<string, unknown> = {};
    const changes: [string, unknown, unknown][] = [];
    if (patch.expectedReleaseDate !== undefined) {
      const v = patch.expectedReleaseDate ? startOfDay(patch.expectedReleaseDate) : null;
      if (fmt(v) !== fmt(r.expectedReleaseDate)) {
        set.expectedReleaseDate = v;
        changes.push(['expectedReleaseDate', r.expectedReleaseDate, v]);
      }
    }
    if (patch.remarks !== undefined && (patch.remarks ?? null) !== (r.remarks ?? null)) {
      set.remarks = patch.remarks;
      changes.push(['remarks', r.remarks, patch.remarks]);
    }
    if (!changes.length) return { id: revisionId, changes: [] };
    await tx.update(drawingRevisions).set({ ...set, updatedAt: new Date() }).where(eq(drawingRevisions.id, revisionId));
    for (const [field, from, to] of changes) {
      await recordAudit(
        {
          actor,
          entityType: 'DRAWING',
          entityId: d.id,
          entityLabel: `${labelOf(d)} · ${r.revision ?? '(no revision)'}`,
          action: 'UPDATE_REVISION',
          field: `revision.${field}`,
          oldValue: fmt(from),
          newValue: fmt(to),
          projectId: d.projectId,
        },
        tx,
      );
    }
    return { id: revisionId, changes: changes.map(([f]) => f) };
  });
}

// ---------------------------------------------------------------------------
// Department / task dependencies (NOT the FS/SS/FF scheduling links)
// ---------------------------------------------------------------------------

export interface DependencyInput {
  department: string;
  ownerUserId?: string | null;
  ownerText?: string | null;
  description: string;
  targetDate?: Date | null;
  remarks?: string | null;
}

export async function addDrawingDependency(drawingId: string, input: DependencyInput, actor: Actor) {
  return db.transaction(async (tx) => {
    const d = await loadDrawing(drawingId, tx);
    const id = newId('ddp_');
    await tx.insert(drawingDependencies).values({
      id,
      drawingId,
      projectId: d.projectId,
      department: input.department.trim(),
      ownerUserId: input.ownerUserId ?? null,
      ownerText: input.ownerText ?? null,
      description: input.description.trim(),
      targetDate: input.targetDate ? startOfDay(input.targetDate) : null,
      status: 'OPEN',
      remarks: input.remarks ?? null,
      isManual: true,
      source: 'MANUAL',
      createdById: actor.id,
      createdByLabel: actor.label,
      updatedAt: new Date(),
    });
    await recordAudit(
      {
        actor,
        entityType: 'DRAWING',
        entityId: drawingId,
        entityLabel: labelOf(d),
        action: 'ADD_DEPENDENCY',
        field: `dependency:${id}`,
        newValue: JSON.stringify(input),
        projectId: d.projectId,
      },
      tx,
    );
    return { id };
  });
}

export async function updateDrawingDependency(
  depId: string,
  patch: Partial<DependencyInput> & { closureDate?: Date | null; status?: 'OPEN' | 'CLOSED' },
  actor: Actor,
) {
  return db.transaction(async (tx) => {
    const [dep] = await tx.select().from(drawingDependencies).where(eq(drawingDependencies.id, depId)).limit(1);
    if (!dep) throw new Error('Dependency not found');
    const d = await loadDrawing(dep.drawingId, tx);
    const next: Record<string, unknown> = {};
    for (const k of ['department', 'ownerUserId', 'ownerText', 'description', 'remarks'] as const) {
      if (patch[k] !== undefined) next[k] = patch[k];
    }
    if (patch.targetDate !== undefined) next.targetDate = patch.targetDate ? startOfDay(patch.targetDate) : null;
    if (patch.status === 'CLOSED') {
      next.status = 'CLOSED';
      next.closureDate = startOfDay(patch.closureDate ?? dep.closureDate ?? new Date());
    } else if (patch.status === 'OPEN') {
      next.status = 'OPEN';
      next.closureDate = null;
    } else if (patch.closureDate !== undefined) {
      next.closureDate = patch.closureDate ? startOfDay(patch.closureDate) : null;
      if (patch.closureDate) next.status = 'CLOSED';
    }
    const changes = Object.entries(next).filter(([k, v]) => fmt((dep as Record<string, unknown>)[k]) !== fmt(v));
    if (!changes.length) return { id: depId, changes: [] };
    await tx
      .update(drawingDependencies)
      .set({ ...Object.fromEntries(changes), userEditedFields: mergeEditedFields(dep.userEditedFields, []), updatedAt: new Date() })
      .where(eq(drawingDependencies.id, depId));
    for (const [field, to] of changes) {
      await recordAudit(
        {
          actor,
          entityType: 'DRAWING',
          entityId: d.id,
          entityLabel: labelOf(d),
          action: 'UPDATE_DEPENDENCY',
          field: `dependency:${depId}.${field}`,
          oldValue: fmt((dep as Record<string, unknown>)[field]),
          newValue: fmt(to),
          projectId: d.projectId,
        },
        tx,
      );
    }
    return { id: depId, changes: changes.map(([k]) => k) };
  });
}

/** Only manually added dependencies can be deleted (every dependency today is
 *  manual; imported ones, if a future source provides them, are closed instead). */
export async function deleteDrawingDependency(depId: string, actor: Actor) {
  return db.transaction(async (tx) => {
    const [dep] = await tx.select().from(drawingDependencies).where(eq(drawingDependencies.id, depId)).limit(1);
    if (!dep) throw new Error('Dependency not found');
    if (!dep.isManual) throw new DrawingRuleError('Imported dependencies cannot be deleted — close them instead.');
    const d = await loadDrawing(dep.drawingId, tx);
    await tx.delete(drawingDependencies).where(eq(drawingDependencies.id, depId));
    await recordAudit(
      {
        actor,
        entityType: 'DRAWING',
        entityId: d.id,
        entityLabel: labelOf(d),
        action: 'DELETE_DEPENDENCY',
        field: `dependency:${depId}`,
        oldValue: JSON.stringify(dep),
        projectId: d.projectId,
      },
      tx,
    );
    return { id: depId };
  });
}

// ---------------------------------------------------------------------------
// Admin: delete, conflicts
// ---------------------------------------------------------------------------

/** Delete a drawing (admin). Permitted only for a drawing added manually that
 *  has never been released; imported drawings and released drawings stay. */
export async function deleteDrawing(id: string, reason: string, actor: Actor) {
  return db.transaction(async (tx) => {
    const d = await loadDrawing(id, tx);
    if (!d.isManual) throw new DrawingRuleError('Imported drawings cannot be deleted — they are part of the source register.');
    if (d.completionStatus === 'COMPLETED') throw new DrawingRuleError('A released drawing cannot be deleted.');
    const [rel] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(drawingRevisions)
      .where(and(eq(drawingRevisions.drawingId, id), eq(drawingRevisions.completionStatus, 'COMPLETED')));
    if (rel.n > 0) throw new DrawingRuleError('A drawing with a released revision cannot be deleted.');
    await tx.delete(drawings).where(eq(drawings.id, id));
    await recordAudit(
      {
        actor,
        entityType: 'DRAWING',
        entityId: id,
        entityLabel: labelOf(d),
        action: 'DELETE_DRAWING',
        oldValue: JSON.stringify(d),
        reason,
        projectId: d.projectId,
      },
      tx,
    );
    return { id };
  });
}

async function phaseFromMap(tx: DbLike, projectId: string, location: string | null, number: string | null) {
  const rows = await tx.select().from(drawingLocationPhaseMap).where(eq(drawingLocationPhaseMap.projectId, projectId));
  const loc = (location ?? '').toUpperCase();
  const zone = number ? (number.split('-')[1] ?? '').toUpperCase() : '';
  const hit =
    rows.find((r) => r.locationCode.toUpperCase() === loc && r.zoneCode && r.zoneCode.toUpperCase() === zone) ??
    rows.find((r) => r.locationCode.toUpperCase() === loc && !r.zoneCode) ??
    rows.find((r) => r.locationCode === '*');
  return hit?.phaseId ?? null;
}

/**
 * Resolve a held-back import conflict by choosing one candidate source row.
 * The drawing is created from that row; the others stay as snapshots. The
 * resolution is recorded, audited, and respected by every later import.
 */
export async function resolveConflict(conflictId: string, input: { candidateIndex: number; note: string }, actor: Actor) {
  return db.transaction(async (tx) => {
    const [c] = await tx.select().from(drawingConflicts).where(eq(drawingConflicts.id, conflictId)).limit(1);
    if (!c) throw new Error('Conflict not found');
    if (c.status !== 'OPEN') throw new DrawingRuleError(`This conflict is already ${c.status}.`);
    const candidates = JSON.parse(c.candidates) as Record<string, unknown>[];
    const pick = candidates[input.candidateIndex];
    if (!pick) throw new DrawingRuleError('No such candidate.');
    await assertNumberFree(tx, c.projectId, c.drawingNumber);

    const s = (k: string) => (pick[k] == null ? null : String(pick[k]));
    const isAcc = pick.source === 'ACC' || 'versions' in pick;
    const acc = candidates.find((x) => x.source === 'ACC' && x.number === c.drawingNumber) as Record<string, unknown> | undefined;
    const discCode = s('discipline') && !isAcc ? s('discipline') : null;
    const [disc] = discCode ? await tx.select().from(disciplines).where(eq(disciplines.code, discCode)).limit(1) : [];
    const location = isAcc ? null : s('location');
    const phaseId = await phaseFromMap(tx, c.projectId, location, c.drawingNumber);

    // Release: a plan row's issued flags (evidence only), or ACC's release date.
    let released = false;
    let actual: Date | null = null;
    let evidence: string | null = null;
    const accRow = isAcc ? pick : acc;
    if (accRow) {
      released = true;
      actual = accRow.releaseDate ? new Date(String(accRow.releaseDate)) : null;
      evidence = actual ? `ACC release ${fmtDate(actual)}` : 'In ACC export — no release date';
    } else if (pick.released) {
      released = true;
      evidence = pick.issuedTill
        ? `Issued before 01-Jan-${Number(pick.issuedTillYear ?? Number(pick.planYear) - 1) + 1}`
        : pick.issuedQuarter
          ? `Issued ${pick.planYear} Q${pick.issuedQuarter}`
          : `Issued in ${pick.planYear}`;
    }
    const planned = !isAcc && pick.plannedQuarter ? calendarQuarter(Number(pick.planYear), Number(pick.plannedQuarter)).end : null;

    const id = newId('dw_');
    await tx.insert(drawings).values({
      id,
      projectId: c.projectId,
      phaseId,
      disciplineId: disc?.id ?? null,
      drawingCode: c.drawingNumber,
      drawingNumber: c.drawingNumber,
      numberStatus: 'NUMBERED',
      drawingName: s('title') ?? '(untitled)',
      location,
      areaOfWorks: s('section'),
      batchCode: s('batchCode'),
      batch: s('batch'),
      revision: s('revision'),
      baselineReleaseDate: planned,
      currentExpectedReleaseDate: planned,
      actualReleaseDate: actual,
      completionStatus: released ? 'COMPLETED' : 'NOT_COMPLETED',
      releaseEvidence: evidence,
      planPeriodLabel: planned ? `CY${pick.planYear} Q${pick.plannedQuarter}` : null,
      collection: accRow ? (accRow.collection as string | null) ?? null : null,
      versionCount: accRow ? (accRow.versions as number | null) ?? null : null,
      tags: accRow ? (accRow.tags as string | null) ?? null : null,
      accDiscipline: accRow ? (accRow.discipline as string | null) ?? null : null,
      sourceKey: `NO:${c.drawingNumber}`,
      sourceWorkbook: s('workbook'),
      sourceSheet: s('sheet'),
      sourceRow: pick.row == null ? null : Number(pick.row),
      isManual: false,
      userEditedFields: '',
      updatedAt: new Date(),
    });
    if (s('revision')) {
      await tx.insert(drawingRevisions).values({
        id: newId('drv_'),
        drawingId: id,
        revision: s('revision'),
        sequence: 0,
        expectedReleaseDate: planned,
        actualReleaseDate: actual,
        completionStatus: released ? 'COMPLETED' : 'NOT_COMPLETED',
        releaseEvidence: evidence,
        source: 'IMPORT',
        sourceWorkbook: s('workbook'),
        sourceSheet: s('sheet'),
        sourceRow: pick.row == null ? null : Number(pick.row),
        createdById: actor.id,
        createdByLabel: actor.label,
        updatedAt: new Date(),
      });
    }
    await tx
      .update(drawingSnapshots)
      .set({ drawingId: id })
      .where(and(eq(drawingSnapshots.projectId, c.projectId), eq(drawingSnapshots.drawingNumber, c.drawingNumber), isNull(drawingSnapshots.drawingId)));
    await tx
      .update(drawingConflicts)
      .set({
        status: 'RESOLVED',
        resolutionNote: `Candidate ${input.candidateIndex + 1} ("${s('title')}", ${s('sheet')} row ${s('row')}): ${input.note}`,
        resolvedDrawingId: id,
        resolvedById: actor.id,
        resolvedByLabel: actor.label,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(drawingConflicts.id, conflictId));
    await recordAudit(
      {
        actor,
        entityType: 'DRAWING',
        entityId: id,
        entityLabel: `${c.drawingNumber} — ${s('title')}`,
        action: 'RESOLVE_CONFLICT',
        field: c.conflictType,
        oldValue: `${candidates.length} candidates`,
        newValue: JSON.stringify(pick),
        reason: input.note,
        projectId: c.projectId,
      },
      tx,
    );
    return { id, conflictId };
  });
}

export async function dismissConflict(conflictId: string, note: string, actor: Actor) {
  return db.transaction(async (tx) => {
    const [c] = await tx.select().from(drawingConflicts).where(eq(drawingConflicts.id, conflictId)).limit(1);
    if (!c) throw new Error('Conflict not found');
    if (c.status !== 'OPEN') throw new DrawingRuleError(`This conflict is already ${c.status}.`);
    await tx
      .update(drawingConflicts)
      .set({ status: 'DISMISSED', resolutionNote: note, resolvedById: actor.id, resolvedByLabel: actor.label, resolvedAt: new Date(), updatedAt: new Date() })
      .where(eq(drawingConflicts.id, conflictId));
    await recordAudit(
      {
        actor,
        entityType: 'DRAWING_CONFLICT',
        entityId: conflictId,
        entityLabel: c.drawingNumber,
        action: 'RESOLVE_CONFLICT',
        field: c.conflictType,
        newValue: 'DISMISSED',
        reason: note,
        projectId: c.projectId,
      },
      tx,
    );
    return { conflictId };
  });
}

export { parseEditedFields, inArray };
