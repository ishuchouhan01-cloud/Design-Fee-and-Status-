/**
 * Sign-in for Project Drawing Status: three roles, server-side checks only.
 *
 *   Viewer       no password, one click — unless a Viewer password is set
 *                (VIEWER_PASSWORD at setup, or `npm run logins:set -- --role VIEWER`),
 *                e.g. before sharing a public link; then it signs in like the others
 *   Admin        password (ADMIN_PASSWORD at setup), stored as a bcrypt hash
 *   Super Admin  password (SUPER_ADMIN_PASSWORD at setup), stored as a bcrypt hash
 *
 * Passwords are never in the code or the repository. `ensureLoginAccounts()`
 * (run by db:setup and `npm run logins:set`) hashes them from the environment
 * into `login_accounts`; sign-in compares with the hash. A session is a random
 * token in an httpOnly, SameSite cookie with an expiry; only its SHA-256 is
 * stored. Failed passwords are rate-limited per role and address.
 *
 * Personal sign-in (email + password, lib/members/auth) uses the same
 * sessions: a MEMBER session carries member_id. Every session ends after
 * 60 minutes without a request (and at its 12 h expiry); Edit Mode goes off
 * after 30 minutes without one. With LEGACY_ROLE_LOGINS off the shared role
 * sign-ins are refused and their sessions end (the emergency sign-in stays).
 */
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { and, count, eq, gt, isNull, like } from 'drizzle-orm';
import { db } from '@/db';
import { loginAccounts, loginAttempts, loginSessions, members, users } from '@/db/schema';
import { LOGIN_ROLE_LABEL, readCookie, signCookie, type LoginRole, type SessionRole } from './access';
import { legacyLoginsOn } from './members/gate';
import { newId } from './ids';
import type { Role } from './domain';

/** The user record each sign-in role acts as (audit trail, existing permissions). */
export const LOGIN_USER: Record<LoginRole, { email: string; name: string; role: Role }> = {
  VIEWER: { email: 'viewer@project-drawing-status.local', name: 'Viewer', role: 'VIEWER' },
  ADMIN: { email: 'admin@project-drawing-status.local', name: 'Admin', role: 'MANAGER' },
  SUPER_ADMIN: { email: 'super-admin@project-drawing-status.local', name: 'Super Admin', role: 'ADMIN' },
};

export const PASSWORD_ROLES: LoginRole[] = ['ADMIN', 'SUPER_ADMIN'];
/** Roles whose password is optional: none set → no password; set → required. */
export const OPTIONAL_PASSWORD_ROLES: LoginRole[] = ['VIEWER'];
const ENV_PASSWORD: Record<string, string> = { ADMIN: 'ADMIN_PASSWORD', SUPER_ADMIN: 'SUPER_ADMIN_PASSWORD', VIEWER: 'VIEWER_PASSWORD' };

/** Per role and address, and per role from anywhere (an address can be spoofed). */
export const RATE_LIMIT = { attempts: 5, roleAttempts: 20, windowMinutes: 15 };

/** A session ends after this long without a request; Edit Mode goes off sooner. */
export const IDLE_MINUTES = 60;
export const EDIT_MODE_IDLE_MINUTES = 30;

export class LoginError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

export function sessionHours(): number {
  const h = Number(process.env.SESSION_HOURS ?? 12);
  return Number.isFinite(h) && h > 0 ? h : 12;
}

