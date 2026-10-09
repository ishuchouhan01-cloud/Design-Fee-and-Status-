/**
 * Personal sign-in: email + password, one-time invite links, and the hidden
 * emergency (break-glass) Account Admin sign-in.
 *
 *   Invite      an admin adds a member → a random token (72 h, single use);
 *               only its SHA-256 is stored, the link is shown once
 *   Password    12+ characters, not the email, not a common password; bcrypt (cost 12)
 *   Sign-in     the same generic error for an unknown email and a wrong
 *               password; 5 wrong per email + address, 20 per email, 15 minutes
 *   Session     the signed httpOnly cookie (role MEMBER), 12 h absolute,
 *               60 min idle (lib/login sessionFor); Edit Mode off at every
 *               sign-in and after 30 min idle
 *   Emergency   /login?emergency=1 with the existing Super Admin hash; every
 *               use is audited and shown to Account Admins
 */
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { and, count, eq, gt, isNull, ne } from 'drizzle-orm';
import { db, type DbLike } from '@/db';
import { auditLog, loginAccounts, loginAttempts, loginSessions, memberInvites, members, users } from '@/db/schema';
import { recordAudit } from '@/lib/audit';
import { signCookie } from '@/lib/access';
import { newId } from '@/lib/ids';
import { LoginError, sessionHours, sessionSecret, type SignedIn } from '@/lib/login';
import { normaliseEmail, passwordProblem } from './policy';

export const MEMBER_RATE_LIMIT = { perAddress: 5, perEmail: 20, windowMinutes: 15 };
export const INVITE_HOURS = 72;
export const GENERIC_SIGN_IN_ERROR = 'The email or password is not correct.';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** A real bcrypt hash of a random value, compared against for an unknown email so both answers take the same time. */
let dummy: Promise<string> | null = null;
const dummyHash = () => (dummy ??= bcrypt.hash(randomBytes(16).toString('hex'), 12));

/** The audit actor of a member: their name and email. */
export function memberActor(m: { userId: string | null; name: string; email: string }) {
  return { id: m.userId, label: `${m.name} <${m.email}>` };
}

/** The user record a member acts as (audit trail, existing references), created or linked by email. */
export async function ensureMemberUser(m: { id: string; name: string; email: string; userId: string | null; isAccountAdmin: boolean }, tx: DbLike = db): Promise<string> {
  if (m.userId) {
    await tx.update(users).set({ name: m.name, active: true, updatedAt: new Date() }).where(eq(users.id, m.userId));
    return m.userId;
  }
  const [byEmail] = await tx.select().from(users).where(eq(users.email, m.email)).limit(1);
  const userId = byEmail?.id ?? newId('us_');
  if (!byEmail) await tx.insert(users).values({ id: userId, name: m.name, email: m.email, role: m.isAccountAdmin ? 'ADMIN' : 'VIEWER', active: true, updatedAt: new Date() });
  await tx.update(members).set({ userId }).where(eq(members.id, m.id));
  return userId;
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

export function appBaseUrl(origin?: string | null): string {
  return (origin || process.env.APP_BASE_URL || `http://localhost:${process.env.PORT ?? 3100}`).replace(/\/+$/, '');
}

/** A new one-time link for a member; earlier unused links stop working. Shown once — only the hash is kept. */
export async function createInvite(memberId: string, createdBy: string, origin?: string | null, tx: DbLike = db) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + INVITE_HOURS * 3_600_000);
  await tx.update(memberInvites).set({ usedAt: new Date() }).where(and(eq(memberInvites.memberId, memberId), isNull(memberInvites.usedAt)));
  await tx.insert(memberInvites).values({ id: newId('mi_'), memberId, tokenHash: sha256(token), expiresAt, createdBy });
  return { token, link: `${appBaseUrl(origin)}/invite/${token}`, expiresAt };
}

async function inviteRow(token: string) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const [row] = await db
    .select({ i: memberInvites, m: members })
    .from(memberInvites)
    .innerJoin(members, eq(memberInvites.memberId, members.id))
    .where(eq(memberInvites.tokenHash, sha256(token)))
    .limit(1);
  return row ?? null;
}

export type InviteState = { ok: true; name: string; email: string } | { ok: false; reason: 'unknown' | 'used' | 'expired' | 'deactivated' };

