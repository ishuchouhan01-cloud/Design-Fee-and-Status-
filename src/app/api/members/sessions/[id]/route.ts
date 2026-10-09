import { context, fail, ok } from '@/lib/api';
import { adminCtx } from '@/lib/members/api-ctx';
import { endSession } from '@/lib/members/service';

export const dynamic = 'force-dynamic';

/** End one session of a member (member detail → Sessions). */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = adminCtx(await context(req), req);
    await endSession(ctx, (await params).id);
    return ok({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
