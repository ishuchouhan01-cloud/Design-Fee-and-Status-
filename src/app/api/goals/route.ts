import { fail, ok, requirePermission, searchParams } from '@/lib/api';
import { parseFilters } from '@/lib/services/filters';
import { queryGoals } from '@/lib/services/queries';
import { createGoal } from '@/lib/services/updates';
import { goalCreateSchema, rejectForbiddenFields } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requirePermission(req, 'goal.read');
    return ok(await queryGoals(parseFilters(searchParams(req))));
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await requirePermission(req, 'goal.write');
    const body = await req.json();
    rejectForbiddenFields(body);
    const input = goalCreateSchema.parse(body);
    return ok(await createGoal(input, ctx.actor), 201);
  } catch (e) {
    return fail(e);
  }
}
