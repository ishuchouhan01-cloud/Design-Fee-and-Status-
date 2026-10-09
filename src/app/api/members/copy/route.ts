import { z } from 'zod';
import { context, fail, ok } from '@/lib/api';
import { adminCtx } from '@/lib/members/api-ctx';
import { copyMembers } from '@/lib/members/service';

export const dynamic = 'force-dynamic';

const schema = z.object({ fromProjectId: z.string().min(1), toProjectId: z.string().min(1) });

/** Add members ▾ → Copy members from another project. */
export async function POST(req: Request) {
  try {
    const ctx = adminCtx(await context(req), req);
    const b = schema.parse(await req.json());
    return ok(await copyMembers(ctx, b.fromProjectId, b.toProjectId));
  } catch (e) {
    return fail(e);
  }
}
