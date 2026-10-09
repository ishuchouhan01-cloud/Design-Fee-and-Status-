import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { getCurrentUser, actorOf, userCan, UnauthenticatedError, type SessionUser } from './auth';
import { routeAllowed } from './members/gate';
import { can, projectsFor, type Action } from './members/policy';
import { projectOf, type EntityKind } from './members/principal';
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
  // The one rule (lib/members/policy can), as the middleware applies it first.
  const url = new URL(req.url);
  if (!routeAllowed(user, 'api', req.method, url.pathname, url.search)) {
    throw new RouteForbiddenError(user.member ? 'Your access does not include this. Ask your Project Admin.' : 'Your sign-in does not include this. Switch User to sign in with another role.');
  }
  return { user, actor: actorOf(user) };
}

/**
 * The project of the row a request touches must allow the action: a member
 * of project A gets 403 on anything that belongs to project B, even by id.
 * A row that does not exist is 404.
 */
export async function requireProject(ctx: ApiContext, action: Action, projectId: string | null | undefined): Promise<void> {
  if (!projectId) {
    if (ctx.user.principal.accountAdmin || ctx.user.principal.kind === 'legacy') return;
    throw Object.assign(new Error('This record was not found.'), { status: 404 });
  }
  if (!can(ctx.user.principal, action, projectId)) throw new RouteForbiddenError('This belongs to a project you do not have access to.');
}

/** requireProject for the project of a row given by id (drawing, package, fee line …). */
export async function requireEntity(ctx: ApiContext, action: Action, kind: EntityKind, id: string | null | undefined): Promise<string | null> {
  const projectId = await projectOf(kind, id);
  if (!projectId) throw Object.assign(new Error('This record was not found.'), { status: 404 });
  await requireProject(ctx, action, projectId);
  return projectId;
}

/** The projects the person may see for an action (null = all), for the services that list data. */
export function scopeOf(ctx: ApiContext, action: Action = 'status'): string[] | null {
  const s = projectsFor(ctx.user.principal, action);
  return s ? [...s] : null;
}

/** Billing fields stay only on rows of projects where Billing is on. */
export function billingFor(ctx: ApiContext): (projectId: string | null | undefined) => boolean {
  if (!userCan(ctx.user, 'billing.read')) return () => false;
  return (projectId) => can(ctx.user.principal, 'billing', projectId ?? undefined);
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

/** Billing on for every project in view (the header totals carry billing only then). */
export function billingEverywhere(ctx: ApiContext, scope: string[] | null): boolean {
  if (!userCan(ctx.user, 'billing.read')) return false;
  const b = projectsFor(ctx.user.principal, 'billing');
  if (!b) return true;
  return !!scope && scope.every((id) => b.has(id));
}

/** A project asked for in the address must be one of the person's. */
export function requireInScope(projectId: string | null | undefined, scope: string[] | null): void {
  if (projectId && scope && !scope.includes(projectId)) throw new RouteForbiddenError('This belongs to a project you do not have access to.');
}