export async function inviteInfo(token: string): Promise<InviteState> {
  const row = await inviteRow(token);
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.i.usedAt) return { ok: false, reason: 'used' };
  if (row.i.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' };
  if (row.m.status === 'deactivated') return { ok: false, reason: 'deactivated' };
  return { ok: true, name: row.m.name, email: row.m.email };
}

export const INVITE_REASON: Record<string, string> = {
  unknown: 'This invite link is not valid. Ask your admin for a new one.',
  used: 'This invite link has already been used. Sign in with your email and password, or ask your admin for a new link.',
  expired: 'This invite link has expired (links last 72 hours). Ask your admin for a new one.',
  deactivated: 'This account is not active. Ask your admin.',
};

/** Set the password from an invite link: the link is used up, earlier sessions end, the member is signed in. */
export async function acceptInvite(token: string, password: string, confirm: string, ip = 'unknown'): Promise<SignedIn & { memberId: string }> {
  const state = await inviteInfo(token);
  if (!state.ok) throw new LoginError(INVITE_REASON[state.reason], 400);
  if (password !== confirm) throw new LoginError('The two passwords are not the same.', 400);
  const problem = passwordProblem(password, state.email);
  if (problem) throw new LoginError(problem, 400);
  const row = (await inviteRow(token))!;
  const passwordHash = await bcrypt.hash(password, 12);
  await db.transaction(async (tx) => {
    // Single use, also against a second request racing this one.
    const used = await tx
      .update(memberInvites)
      .set({ usedAt: new Date() })
      .where(and(eq(memberInvites.id, row.i.id), isNull(memberInvites.usedAt)))
      .returning({ id: memberInvites.id });
    if (!used.length) throw new LoginError(INVITE_REASON.used, 400);
    await tx.update(members).set({ passwordHash, status: 'active', updatedAt: new Date() }).where(eq(members.id, row.m.id));
    await tx.update(loginSessions).set({ revokedAt: new Date(), editMode: false }).where(and(eq(loginSessions.memberId, row.m.id), isNull(loginSessions.revokedAt)));
    const userId = await ensureMemberUser(row.m, tx);
    await recordAudit({ actor: memberActor({ ...row.m, userId }), entityType: 'MEMBER', entityId: row.m.id, entityLabel: `${row.m.name} <${row.m.email}>`, action: 'INVITE_USED', reason: 'Password set from the invite link' }, tx);
  });
  return { ...(await openMemberSession(row.m.id, ip)), memberId: row.m.id };
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

async function failures(email: string, ip?: string) {
  const since = new Date(Date.now() - MEMBER_RATE_LIMIT.windowMinutes * 60_000);
  const [r] = await db
    .select({ n: count() })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.email, email), eq(loginAttempts.success, false), gt(loginAttempts.at, since), ip ? eq(loginAttempts.key, `EMAIL|${email}|${ip}`) : undefined));
  return Number(r?.n ?? 0);
}

export async function openMemberSession(memberId: string, ip: string): Promise<SignedIn> {
  const [m] = await db.select().from(members).where(eq(members.id, memberId)).limit(1);
  const userId = await ensureMemberUser(m);
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + sessionHours() * 3_600_000);
  await db.insert(loginSessions).values({ id: newId('ls_'), tokenHash: sha256(token), loginRole: 'MEMBER', userId, memberId, editMode: false, ip, expiresAt: expires, lastSeenAt: new Date() });
  await db.update(members).set({ lastSignInAt: new Date() }).where(eq(members.id, memberId));
  return { cookie: await signCookie({ token, role: 'MEMBER', expires: expires.getTime() }, sessionSecret()), expires, role: 'MEMBER' };
}

