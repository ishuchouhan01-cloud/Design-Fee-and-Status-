/**
 * Project Drawing Status — sign-in and access by role.
 *
 *   L  sign-in: passwords, Viewer, expiry, Switch User, rate limit, hashes
 *   R  authorization: 403 for the Viewer on every write, billing, import and
 *      export endpoint and every admin screen; no billing in Viewer payloads
 *
 * Every request here carries a real session cookie (the sign-in path), never
 * the test header.
 */
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { loginAccounts, loginAttempts, loginSessions } from '@/db/schema';
import { apiAllowed, pageAllowed, readCookie, SESSION_COOKIE, type LoginRole } from '@/lib/access';
import { ensureLoginAccounts, RATE_LIMIT, sessionFor, signIn } from '@/lib/login';
import { buildDfsModel, loadDfs } from '@/lib/services/dfs';
import { middleware } from '@/middleware';
import * as loginRoute from '@/app/api/auth/login/route';
import * as logoutRoute from '@/app/api/auth/logout/route';
import * as editModeRoute from '@/app/api/auth/edit-mode/route';
import * as sessionRoute from '@/app/api/auth/session/route';
import * as dfsRoute from '@/app/api/dfs/route';
import * as dfsExportRoute from '@/app/api/dfs/export/route';
import * as unitDrawingsRoute from '@/app/api/dfs/unit-drawings/route';
import * as applicabilityRoute from '@/app/api/dfs/applicability/route';
import * as exportRoute from '@/app/api/export/route';
import * as rescheduleRoute from '@/app/api/reschedule/route';
import * as drawingsRoute from '@/app/api/drawings/route';
import * as drawingRoute from '@/app/api/drawings/[id]/route';
import * as releaseRoute from '@/app/api/drawings/[id]/release/route';
import * as icHistory from '@/app/api/import-centre/history/route';
import * as icTemplate from '@/app/api/import-centre/template/route';
import * as icRun from '@/app/api/import-centre/run/route';
import * as icUpload from '@/app/api/import-centre/upload/route';
import * as billingRoute from '@/app/api/status/billing/route';
import * as responsibleRoute from '@/app/api/status/responsible/route';
import * as packagesRoute from '@/app/api/status/packages/route';
import * as archiveRoute from '@/app/api/status/archive/route';
import * as towersRoute from '@/app/api/status/towers/route';
import * as auditRoute from '@/app/api/audit/route';
import * as projectsRoute from '@/app/api/projects/route';

// Test-only passwords (the real ones are set on each server from its .env and stored as hashes).
const PW = { ADMIN: `admin-test-${process.pid}`, SUPER_ADMIN: `super-test-${process.pid}` };

const cookieOf = (res: Response) => {
  const set = res.headers.get('set-cookie') ?? '';
  const m = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(set);
  return m ? decodeURIComponent(m[1]) : '';
};

