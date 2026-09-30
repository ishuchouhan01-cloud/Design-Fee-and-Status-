/**
 * Reschedule endpoint.
 *
 *   POST with confirm:false  → impact preview, nothing written
 *   POST with confirm:true   → applies the reschedule
 *
 * There is no way to move dates without having been able to see the preview,
 * and no path that writes without an explicit confirm (spec §13, §43).
 */
import { fail, ok, requirePermission } from '@/lib/api';
import { applyReschedule, previewReschedule } from '@/lib/reschedule';
import { resolveScopeIds } from '@/lib/repo/entities';
import { rescheduleSchema } from '@/lib/validation';
import { reschedulePermissionFor } from '@/lib/rbac';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const input = rescheduleSchema.parse(body);
    // Drawings: `drawing.reschedule` (Editor+), so Drawing Control can manage
    // drawing schedules without the Manager-level `schedule.reschedule`.
    const ctx = await requirePermission(req, reschedulePermissionFor(input.entityType));

    if (!input.newExpectedDate && input.shiftDays == null) {
      throw new Error('Provide either a new expected date or a shift in days.');
    }
    if (input.newExpectedDate && input.shiftDays != null) {
      throw new Error('Provide a new expected date OR a shift in days, not both.');
    }

    const ids = await resolveScopeIds({
      type: input.entityType,
      scope: input.scope,
      ids: input.ids,
      projectId: input.projectId,
      packageId: input.packageId,
      disciplineId: input.disciplineId,
      goalId: input.goalId,
      includeCompleted: false,
    });
    if (ids.length === 0) throw new Error('The selected scope contains no incomplete records to reschedule.');
    if (input.newExpectedDate && ids.length > 1 && input.scope !== 'SELECTION' && input.scope !== 'ITEM') {
      // Moving many items to one identical date is almost always a mistake;
      // a uniform shift is what scope-level rescheduling means.
      throw new Error(
        `Scope "${input.scope}" resolved to ${ids.length} records. Use a shift in days for a scope-level reschedule, or narrow the scope.`,
      );
    }

    const request = {
      entityType: input.entityType,
      entityIds: ids,
      newExpectedDate: input.newExpectedDate ?? null,
      shiftDays: input.shiftDays ?? null,
      reason: input.reason,
      scope: input.scope,
      options: input.options,
    };

    if (!input.confirm) {
      const impact = await previewReschedule(request);
      return ok({ mode: 'PREVIEW', impact });
    }
    const result = await applyReschedule(request, ctx.actor);
    return ok({ mode: 'APPLIED', ...result });
  } catch (e) {
    return fail(e);
  }
}
