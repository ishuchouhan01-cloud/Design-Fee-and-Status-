import { fail, ok, requirePermission } from '@/lib/api';
import { getDeliverable } from '@/lib/services/queries';
import { setCompletion, updateEntity } from '@/lib/services/updates';
import { deliverableUpdateSchema, rejectForbiddenFields } from '@/lib/validation';
import { auditForEntity } from '@/lib/audit';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requirePermission(req, 'deliverable.read');
    const { id } = await params;
    const row = await getDeliverable(id);
    if (!row) return fail(new Error('Deliverable not found'));
    return ok({ deliverable: row, audit: await auditForEntity('DELIVERABLE', id, 50) });
  } catch (e) {
    return fail(e);
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const body = await req.json();
    rejectForbiddenFields(body);
    const { reason, ...patch } = deliverableUpdateSchema.parse(body);
    const { id } = await params;
    const needsComplete = patch.completionStatus !== undefined;
    const ctx = await requirePermission(req, needsComplete ? 'deliverable.complete' : 'deliverable.write');
    const onlyCompletion =
      needsComplete &&
      Object.keys(patch).filter((k) => k !== 'completionStatus' && k !== 'actualReleaseDate').length === 0;
    if (onlyCompletion) {
      return ok(
        await setCompletion('DELIVERABLE', id, patch.completionStatus!, ctx.actor, {
          actualDate: patch.actualReleaseDate ?? null,
          reason,
        }),
      );
    }
    return ok(await updateEntity('DELIVERABLE', id, patch as Record<string, unknown>, ctx.actor, reason));
  } catch (e) {
    return fail(e);
  }
}