export function sessionSecret(): string {
  const s = process.env.SESSION_SECRET ?? '';
  if (s.length < 32) throw new LoginError('Sign-in is not set up on this server: SESSION_SECRET (32 characters or more) is missing from .env.', 500);
  return s;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Hash the passwords given in the environment into login_accounts (only when changed). */
export async function ensureLoginAccounts(env: Record<string, string | undefined> = process.env): Promise<string[]> {
  const done: string[] = [];
  for (const role of [...PASSWORD_ROLES, ...OPTIONAL_PASSWORD_ROLES]) {
    const plain = env[ENV_PASSWORD[role]];
    if (!plain) continue;
    const [cur] = await db.select().from(loginAccounts).where(eq(loginAccounts.role, role)).limit(1);
    if (cur && (await bcrypt.compare(plain, cur.passwordHash))) continue;
    const passwordHash = await bcrypt.hash(plain, 12);
    await db
      .insert(loginAccounts)
      .values({ role, passwordHash, updatedAt: new Date() })
      .onConflictDoUpdate({ target: loginAccounts.role, set: { passwordHash, updatedAt: new Date() } });
    done.push(role);
  }
  return done;
}

/** Which roles have a password stored (no plain text, no hash returned). */
export async function passwordStatus(): Promise<Record<LoginRole, boolean>> {
  const rows = await db.select({ role: loginAccounts.role }).from(loginAccounts);
  const has = new Set(rows.map((r) => r.role));
  return { VIEWER: has.has('VIEWER'), ADMIN: has.has('ADMIN'), SUPER_ADMIN: has.has('SUPER_ADMIN') };
}

/** True when the Viewer must give a password (one has been set). */
export async function viewerNeedsPassword(): Promise<boolean> {
  const [r] = await db.select({ role: loginAccounts.role }).from(loginAccounts).where(eq(loginAccounts.role, 'VIEWER')).limit(1);
  return !!r;
}

/** Remove an optional password (the Viewer goes back to one click). */
export async function removeOptionalPassword(role: LoginRole): Promise<boolean> {
  if (!OPTIONAL_PASSWORD_ROLES.includes(role)) throw new LoginError(`The ${LOGIN_ROLE_LABEL[role]} password cannot be removed, only changed.`, 400);
  const r = await db.delete(loginAccounts).where(eq(loginAccounts.role, role)).returning({ role: loginAccounts.role });
  return r.length > 0;
}

async function userFor(role: LoginRole) {
  const u = LOGIN_USER[role];
  const [existing] = await db.select().from(users).where(eq(users.email, u.email)).limit(1);
  if (existing) {
    if (existing.role !== u.role || !existing.active) await db.update(users).set({ role: u.role, active: true, updatedAt: new Date() }).where(eq(users.id, existing.id));
    return { ...existing, role: u.role };
  }
  const row = { id: newId('us_'), name: u.name, email: u.email, role: u.role, active: true, updatedAt: new Date() };
  await db.insert(users).values(row);
  return row;
}

async function recentFailures(key: string, anyAddress = false) {
  const since = new Date(Date.now() - RATE_LIMIT.windowMinutes * 60_000);
  const [r] = await db
    .select({ n: count() })
    .from(loginAttempts)
    .where(and(anyAddress ? like(loginAttempts.key, `${key}|%`) : eq(loginAttempts.key, key), eq(loginAttempts.success, false), gt(loginAttempts.at, since)));
  return Number(r?.n ?? 0);
}

export interface SignedIn {
  cookie: string;
  expires: Date;
  role: SessionRole;
}

/** Check the password (Admin, Super Admin; Viewer when one is set) and open a session. */
export async function signIn(role: LoginRole, password: string | undefined, ip = 'unknown'): Promise<SignedIn> {
  if (!legacyLoginsOn()) throw new LoginError('Sign in with your email and password.', 403);
  const key = `${role}|${ip}`;
  if (PASSWORD_ROLES.includes(role) || (OPTIONAL_PASSWORD_ROLES.includes(role) && (await viewerNeedsPassword()))) {
    if ((await recentFailures(key)) >= RATE_LIMIT.attempts || (await recentFailures(role, true)) >= RATE_LIMIT.roleAttempts) {
      throw new LoginError(`Too many wrong passwords. Please wait ${RATE_LIMIT.windowMinutes} minutes and try again.`, 429);
    }
    const [acct] = await db.select().from(loginAccounts).where(eq(loginAccounts.role, role)).limit(1);
    if (!acct) throw new LoginError(`Sign-in as ${LOGIN_ROLE_LABEL[role]} is not set up yet. Ask IT to set its password (npm run logins:set).`, 503);
    const good = !!password && (await bcrypt.compare(password, acct.passwordHash));
    await db.insert(loginAttempts).values({ id: newId('la_'), key, success: good });
    if (!good) throw new LoginError('That password is not correct.');
  }
  const user = await userFor(role);
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + sessionHours() * 3_600_000);
  await db.insert(loginSessions).values({ id: newId('ls_'), tokenHash: sha256(token), loginRole: role, userId: user.id, editMode: false, ip, expiresAt: expires, lastSeenAt: new Date() });
  return { cookie: await signCookie({ token, role, expires: expires.getTime() }, sessionSecret()), expires, role };
}

