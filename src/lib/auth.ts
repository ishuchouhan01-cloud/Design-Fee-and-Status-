/**
 * Authentication for Project Drawing Status: the sign-in screen (lib/login)
 * and its session cookie. There is no other way in — no header, no default
 * user. A request without a valid session is refused (401) and a screen goes
 * to the sign-in page.
 *
 * Each sign-in role acts as a user record with an existing role, so every
 * existing permission check still applies:
 *   Viewer → Viewer · Admin → Manager (+ billing, release withdrawal) · Super Admin → Administrator
 */
import { cookieFromHeader, LOGIN_ROLE_LABEL, SESSION_COOKIE, type LoginRole } from './access';
import { sessionFor } from './login';
import { can, type Permission } from './rbac';
import type { Role } from './domain';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** The sign-in role (Viewer, Admin, Super Admin). */
  loginRole: LoginRole;
  sessionId: string | null;
  editMode: boolean;
  /** Permissions the sign-in role adds to the user's role. */
  extraPermissions: Permission[];
}

export class UnauthenticatedError extends Error {
  status = 401;
}

/** What each sign-in role adds to its user's existing role. */
export const LOGIN_EXTRA_PERMISSIONS: Record<LoginRole, Permission[]> = {
  VIEWER: [],
  ADMIN: ['billing.read', 'billing.write', 'drawing.admin'],
  SUPER_ADMIN: ['billing.read', 'billing.write'],
};

export async function getCurrentUser(headers?: Headers): Promise<SessionUser> {
  const cookie = cookieFromHeader(headers?.get('cookie'), SESSION_COOKIE);
  const s = cookie ? await sessionFor(cookie) : null;
  if (!s) throw new UnauthenticatedError('Please sign in to continue.');
  return { ...s.user, loginRole: s.role, sessionId: s.id, editMode: s.editMode, extraPermissions: LOGIN_EXTRA_PERMISSIONS[s.role] };
}

export const ROLE_LABEL: Record<string, string> = { ADMIN: 'Administrator', MANAGER: 'Manager', EDITOR: 'Editor', VIEWER: 'Viewer' };

export function actorOf(user: SessionUser) {
  // A sign-in role's own record is named after the role ("Super Admin").
  if (user.email.endsWith('@project-drawing-status.local')) return { id: user.id, label: LOGIN_ROLE_LABEL[user.loginRole] };
  return { id: user.id, label: `${user.name} (${ROLE_LABEL[user.role] ?? user.role})` };
}

/** The user's role permissions plus what the sign-in role adds. */
export function userCan(user: Pick<SessionUser, 'role' | 'extraPermissions'>, permission: Permission): boolean {
  return can(user.role, permission) || (user.extraPermissions ?? []).includes(permission);
}
