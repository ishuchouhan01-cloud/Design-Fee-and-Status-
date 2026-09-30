/**
 * One drawing.
 *
 *   GET     detail                                      drawing.read
 *   PATCH   metadata                                    drawing.write
 *             completionStatus COMPLETED  → Mark as Released   drawing.complete
 *             completionStatus NOT_COMPLETED → withdraw release drawing.admin
 *             currentExpectedReleaseDate  → reschedule engine  drawing.reschedule
 *             revision                    → new revision row   drawing.write
 *   DELETE  manually added, never-released drawings     drawing.admin
 *
 * No field is written directly when it has a controlled path: an expected
 * date never changes without reschedule history and a RESCHEDULE_DRAWING
 * audit row.
 */
import { fail, ok, requirePermission } from '@/lib/api';
import { applyReschedule } from '@/lib/reschedule';
import { getDrawingDetail } from '@/lib/services/drawing-register';
import {
  addRevision,
  deleteDrawing,
  releaseDrawing,
  unreleaseDrawing,
  updateDrawing,
} from '@/lib/services/drawing-control';
import { drawingUpdateSchema, rejectForbiddenFields } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requirePermission(req, 'drawing.read');
    const { id } = await params;
    const detail = await getDrawingDetail(id);
    if (!detail) return fail(new Error('Drawing not found'));
    return ok(detail);
  } catch (e) {
    return fail(e);
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const body = await req.json();
    rejectForbiddenFields(body);
    const { reason, completionStatus, currentExpectedReleaseDate, actualReleaseDate, revision, ...meta } =
      drawingUpdateSchema.parse(body);
    const { id } = await params;

    // Check every permission the request needs before writing anything.
    const needed = new Set<Parameters<typeof requirePermission>[1]>();
    if (completionStatus === 'COMPLETED') needed.add('drawing.complete');
    if (completionStatus === 'NOT_COMPLETED') needed.add('drawing.admin');
    if (currentExpectedReleaseDate !== undefined) needed.add('drawing.reschedule');
    if (revision !== undefined || Object.values(meta).some((v) => v !== undefined)) needed.add('drawing.write');
    if (actualReleaseDate !== undefined && completionStatus !== 'COMPLETED') {
      throw new Error('An actual release date is recorded by "Mark as Released" (completionStatus: COMPLETED).');
    }
    if (needed.size === 0) throw new Error('Nothing to update.');
    let ctx = null as Awaited<ReturnType<typeof requirePermission>> | null;
    for (const p of needed) ctx = await requirePermission(req, p);
    const actor = ctx!.actor;

    const result: Record<string, unknown> = { id };
    if (Object.values(meta).some((v) => v !== undefined)) result.metadata = await updateDrawing(id, meta, actor, reason);
    if (revision !== undefined) result.revision = await addRevision(id, { revision, remarks: reason }, actor);
    if (currentExpectedReleaseDate !== undefined) {
      if (!currentExpectedReleaseDate) throw new Error('An expected date cannot be cleared; reschedule it to a new date.');
      if (!reason || reason.trim().length < 3) throw new Error('A reason is required for every reschedule.');
      result.reschedule = await applyReschedule(
        { entityType: 'DRAWING', entityIds: [id], newExpectedDate: currentExpectedReleaseDate, reason, scope: 'ITEM' },
        actor,
      );
    }
    if (completionStatus === 'COMPLETED') {
      result.release = await releaseDrawing(id, { actualReleaseDate: actualReleaseDate ?? new Date(), remarks: reason }, actor);
    } else if (completionStatus === 'NOT_COMPLETED') {
      if (!reason || reason.trim().length < 3) throw new Error('A reason is required to withdraw a release.');
      result.unrelease = await unreleaseDrawing(id, reason, actor);
    }
    return ok(result);
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requirePermission(req, 'drawing.admin');
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const reason = typeof body?.reason === 'string' && body.reason.trim().length >= 3 ? body.reason.trim() : null;
    if (!reason) throw new Error('A reason is required to delete a drawing.');
    return ok(await deleteDrawing(id, reason, ctx.actor));
  } catch (e) {
    return fail(e);
  }
}