function req(url: string, cookie: string, method = 'GET', body?: unknown) {
  return new Request(`http://test.local${url}`, {
    method,
    headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(cookie)}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function login(role: LoginRole, password?: string, ip = '10.0.0.1') {
  const res = await loginRoute.POST(
    new Request('http://test.local/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ role, password }) }),
  );
  return { res, cookie: cookieOf(res) };
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

let viewer = '';
let admin = '';
let superAdmin = '';

beforeAll(async () => {
  await db.delete(loginAttempts);
  expect(await ensureLoginAccounts({ ADMIN_PASSWORD: PW.ADMIN, SUPER_ADMIN_PASSWORD: PW.SUPER_ADMIN })).toEqual(['ADMIN', 'SUPER_ADMIN']);
  viewer = (await login('VIEWER')).cookie;
  admin = (await login('ADMIN', PW.ADMIN)).cookie;
  superAdmin = (await login('SUPER_ADMIN', PW.SUPER_ADMIN)).cookie;
});

describe('L  Sign-in', () => {
  it('passwords are stored as bcrypt hashes only; the real passwords are not in the repository', async () => {
    const rows = await db.select().from(loginAccounts);
    expect(rows.map((r) => r.role).sort()).toEqual(['ADMIN', 'SUPER_ADMIN']);
    for (const r of rows) {
      expect(r.passwordHash).toMatch(/^\$2[aby]\$12\$/);
      expect(r.passwordHash).not.toContain(PW.ADMIN);
    }
    // No plain password in the code, scripts, tests or documents.
    const hits: string[] = [];
    // Built from parts so this file does not contain them itself.
    const plain = new RegExp([['Admin', '@c', 'pmo'].join(''), ['Admin', '@e', 'dos'].join('')].join('|'));
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', '.versions', 'backups', 'import-reports', 'data'].includes(e.name) || e.name.startsWith('.next') || e.name === '.env') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx|mjs|js|json|md|bat|sql|example)$/.test(e.name) && plain.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(process.cwd(), p));
      }
    };
    walk(process.cwd());
    expect(hits).toEqual([]);
  });

  it('Admin and Super Admin: the right password signs in with an httpOnly, SameSite cookie that expires', async () => {
    const { res, cookie } = await login('ADMIN', PW.ADMIN, '10.0.0.2');
    expect(res.status).toBe(200);
    const set = res.headers.get('set-cookie')!;
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=lax/i);
    expect(set).toMatch(/Expires=/i);
    expect(set).toMatch(/Path=\//);
    const s = await sessionRoute.GET(req('/api/auth/session', cookie));
    expect(await s.json()).toEqual({ role: 'ADMIN', roleLabel: 'Admin', editMode: false });
    expect((await login('SUPER_ADMIN', PW.SUPER_ADMIN, '10.0.0.2')).res.status).toBe(200);
  });

  it('a wrong password is refused; no session is opened', async () => {
    const before = (await db.select({ n: sql<number>`count(*)::int` }).from(loginSessions))[0].n;
    const { res, cookie } = await login('ADMIN', 'not-the-password', '10.0.0.3');
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('That password is not correct.');
    expect(cookie).toBe('');
    expect((await login('SUPER_ADMIN', PW.ADMIN, '10.0.0.3')).res.status).toBe(401);
    expect((await login('ADMIN', undefined, '10.0.0.3')).res.status).toBe(401);
    expect((await db.select({ n: sql<number>`count(*)::int` }).from(loginSessions))[0].n).toBe(before);
  });

  it('Viewer: no password, one step', async () => {
    const { res, cookie } = await login('VIEWER', undefined, '10.0.0.4');
    expect(res.status).toBe(200);
    expect((await res.json()).home).toBe('/drawings');
    expect((await sessionFor(cookie))?.role).toBe('VIEWER');
  });

  it('an expired session is refused (server and middleware); a forged or tampered cookie is refused', async () => {
    const { cookie } = await login('ADMIN', PW.ADMIN, '10.0.0.5');
    const s = await sessionFor(cookie);
    await db.update(loginSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(loginSessions.id, s!.id));
    expect(await sessionFor(cookie)).toBeNull();
    expect((await dfsRoute.GET(req('/api/dfs', cookie))).status).toBe(401);
    // The cookie's own expiry: the middleware refuses it without the database.
    const claims = (await readCookie(cookie, process.env.SESSION_SECRET!))!;
    expect(await readCookie(cookie, process.env.SESSION_SECRET!, claims.expires + 1)).toBeNull();
    // Tampered role or signature.
    const [t, , e, sig] = cookie.split('.');
    expect(await readCookie(`${t}.SUPER_ADMIN.${e}.${sig}`, process.env.SESSION_SECRET!)).toBeNull();
    expect(await readCookie(`${t}.ADMIN.${e}.${sig.slice(0, -2)}xx`, process.env.SESSION_SECRET!)).toBeNull();
    const mw = await middleware(new NextRequest('http://test.local/drawings', { headers: { cookie: `${SESSION_COOKIE}=forged.VIEWER.9999999999999.abc` } }));
    expect(mw.status).toBe(307);
    expect(mw.headers.get('location')).toContain('/login');
  });

  it('Switch User ends the session and turns Edit Mode off; the next sign-in starts with Edit Mode off', async () => {
    const { cookie } = await login('ADMIN', PW.ADMIN, '10.0.0.6');
    expect((await editModeRoute.POST(req('/api/auth/edit-mode', cookie, 'POST', { on: true }))).status).toBe(200);
    expect((await sessionFor(cookie))?.editMode).toBe(true);
    const out = await logoutRoute.POST(req('/api/auth/logout', cookie, 'POST'));
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toMatch(new RegExp(`${SESSION_COOKIE}=;`));
    expect(await sessionFor(cookie)).toBeNull();
    const [row] = await db.select().from(loginSessions).where(sql`${loginSessions.revokedAt} is not null`).orderBy(sql`${loginSessions.revokedAt} desc`).limit(1);
    expect(row.editMode).toBe(false);
    expect((await dfsRoute.GET(req('/api/dfs', cookie))).status).toBe(401);
    const again = await login('ADMIN', PW.ADMIN, '10.0.0.6');
    expect((await sessionFor(again.cookie))?.editMode).toBe(false);
  });

  it(`rate limit: after ${RATE_LIMIT.attempts} wrong passwords, even the right one waits`, async () => {
    const ip = '10.0.0.99';
    for (let i = 0; i < RATE_LIMIT.attempts; i++) expect((await login('SUPER_ADMIN', 'wrong', ip)).res.status).toBe(401);
    const locked = await login('SUPER_ADMIN', PW.SUPER_ADMIN, ip);
    expect(locked.res.status).toBe(429);
    expect((await locked.res.json()).error).toMatch(/Too many wrong passwords/);
    // Another address is not locked out by this one.
    expect((await login('SUPER_ADMIN', PW.SUPER_ADMIN, '10.0.0.98')).res.status).toBe(200);
    // Every address together: the role-wide limit.
    for (let i = 0; i < RATE_LIMIT.roleAttempts; i++) await signIn('ADMIN', 'wrong', `10.1.0.${i}`).catch(() => undefined);
    await expect(signIn('ADMIN', PW.ADMIN, '10.2.0.1')).rejects.toMatchObject({ status: 429 });
    await db.delete(loginAttempts);
  });
});

describe('R  Access by role', () => {
  const ADMIN_PAGES = ['/', '/projects', '/goals', '/deliverables', '/fy26', '/drawing-control', '/update-centre', '/schedule', '/audit', '/drawings?view=summary', '/drawings?view=periods', '/drawings?view=list'];

  async function page(path: string, cookie: string) {
    const url = new URL(`http://test.local${path}`);
    return middleware(new NextRequest(url, { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(cookie)}` } }));
  }

  it('Viewer: only Project Drawing Status and Settings; every other screen is 403', async () => {
    expect((await page('/drawings', viewer)).status).toBe(200);
    expect((await page('/settings', viewer)).status).toBe(200);
    for (const p of [...ADMIN_PAGES.filter((x) => x !== '/'), '/billing', '/import-centre', '/drawings/some-id']) expect((await page(p, viewer)).status, p).toBe(403);
    // The dashboard sends the Viewer to its own screen.
    expect((await page('/', viewer)).headers.get('location')).toMatch(/\/drawings$/);
  });

  it('Admin: Project Drawing Status, Billing, Import, Settings; the Super Admin screens are 403', async () => {
    for (const p of ['/drawings', '/billing', '/import-centre', '/settings']) expect((await page(p, admin)).status, p).toBe(200);
    for (const p of ADMIN_PAGES.filter((x) => x !== '/')) expect((await page(p, admin)).status, p).toBe(403);
  });

  it('Super Admin: every screen', async () => {
    for (const p of [...ADMIN_PAGES, '/billing', '/import-centre', '/settings', '/drawings']) expect((await page(p, superAdmin)).status, p).toBe(200);
  });

  it('Viewer: 403 on every write, billing, import and export endpoint', async () => {
    const [d] = (await db.execute(sql`select id from drawings where archived_at is null limit 1`)).rows as { id: string }[];
    const [p] = (await db.execute(sql`select id, project_id from packages where archived_at is null limit 1`)).rows as { id: string; project_id: string }[];
    const calls: [string, Promise<Response>][] = [
      ['DFS export', dfsExportRoute.GET(req('/api/dfs/export?format=csv', viewer))],
      ['drawing export', exportRoute.GET(req('/api/export?kind=drawings&format=csv', viewer))],
      ['DFS Summary (billing)', dfsRoute.GET(req('/api/dfs?view=summary', viewer))],
      ['Year / Quarter (billing)', dfsRoute.GET(req('/api/dfs?view=periods', viewer))],
      ['import history', icHistory.GET(req('/api/import-centre/history', viewer))],
      ['import template', icTemplate.GET(req('/api/import-centre/template?type=PLAN', viewer))],
      ['import run', icRun.POST(req('/api/import-centre/run', viewer, 'POST', {}))],
      ['import upload', icUpload.POST(req('/api/import-centre/upload', viewer, 'POST', {}))],
      ['billing edit', billingRoute.PATCH(req('/api/status/billing', viewer, 'PATCH', { packageId: p.id, group: 'AR', billed: 1 }))],
      ['responsible edit', responsibleRoute.PATCH(req('/api/status/responsible', viewer, 'PATCH', { kind: 'PACKAGE', id: p.id, name: 'X' }))],
      ['add package', packagesRoute.POST(req('/api/status/packages', viewer, 'POST', { projectId: p.project_id, packageCode: 'V1', packageName: 'V' }))],
      ['add tower', towersRoute.POST(req('/api/status/towers', viewer, 'POST', { parentProjectId: p.project_id, name: 'V' }))],
      ['archive', archiveRoute.POST(req('/api/status/archive', viewer, 'POST', { kind: 'DRAWING', id: d.id, reason: 'viewer test' }))],
      ['drawing edit', drawingRoute.PATCH(req(`/api/drawings/${d.id}`, viewer, 'PATCH', { drawingName: 'X' }), params(d.id))],
      ['drawing create', drawingsRoute.POST(req('/api/drawings', viewer, 'POST', { projectId: p.project_id, drawingName: 'X' }))],
      ['release', releaseRoute.POST(req(`/api/drawings/${d.id}/release`, viewer, 'POST', { actualReleaseDate: '2026-01-01' }), params(d.id))],
      ['reschedule', rescheduleRoute.POST(req('/api/reschedule', viewer, 'POST', { entityType: 'DRAWING', ids: [d.id], newExpectedDate: '2027-01-01', reason: 'viewer test', confirm: true }))],
      ['applicability', applicabilityRoute.POST(req('/api/dfs/applicability', viewer, 'POST', { packageId: p.id, discipline: 'AR', applicability: 'NA', reason: 'viewer test' }))],
      ['edit mode', editModeRoute.POST(req('/api/auth/edit-mode', viewer, 'POST', { on: true }))],
      ['audit', auditRoute.GET(req('/api/audit', viewer))],
      ['projects', projectsRoute.GET(req('/api/projects', viewer))],
    ];
    for (const [what, call] of calls) expect((await call).status, what).toBe(403);
    // The same through the middleware (the first gate).
    for (const [m, u] of [
      ['GET', '/api/dfs/export'],
      ['GET', '/api/export?kind=drawings'],
      ['PATCH', '/api/status/billing'],
      ['POST', '/api/import-centre/run'],
      ['PATCH', `/api/drawings/${d.id}`],
      ['POST', '/api/reschedule'],
      ['GET', '/api/dfs?view=summary'],
    ]) {
      const r = await middleware(new NextRequest(new URL(`http://test.local${u}`), { method: m, headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(viewer)}` } }));
      expect(r.status, `${m} ${u}`).toBe(403);
    }
    expect(apiAllowed('ADMIN', 'DELETE', `/api/drawings/${d.id}`)).toBe(false);
    expect(pageAllowed('ADMIN', '/audit')).toBe(false);
  });

  it("the Viewer's payloads carry no billing: no field, no amount", async () => {
    const bodies: string[] = [];
    for (const u of ['/api/dfs', '/api/dfs?expand=packages']) {
      const r = await dfsRoute.GET(req(u, viewer));
      expect(r.status).toBe(200);
      bodies.push(await r.text());
    }
    const m = await buildDfsModel({});
    const unit = [...m.rows.values()].find((r) => r.kind === 'DISCIPLINE' && r.drawingsTotal > 0)!;
    const ud = await unitDrawingsRoute.GET(req(`/api/dfs/unit-drawings?key=${encodeURIComponent(unit.unitKey!)}`, viewer));
    expect(ud.status).toBe(200);
    bodies.push(await ud.text());
    for (const b of bodies) {
      expect(b).not.toMatch(/"billing"|"billingFlags"|"billed|"scope"|"fee|unbilled/i);
    }
    // Admin receives billing on the same request.
    const a = await (await dfsRoute.GET(req('/api/dfs?expand=packages', admin))).json();
    expect(a.totals.billing.total).toBeGreaterThan(0);
    expect(a.rows.some((r: { billing: unknown }) => r.billing)).toBe(true);
    const { units } = await loadDfs({});
    expect(units.length).toBeGreaterThan(0);
  });

  it('a Viewer cannot switch Edit Mode on; Admin can; writes need Edit Mode on', async () => {
    expect((await editModeRoute.POST(req('/api/auth/edit-mode', viewer, 'POST', { on: true }))).status).toBe(403);
    const [p] = (await db.execute(sql`select id from packages where archived_at is null limit 1`)).rows as { id: string }[];
    const off = await responsibleRoute.PATCH(req('/api/status/responsible', admin, 'PATCH', { kind: 'PACKAGE', id: p.id, name: null }));
    expect(off.status).toBe(409);
    expect((await off.json()).error).toBe('Turn on Edit Mode to make changes.');
  });
});
