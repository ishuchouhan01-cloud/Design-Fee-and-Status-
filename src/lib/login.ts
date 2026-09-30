/**
 * Sign-in for Project Drawing Status: three roles, server-side checks only.
 *
 *   Viewer       no password, one click
 *   Admin        password (ADMIN_PASSWORD at setup), stored as a bcrypt hash
 *   Super Admin  password (SUPER_ADMIN_PASSWORD at setup), stored as a bcrypt hash
 *
 * Passwords are never in the code or the repository. `ensureLoginAccounts()`
 * (run by db:setup and `npm run logins:set`) hashes them from the environment
 * into `login_accounts`; sign-in compares with the hash. A session is a random
 * token in an httpOnly, SameSite cookie with an expiry; only its SHA-256 is
 * stored. Failed passwords are rate-limited per role and address.
 */
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { and, count, eq, gt, isNull, like } from 'drizzle-orm';
import { db } from '@/db';
import { loginAccounts, loginAttempts, loginSessions, users } from '@/db/schema';
import { LOGIN_ROLE_LABEL, readCookie, signCookie, type LoginRole } from './access';
import { newId } from './ids';
import type { Role } from './domain';

/** The user record each sign-in role acts as (audit trail, existing permissions). */
export const LOGIN_USER: Record<LoginRole, { email: string; name: string; role: Role }> = {
  VIEWER: { email: 'viewer@project-drawing-status.local', name: 'Viewer', role: 'VIEWER' },
  ADMIN: { email: 'admin@project-drawing-status.local', name: 'Admin', role: 'MANAGER' },
  SUPER_ADMIN: { email: 'super-admin@project-drawing-status.local', name: 'Super Admin', role: 'ADMIN' },
};

export const PASSWORD_ROLES: LoginRole[] = ['ADMIN', 'SUPER_ADMIN'];
const ENV_PASSWORD: Record<string, string> = { ADMIN: 'ADMIN_PASSWORD', SUPER_ADMIN: 'SUPER_ADMIN_PASSWORD' };

/** Per role and address, and per role from anywhere (an address can be spoofed). */
export const RATE_LIMIT = { attempts: 5, roleAttempts: 20, windowMinutes: 15 };

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
  for (const role of PASSWORD_ROLES) {
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
  role: LoginRole;
}

/** Check the password (Admin, Super Admin) and open a session. */
export async function signIn(role: LoginRole, password: string | undefined, ip = 'unknown'): Promise<SignedIn> {
  const key = `${role}|${ip}`;
  if (PASSWORD_ROLES.includes(role)) {
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
  role: LoginRole;
  editMode: boolean;
  expiresAt: Date;
  user: { id: string; name: string; email: string; role: Role };
}

/** The session a cookie belongs to, when it is valid, unexpired and not signed out. */
export async function sessionFor(cookie: string | null | undefined): Promise<ActiveSession | null> {
  const claims = await readCookie(cookie, sessionSecret());
  if (!claims) return null;
  const [row] = await db
    .select({ s: loginSessions, u: users })
    .from(loginSessions)
    .innerJoin(users, eq(loginSessions.userId, users.id))
    .where(and(eq(loginSessions.tokenHash, sha256(claims.token)), isNull(loginSessions.revokedAt)))
    .limit(1);
  if (!row || row.s.loginRole !== claims.role || row.s.expiresAt.getTime() <= Date.now() || !row.u.active) return null;
  return {
    id: row.s.id,
    role: claims.role,
    editMode: row.s.editMode,
    expiresAt: row.s.expiresAt,
    user: { id: row.u.id, name: row.u.name, email: row.u.email, role: row.u.role as Role },
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
