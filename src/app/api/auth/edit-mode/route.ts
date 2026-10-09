import { z } from 'zod';
import { context, fail, ok } from '@/lib/api';
import { setEditMode } from '@/lib/login';
import { can } from '@/lib/members/policy';

export const dynamic = 'force-dynamic';

const schema = z.object({ on: z.boolean() });

/**
 * Edit Mode on or off: for a person with Edit on at least one project (each
 * write still checks the project of its row). Off at every sign-in and after
 * 30 minutes without a request.
 */
export async function POST(req: Request) {
  try {
    const ctx = await context(req);
    const { on } = schema.parse(await req.json());
    if (!ctx.user.sessionId || (on && !can(ctx.user.principal, 'edit'))) {
      return fail(Object.assign(new Error('Edit Mode is not part of your access.'), { status: 403 }));
    }
    await setEditMode(ctx.user.sessionId, on);
    return ok({ editMode: on });
  } catch (e) {
    return fail(e);
  }
}
