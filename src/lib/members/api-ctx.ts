/** The admin context of a members request: who acts, with which rights, and the app's address (invite links). */
import type { ApiContext } from '@/lib/api';
import type { AdminCtx } from './service';

export function adminCtx(ctx: ApiContext, req: Request): AdminCtx {
  const forwarded = req.headers.get('x-forwarded-host');
  const proto = req.headers.get('x-forwarded-proto') ?? new URL(req.url).protocol.replace(':', '');
  const origin = forwarded ? `${proto}://${forwarded}` : new URL(req.url).origin;
  return { principal: ctx.user.principal, actor: ctx.actor, memberId: ctx.user.member?.id ?? null, origin };
}
