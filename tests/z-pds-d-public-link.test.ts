/**
 * Project Drawing Status — sharing a public test link.
 *
 *   P1 optional Viewer password: none → one click; set → required, hashed, rate-limited
 *   P2 removing it puts the Viewer back to one click; Admin / Super Admin cannot be removed
 *   P3 behind a Cloudflare tunnel the client address is cf-connecting-ip, not a forged x-forwarded-for
 *   P4 the public-link scripts exist and contain no passwords
 */
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { loginAccounts, loginAttempts } from '@/db/schema';
import { SESSION_COOKIE } from '@/lib/access';
import { ensureLoginAccounts, LoginError, passwordStatus, RATE_LIMIT, removeOptionalPassword, sessionFor, viewerNeedsPassword } from '@/lib/login';
import { clientAddress, isHttps } from '@/lib/session-cookie';
import * as loginRoute from '@/app/api/auth/login/route';

const PW = { ADMIN: `admin-test-${process.pid}`, SUPER_ADMIN: `super-test-${process.pid}`, VIEWER: `viewer-test-${process.pid}` };

const cookieOf = (res: Response) => {
  const m = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(res.headers.get('set-cookie') ?? '');
  return m ? decodeURIComponent(m[1]) : '';
};

async function login(role: string, password?: string, headers: Record<string, string> = { 'x-forwarded-for': '10.9.0.1' }) {
  const res = await loginRoute.POST(
    new Request('http://test.local/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ role, password }) }),
  );
  return { res, cookie: cookieOf(res) };
}

beforeAll(async () => {
  await db.delete(loginAttempts);
  await db.delete(loginAccounts).where(eq(loginAccounts.role, 'VIEWER'));
  await ensureLoginAccounts({ ADMIN_PASSWORD: PW.ADMIN, SUPER_ADMIN_PASSWORD: PW.SUPER_ADMIN });
});

afterAll(async () => {
  await db.delete(loginAccounts).where(eq(loginAccounts.role, 'VIEWER'));
  await db.delete(loginAttempts);
});

describe('P  Public test link', () => {
  it('P1 no Viewer password set: Viewer signs in with one click', async () => {
    expect(await viewerNeedsPassword()).toBe(false);
    expect(await passwordStatus()).toEqual({ VIEWER: false, ADMIN: true, SUPER_ADMIN: true });
    const { res, cookie } = await login('VIEWER');
    expect(res.status).toBe(200);
    expect((await sessionFor(cookie))?.role).toBe('VIEWER');
  });

  it('P1 Viewer password set: stored as a bcrypt hash; required; wrong one refused', async () => {
    expect(await ensureLoginAccounts({ VIEWER_PASSWORD: PW.VIEWER })).toEqual(['VIEWER']);
    const [row] = await db.select().from(loginAccounts).where(eq(loginAccounts.role, 'VIEWER'));
    expect(row.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(row.passwordHash).not.toContain(PW.VIEWER);
    expect(await viewerNeedsPassword()).toBe(true);
    expect((await passwordStatus()).VIEWER).toBe(true);

    const none = await login('VIEWER', undefined, { 'x-forwarded-for': '10.9.0.2' });
    expect(none.res.status).toBe(401);
    expect(none.cookie).toBe('');
    expect((await login('VIEWER', 'wrong-password', { 'x-forwarded-for': '10.9.0.2' })).res.status).toBe(401);
    expect((await login('VIEWER', PW.ADMIN, { 'x-forwarded-for': '10.9.0.2' })).res.status).toBe(401);

    const good = await login('VIEWER', PW.VIEWER, { 'x-forwarded-for': '10.9.0.3' });
    expect(good.res.status).toBe(200);
    expect((await sessionFor(good.cookie))?.role).toBe('VIEWER');
    // Admin and Super Admin are unchanged.
    expect((await login('ADMIN', PW.ADMIN, { 'x-forwarded-for': '10.9.0.3' })).res.status).toBe(200);
  });

  it(`P1 Viewer password is rate-limited like the others (${RATE_LIMIT.attempts} per address)`, async () => {
    const h = { 'x-forwarded-for': '10.9.0.4' };
    for (let i = 0; i < RATE_LIMIT.attempts; i++) expect((await login('VIEWER', 'nope', h)).res.status).toBe(401);
    expect((await login('VIEWER', PW.VIEWER, h)).res.status).toBe(429);
    expect((await login('VIEWER', PW.VIEWER, { 'x-forwarded-for': '10.9.0.5' })).res.status).toBe(200);
  });

  it('P2 removing the Viewer password: one click again; Admin and Super Admin cannot be removed', async () => {
    expect(await removeOptionalPassword('VIEWER')).toBe(true);
    expect(await viewerNeedsPassword()).toBe(false);
    expect((await login('VIEWER', undefined, { 'x-forwarded-for': '10.9.0.6' })).res.status).toBe(200);
    await expect(removeOptionalPassword('ADMIN')).rejects.toBeInstanceOf(LoginError);
    await expect(removeOptionalPassword('SUPER_ADMIN')).rejects.toBeInstanceOf(LoginError);
    expect(await passwordStatus()).toEqual({ VIEWER: false, ADMIN: true, SUPER_ADMIN: true });
  });

  it('P3 behind a Cloudflare tunnel: the address is cf-connecting-ip; HTTPS is recognised', () => {
    const tunnel = new Request('http://localhost:3100/api/auth/login', {
      headers: { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '1.2.3.4, 203.0.113.7', 'x-forwarded-proto': 'https' },
    });
    expect(clientAddress(tunnel)).toBe('203.0.113.7');
    expect(isHttps(tunnel)).toBe(true);
    const local = new Request('http://localhost:3100/api/auth/login', { headers: { 'x-forwarded-for': '10.0.0.9' } });
    expect(clientAddress(local)).toBe('10.0.0.9');
    expect(isHttps(local)).toBe(false);
  });

  it('P4 the public-link scripts exist, use a quick tunnel to the local app and hold no passwords', () => {
    const bat = fs.readFileSync('START-PUBLIC-LINK.bat', 'utf8');
    const ps = fs.readFileSync('scripts/public-link.ps1', 'utf8');
    expect(bat).toMatch(/public-link\.ps1/);
    expect(ps).toMatch(/'tunnel'.*'--url', \$Local/);
    expect(ps).toMatch(/trycloudflare\.com/);
    expect(ps).toMatch(/--status/);
    // It checks the running app really asks the Viewer for the password before opening a link.
    expect(ps).toMatch(/api\/auth\/login/);
    expect(ps).toMatch(/-eq 401/);
    for (const text of [bat, ps]) expect(text).not.toMatch(/PASSWORD\s*=/i);
  });
});
