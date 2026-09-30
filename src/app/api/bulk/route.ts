import { fail, ok, requirePermission } from '@/lib/api';
import { reschedulePermissionFor, type Permission } from '@/lib/rbac';
import { applyBulk } from '@/lib/services/updates';
import { bulkActionSchema, rejectForbiddenFields } from '@/lib/validation';

export const dynamic = 'force-dynamic';

function bulkPermission(entityType: string, action: string): Permission {
  if (action === 'CHANGE_EXPECTED_DATE') return reschedulePermissionFor(entityType);
  const completion = action === 'MARK_COMPLETED' || action === 'MARK_NOT_COMPLETED';
  switch (entityType) {
    case 'DRAWING':
      if (action === 'MARK_NOT_COMPLETED') return 'drawing.admin';
      return completion ? 'drawing.complete' : 'drawing.write';
    case 'DELIVERABLE':
      return completion ? 'deliverable.complete' : 'deliverable.write';
    case 'GOAL':
      return 'goal.write';
    default:
      return 'project.write';
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    rejectForbiddenFields(body);
    const input = bulkActionSchema.parse(body);
    await requirePermission(req, 'bulk.update');
    // Bulk is a convenience, not a way round the per-entity permissions: the
    // same permission a single update of that kind needs is required here.
    const ctx = await requirePermission(req, bulkPermission(input.entityType, input.action));
    const result = await applyBulk(
      {
        entityType: input.entityType,
        ids: input.ids,
        action: input.action,
        actualReleaseDate: input.actualReleaseDate ?? null,
        expectedDate: input.expectedDate ?? null,
        ownerId: input.ownerId ?? null,
        remark: input.remark,
        revision: input.revision,
        reason: input.reason,
      },
      ctx.actor,
    );
    return ok(result, result.validation.length ? 422 : 200);
  } catch (e) {
    return fail(e);
  }
}