export interface ActiveSession {
  id: string;
  role: SessionRole;
  editMode: boolean;
  expiresAt: Date;
  /** The emergency (break-glass) Account Admin sign-in. */
  emergency: boolean;
  user: { id: string; name: string; email: string; role: Role };
  /** A personal sign-in; null for the shared role sign-ins. */
  member: { id: string; name: string; email: string; accountAdmin: boolean } | null;
}

/** The session a cookie belongs to, when it is valid, unexpired and not signed out. */
export async function sessionFor(cookie: string | null | undefined): Promise<ActiveSession | null> {
  const claims = await readCookie(cookie, sessionSecret());
  if (!claims) return null;
  const [row] = await db
    .select({ s: loginSessions, u: users, m: members })
    .from(loginSessions)
    .innerJoin(users, eq(loginSessions.userId, users.id))
    .leftJoin(members, eq(loginSessions.memberId, members.id))
    .where(and(eq(loginSessions.tokenHash, sha256(claims.token)), isNull(loginSessions.revokedAt)))
    .limit(1);
  const now = Date.now();
  if (!row || row.s.loginRole !== claims.role || row.s.expiresAt.getTime() <= now || !row.u.active) return null;
  // A member who is not active (deactivated, or reset to invited) is signed out at once.
  if (claims.role === 'MEMBER' && (!row.m || row.m.status !== 'active')) return null;
  // The shared role sign-ins end when they are switched off (the emergency sign-in stays).
  if (claims.role !== 'MEMBER' && !row.s.emergency && !legacyLoginsOn()) return null;
  const idle = now - (row.s.lastSeenAt ?? row.s.createdAt).getTime();
  if (idle > IDLE_MINUTES * 60_000) {
    await db.update(loginSessions).set({ revokedAt: new Date(), editMode: false }).where(eq(loginSessions.id, row.s.id));
    return null;
  }
  let editMode = row.s.editMode;
  if (editMode && idle > EDIT_MODE_IDLE_MINUTES * 60_000) editMode = false;
  if (idle > 60_000 || editMode !== row.s.editMode) {
    await db.update(loginSessions).set({ lastSeenAt: new Date(), editMode }).where(eq(loginSessions.id, row.s.id));
  }
  return {
    id: row.s.id,
    role: claims.role,
    editMode,
    expiresAt: row.s.expiresAt,
    emergency: row.s.emergency,
    user: { id: row.u.id, name: row.u.name, email: row.u.email, role: row.u.role as Role },
    member: row.m ? { id: row.m.id, name: row.m.name, email: row.m.email, accountAdmin: row.m.isAccountAdmin } : null,
  };
}

/** Switch User / sign out: the session ends (and Edit Mode with it). */
export async function signOut(cookie: string | null | undefined): Promise<void> {
  const claims = await readCookie(cookie, sessionSecret(), 0);
  if (!claims) return;
  await db.update(loginSessions).set({ revokedAt: new Date(), editMode: false }).where(eq(loginSessions.tokenHash, sha256(claims.token)));
}

export async function setEditMode(sessionId: string, on: boolean): Promise<void> {
  await db.update(loginSessions).set({ editMode: on, lastSeenAt: new Date() }).where(eq(loginSessions.id, sessionId));
}
