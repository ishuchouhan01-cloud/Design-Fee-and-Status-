import { fail, ok, requirePermission } from '@/lib/api';
import { getGoal } from '@/lib/services/queries';
import { updateEntity } from '@/lib/services/updates';
import { goalUpdateSchema, rejectForbiddenFields } from '@/lib/validation';
import { auditForEntity } from '@/lib/audit';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requirePermission(req, 'goal.read');
    const { id } = await params;
    const goal = await getGoal(id);
    if (!goal) return fail(new Error('Goal not found'));
    return ok({ goal, audit: await auditForEntity('GOAL', id, 50) });
  } catch (e) {
    return fail(e);
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requirePermission(req, 'goal.write');
    const { id } = await params;
    const body = await req.json();
    rejectForbiddenFields(body);
    const { reason, ...patch } = goalUpdateSchema.parse(body);
    const result = await updateEntity('GOAL', id, patch as Record<string, unknown>, ctx.actor, reason);
    return ok(result);
  } catch (e) {
    return fail(e);
  }
}