/** Email + password. Unknown email, wrong password, no password yet and a deactivated account all give the same answer. */
export async function signInMember(emailIn: string, password: string, ip = 'unknown'): Promise<SignedIn & { memberId: string }> {
  const email = normaliseEmail(emailIn);
  if ((await failures(email, ip)) >= MEMBER_RATE_LIMIT.perAddress || (await failures(email)) >= MEMBER_RATE_LIMIT.perEmail) {
    throw new LoginError(`Too many wrong attempts. Please wait ${MEMBER_RATE_LIMIT.windowMinutes} minutes and try again.`, 429);
  }
  const [m] = await db.select().from(members).where(eq(members.email, email)).limit(1);
  const real = m?.status === 'active' && m.passwordHash ? m.passwordHash : null;
  const match = await bcrypt.compare(password ?? '', real ?? (await dummyHash()));
  const good = match && !!real && !!password;
  await db.insert(loginAttempts).values({ id: newId('la_'), key: `EMAIL|${email}|${ip}`, email, success: good });
  if (!good || !m) throw new LoginError(GENERIC_SIGN_IN_ERROR, 401);
  return { ...(await openMemberSession(m.id, ip)), memberId: m.id };
}

/** End every session of a member at once (deactivate, reset password). */
export async function revokeMemberSessions(memberId: string, tx: DbLike = db) {
  await tx.update(loginSessions).set({ revokedAt: new Date(), editMode: false }).where(and(eq(loginSessions.memberId, memberId), isNull(loginSessions.revokedAt)));
}

// ---------------------------------------------------------------------------
// Emergency (break-glass) Account Admin
// ---------------------------------------------------------------------------

export const EMERGENCY_LABEL = 'Emergency Account Admin';

export async function emergencySignIn(password: string | undefined, ip = 'unknown'): Promise<SignedIn> {
  const key = `EMERGENCY|${ip}`;
  const since = new Date(Date.now() - MEMBER_RATE_LIMIT.windowMinutes * 60_000);
  const n = async (k: string | null) =>
    Number(
      (
        await db
          .select({ n: count() })
          .from(loginAttempts)
          .where(and(k ? eq(loginAttempts.key, k) : eq(loginAttempts.email, '#emergency'), eq(loginAttempts.success, false), gt(loginAttempts.at, since)))
      )[0]?.n ?? 0,
    );
  if ((await n(key)) >= MEMBER_RATE_LIMIT.perAddress || (await n(null)) >= MEMBER_RATE_LIMIT.perEmail) {
    throw new LoginError(`Too many wrong attempts. Please wait ${MEMBER_RATE_LIMIT.windowMinutes} minutes and try again.`, 429);
  }
  const [acct] = await db.select().from(loginAccounts).where(eq(loginAccounts.role, 'SUPER_ADMIN')).limit(1);
  const good = !!password && !!acct && (await bcrypt.compare(password, acct.passwordHash));
  await db.insert(loginAttempts).values({ id: newId('la_'), key, email: '#emergency', success: good });
  if (!good) throw new LoginError('That password is not correct.', 401);
  const { LOGIN_USER } = await import('@/lib/login');
  const u = LOGIN_USER.SUPER_ADMIN;
  let [user] = await db.select().from(users).where(eq(users.email, u.email)).limit(1);
  if (!user) {
    [user] = await db.insert(users).values({ id: newId('us_'), name: u.name, email: u.email, role: u.role, active: true, updatedAt: new Date() }).returning();
  }
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + sessionHours() * 3_600_000);
  const sessionId = newId('ls_');
  await db.insert(loginSessions).values({ id: sessionId, tokenHash: sha256(token), loginRole: 'SUPER_ADMIN', userId: user.id, emergency: true, editMode: false, ip, expiresAt: expires, lastSeenAt: new Date() });
  await recordAudit({ actor: { id: user.id, label: EMERGENCY_LABEL }, entityType: 'LOGIN', entityId: sessionId, entityLabel: EMERGENCY_LABEL, action: 'EMERGENCY_SIGN_IN', newValue: ip, reason: 'Break-glass sign-in (/login?emergency=1)' });
  return { cookie: await signCookie({ token, role: 'SUPER_ADMIN', expires: expires.getTime() }, sessionSecret()), expires, role: 'SUPER_ADMIN' };
}

/** Emergency sign-ins of the last 14 days (the banner Account Admins see). */
export async function recentEmergencySignIns() {
  const since = new Date(Date.now() - 14 * 86_400_000);
  return db
    .select({ at: auditLog.timestamp, address: auditLog.newValue })
    .from(auditLog)
    .where(and(eq(auditLog.action, 'EMERGENCY_SIGN_IN'), gt(auditLog.timestamp, since), ne(auditLog.entityType, '')))
    .orderBy(auditLog.timestamp);
}
