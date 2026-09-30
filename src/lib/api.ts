import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { apiAllowed } from './access';
import { getCurrentUser, actorOf, userCan, UnauthenticatedError, type SessionUser } from './auth';
import { ForbiddenError, type Permission } from './rbac';

export interface ApiContext {
  user: SessionUser;
  actor: { id: string | null; label: string };
}

/** Refused for this sign-in role, whatever the user's permissions. */
export class RouteForbiddenError extends Error {
  status = 403;
}

export async function context(req: Request): Promise<ApiContext> {
  const user = await getCurrentUser(req.headers);
  // The sign-in role's own gate (the middleware applies the same rule first).
  const url = new URL(req.url);
  if (!apiAllowed(user.loginRole, req.method, url.pathname, url.search)) {
    throw new RouteForbiddenError('Your sign-in does not include this. Switch User to sign in with another role.');
  }
  return { user, actor: actorOf(user) };
}

export async function requirePermission(req: Request, permission: Permission): Promise<ApiContext> {
  const ctx = await context(req);
  if (!userCan(ctx.user, permission)) throw new ForbiddenError(permission, ctx.user.role);
  return ctx;
}

export function ok<T>(data: T, init?: number) {
  return NextResponse.json(data, { status: init ?? 200 });
}

export function fail(err: unknown) {
  if (err instanceof ForbiddenError || err instanceof RouteForbiddenError) {
    return NextResponse.json({ error: err.message, code: 'FORBIDDEN' }, { status: 403 });
  }
  if (err instanceof ZodError) {
    return NextResponse.json(
      { error: 'Some of the values sent are not valid. Please check them and try again.', code: 'VALIDATION', issues: err.issues },
      { status: 422 },
    );
  }
  if (err instanceof UnauthenticatedError) {
    return NextResponse.json({ error: err.message, code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const message = err instanceof Error ? err.message : String(err);
  const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : /not found/i.test(message) ? 404 : 400;
  // Database and programming errors are logged, never shown as they are.
  if (/relation|column|syntax|violates|ECONN|timeout|TypeError|ReferenceError|Cannot read/i.test(message)) {
    console.error(err);
    return NextResponse.json({ error: 'Something went wrong on the server. Please try again, or contact an Administrator if it keeps happening.', code: 'ERROR' }, { status: 500 });
  }
  return NextResponse.json({ error: message, code: 'ERROR' }, { status });
}

export function searchParams(req: Request): URLSearchParams {
  return new URL(req.url).searchParams;
}
