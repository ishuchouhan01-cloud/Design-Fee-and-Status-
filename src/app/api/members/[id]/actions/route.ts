import { z } from 'zod';
import { context, fail, ok } from '@/lib/api';
import { adminCtx } from '@/lib/members/api-ctx';
import { copyAccess, deactivate, newInviteLink, reactivate, resetPassword } from '@/lib/members/service';

export const dynamic = 'force-dynamic';

type P = { params: Promise<{ id: string }> };

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('invite') }),
  z.object({ action: z.literal('reset') }),
  z.object({ action: z.literal('deactivate') }),
  z.object({ action: z.literal('reactivate') }),
  z.object({ action: z.literal('copyAccess'), fromProjectId: z.string().min(1), toProjectIds: z.array(z.string().min(1)).min(1).max(200) }),
]);

/** The row's ⋮ menu: copy invite link / resend, reset password, deactivate / reactivate, copy access. */
export async function POST(req: Request, { params }: P) {
  try {
    const ctx = adminCtx(await context(req), req);
    const id = (await params).id;
    const b = schema.parse(await req.json());
    if (b.action === 'invite') return ok(await newInviteLink(ctx, id));
    if (b.action === 'reset') return ok(await resetPassword(ctx, id));
    if (b.action === 'deactivate') await deactivate(ctx, id);
    else if (b.action === 'reactivate') await reactivate(ctx, id);
    else await copyAccess(ctx, id, b.fromProjectId, b.toProjectIds);
    return ok({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
