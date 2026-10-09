/**
 * Authentication for Project Drawing Status: the sign-in screen (lib/login,
 * lib/members/auth) and its session cookie. There is no other way in — no
 * header, no default user. A request without a valid session is refused (401)
 * and a screen goes to the sign-in page.
 *
 * Every session carries a Principal (lib/members/policy): what `can()` allows,
 * per project. A personal sign-in (member) acts as a user record of role
 * Viewer (Administrator for an Account Admin) plus what their module switches
 * add; each shared role sign-in acts as a user record with an existing role:
 *   Viewer → Viewer · Admin → Manager (+ billing, release withdrawal) · Super Admin → Administrator
 * so every existing permission check still applies.
 */
import { cookieFromHeader, LOGIN_ROLE_LABEL, SESSION_COOKIE, type LoginRole, type SessionRole } from './access';
import { sessionFor } from './login';
import { EMERGENCY_LABEL } from './members/auth';
import { legacyPrincipal, memberPermissions, memberPrincipal } from './members/principal';
import type { Principal } from './members/policy';
import { can, type Permission } from './rbac';
import type { Role } from './domain';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** The sign-in role (Viewer, Admin, Super Admin) or MEMBER for a personal sign-in. */
  loginRole: SessionRole;
  sessionId: string | null;
  editMode: boolean;
  /** Permissions the sign-in adds to the user's role. */
  extraPermissions: Permission[];
  /** What the person may do, per project (lib/members/policy `can`). */
  principal: Principal;
  /** The signed-in member (personal sign-in); null for the shared role sign-ins. */
  member: { id: string; name: string; email: string; accountAdmin: boolean } | null;
  /** The emergency (break-glass) Account Admin sign-in. */
  emergency: boolean;
}

export class UnauthenticatedError extends Error {
  status = 401;
}

/** What each shared sign-in role adds to its user's existing role. */
export const LOGIN_EXTRA_PERMISSIONS: Record<LoginRole, Permission[]> = {
  VIEWER: [],
  ADMIN: ['billing.read', 'billing.write', 'drawing.admin'],
  SUPER_ADMIN: ['billing.read', 'billing.write'],
};

export async function getCurrentUser(headers?: Headers): Promise<SessionUser> {
  const cookie = cookieFromHeader(headers?.get('cookie'), SESSION_COOKIE);
  const s = cookie ? await sessionFor(cookie) : null;
  if (!s) throw new UnauthenticatedError('Please sign in to continue.');
  if (s.role === 'MEMBER' && s.member) {
    const principal = await memberPrincipal(s.member.id, s.member.accountAdmin);
    return {
      ...s.user,
      name: s.member.name,
      email: s.member.email,
      // The switches decide; the user record's own role never adds anything.
      role: s.member.accountAdmin ? 'ADMIN' : 'VIEWER',
      loginRole: 'MEMBER',
      sessionId: s.id,
      editMode: s.editMode,
      extraPermissions: memberPermissions(principal),
      principal,
      member: s.member,
      emergency: false,
    };
  }
  const role = s.role as LoginRole;
  return {
    ...s.user,
    loginRole: role,
    sessionId: s.id,
    editMode: s.editMode,
    extraPermissions: LOGIN_EXTRA_PERMISSIONS[role],
    principal: legacyPrincipal(role, s.emergency),
    member: null,
    emergency: s.emergency,
  };
}

export const ROLE_LABEL: Record<string, string> = { ADMIN: 'Administrator', MANAGER: 'Manager', EDITOR: 'Editor', VIEWER: 'Viewer' };

export function actorOf(user: Pick<SessionUser, 'id' | 'name' | 'email' | 'role' | 'loginRole' | 'member' | 'emergency'>) {
  // A member: their name and email, in every audit entry.
  if (user.member) return { id: user.id, label: `${user.member.name} <${user.member.email}>` };
  if (user.emergency) return { id: user.id, label: EMERGENCY_LABEL };
  // A sign-in role's own record is named after the role ("Super Admin").
  if (user.email.endsWith('@project-drawing-status.local')) return { id: user.id, label: LOGIN_ROLE_LABEL[user.loginRole as LoginRole] ?? user.name };
  return { id: user.id, label: `${user.name} (${ROLE_LABEL[user.role] ?? user.role})` };
}

/** The user's role permissions plus what the sign-in adds. */
export function userCan(user: Pick<SessionUser, 'role' | 'extraPermissions'>, permission: Permission): boolean {
  return can(user.role, permission) || (user.extraPermissions ?? []).includes(permission);
}
