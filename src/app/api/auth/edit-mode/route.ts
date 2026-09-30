import { z } from 'zod';
import { context, fail, ok } from '@/lib/api';
import { setEditMode } from '@/lib/login';

export const dynamic = 'force-dynamic';

const schema = z.object({ on: z.boolean() });

/** Edit Mode on or off (Admin and Super Admin). Off on every sign-in. */
export async function POST(req: Request) {
  try {
    const ctx = await context(req);
    const { on } = schema.parse(await req.json());
    if (ctx.user.loginRole === 'VIEWER' || !ctx.user.sessionId) {
      return fail(Object.assign(new Error('Edit Mode is for Admin and Super Admin.'), { status: 403 }));
    }
    await setEditMode(ctx.user.sessionId, on);
    return ok({ editMode: on });
  } catch (e) {
    return fail(e);
  }
}
