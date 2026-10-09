/**
 * The gate every request passes (middleware, layout, lib/api context()):
 * the route's need (policy.ts pageNeed / apiNeed) against `can()` for the
 * signed-in person. The project of a row is then checked by the handler.
 *
 * The shared role sign-ins keep their own matrix (lib/access pageAllowed /
 * apiAllowed) while LEGACY_ROLE_LOGINS is on; switched off, their sessions end.
 */
import { apiAllowed, pageAllowed, type SessionRole } from '@/lib/access';
import { apiNeed, can, pageNeed, planningEverywhere, type Principal, type RouteNeed } from './policy';

/** LEGACY_ROLE_LOGINS: on (default) = the Viewer / Admin / Super Admin cards still work; off = email sign-in only. */
export function legacyLoginsOn(): boolean {
  return !/^(off|false|0|no)$/i.test((process.env.LEGACY_ROLE_LOGINS ?? 'on').trim());
}

export function needAllowed(p: Principal, need: RouteNeed): boolean {
  if (need === 'public' || need === 'signedIn') return true;
  if (need === 'planningAll') return planningEverywhere(p);
  return can(p, need);
}

export interface GateUser {
  loginRole: SessionRole;
  principal: Principal;
  emergency: boolean;
}

export function routeAllowed(user: GateUser, kind: 'page' | 'api', method: string, pathname: string, search = ''): boolean {
  if (user.principal.kind === 'legacy' && !user.emergency) {
    const role = user.loginRole;
    if (role === 'MEMBER') return false;
    // The members screens need the members right (Super Admin has it; Admin and Viewer do not).
    if (kind === 'page' && /^\/settings\/(members|companies|roles)(\/|$)/.test(pathname)) return can(user.principal, 'members');
    return kind === 'page' ? pageAllowed(role, pathname, search) : apiAllowed(role, method, pathname, search);
  }
  const need = kind === 'page' ? pageNeed(pathname, search) : apiNeed(method, pathname, search);
  return needAllowed(user.principal, need);
}

/** Where a person starts: the Dashboard with Planning on every project, else Project Drawing Status. */
export function homeOf(p: Principal): string {
  return planningEverywhere(p) ? '/' : '/drawings';
}
