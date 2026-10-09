/**
 * Personal sign-in (Settings → Members).
 *
 *   I  invite links: single use, expiry, only the hash is stored
 *   P  password rules
 *   S  sign-in: success, one generic error, lockout per email + address and per email, unlock
 *   T  sessions: idle timeout, absolute expiry, Edit Mode off after 30 minutes idle
 *   D  deactivation ends every live session
 *   E  break-glass emergency sign-in, audited
 *   C  project scoping: A cannot read or write B (also by guessing ids), in exports and totals
 *   W  switches: billing, Edit Mode, Import / Export, Planning
 *   G  guards: no escalation, Project Admin only on their projects, last Account Admin, not oneself
 *   F  import of Forma's Members export (built here)
 *   L  the shared role sign-ins with LEGACY_ROLE_LOGINS on and off
 *
 * Every person here is made up (…@example.test); every password is made here.
 */
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import * as XLSX from 'xlsx';
import { db } from '@/db';
import { auditLog, companies, drawings, loginAttempts, loginSessions, memberInvites, members, packages, projectMembers } from '@/db/schema';
import { SESSION_COOKIE } from '@/lib/access';
import { ensureLoginAccounts, sessionFor } from '@/lib/login';
import { MEMBER_RATE_LIMIT, GENERIC_SIGN_IN_ERROR, recentEmergencySignIns } from '@/lib/members/auth';
import { passwordProblem } from '@/lib/members/policy';
import { projectParents } from '@/lib/members/principal';
import { inviteFromCommandLine } from '@/lib/members/setup';
import { parseMembersWorkbook } from '@/lib/members/service';
import { buildDfsModel, modelTotals } from '@/lib/services/dfs';
import { middleware } from '@/middleware';
import * as loginRoute from '@/app/api/auth/login/route';
import * as inviteRoute from '@/app/api/auth/invite/route';
import * as editModeRoute from '@/app/api/auth/edit-mode/route';
import * as membersRoute from '@/app/api/members/route';
import * as memberRoute from '@/app/api/members/[id]/route';
import * as accessRoute from '@/app/api/members/[id]/access/route';
import * as actionsRoute from '@/app/api/members/[id]/actions/route';
import * as importRoute from '@/app/api/members/import/route';
import * as dfsRoute from '@/app/api/dfs/route';
import * as dfsExportRoute from '@/app/api/dfs/export/route';
import * as unitDrawingsRoute from '@/app/api/dfs/unit-drawings/route';
import * as drawingRoute from '@/app/api/drawings/[id]/route';
import * as packageRoute from '@/app/api/status/packages/[id]/route';
import * as icHistory from '@/app/api/import-centre/history/route';

const PID = process.pid;
const SUPER_PW = `emergency-test-${PID}-x`;
const pw = (who: string) => `Pw-${who}-${PID}-long-enough`;
const email = (who: string) => `${who}.${PID}@example.test`;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const params = (id: string) => ({ params: Promise.resolve({ id }) });

const cookieOf = (res: Response) => {
  const m = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(res.headers.get('set-cookie') ?? '');
  return m ? decodeURIComponent(m[1]) : '';
};

function req(url: string, cookie: string, method = 'GET', body?: unknown) {
  return new Request(`http://test.local${url}`, {
    method,
    headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(cookie)}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const page = (path: string, cookie: string) => middleware(new NextRequest(new URL(`http://test.local${path}`), { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(cookie)}` } }));

function post(url: string, body: unknown, ip = '10.9.0.1') {
  return new Request(`http://test.local${url}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) });
}

const signIn = (who: string, password = pw(who), ip = '10.9.0.1') => loginRoute.POST(post('/api/auth/login', { email: email(who), password }, ip));
const tokenOf = (link: string) => link.split('/invite/')[1];

async function setPassword(link: string, password: string) {
  const res = await inviteRoute.POST(post('/api/auth/invite', { token: tokenOf(link), password, confirm: password }));
  return { res, cookie: cookieOf(res) };
}

async function memberId(who: string) {
  const [m] = await db.select().from(members).where(eq(members.email, email(who))).limit(1);
  return m.id;
}

/** Added by the Account Admin through the API, then signed in with their own password. */
async function addAndActivate(by: string, who: string, body: Record<string, unknown>) {
  const res = await membersRoute.POST(req('/api/members', by, 'POST', { name: `Test ${who}`, email: email(who), ...body }));
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  const { invite } = await res.json();
  const { res: r2, cookie } = await setPassword(invite.link, pw(who));
  expect(r2.status).toBe(200);
  return cookie;
}

let A = '';
let B = '';
let drawingA = '';
let drawingB = '';
let packageB = '';
let aa = '';
let pa = '';
let viewerM = '';
let editorM = '';
let planner = '';

beforeAll(async () => {
  await db.delete(loginAttempts);
  await ensureLoginAccounts({ SUPER_ADMIN_PASSWORD: SUPER_PW });
  // Two projects with drawings, neither inside the other.
  const parents = await projectParents();
  const withDrawings = await db
    .select({ projectId: drawings.projectId, n: sql<number>`count(*)::int` })
    .from(drawings)
    .groupBy(drawings.projectId)
    .orderBy(sql`count(*) desc`);
  const chain = (id: string) => {
    const out = [id];
    while (parents.get(out[out.length - 1])) out.push(parents.get(out[out.length - 1])!);
    return out;
  };
  const ids = withDrawings.map((r) => r.projectId!).filter(Boolean);
  A = ids[0];
  B = ids.find((id) => !chain(id).includes(A) && !chain(A).includes(id))!;
  expect(A && B && A !== B).toBeTruthy();
  const under = (root: string) => [...parents.keys()].filter((id) => chain(id).includes(root));
  [{ id: drawingA }] = await db.select({ id: drawings.id }).from(drawings).where(inArray(drawings.projectId, under(A))).limit(1);
  [{ id: drawingB }] = await db.select({ id: drawings.id }).from(drawings).where(inArray(drawings.projectId, under(B))).limit(1);
  [{ id: packageB }] = await db.select({ id: packages.id }).from(packages).where(inArray(packages.projectId, under(B))).limit(1);

  // The first Account Admin, as `npm run members:invite -- --account-admin` makes them.
  const first = await inviteFromCommandLine({ email: email('aa'), name: 'Test Account Admin', accountAdmin: true });
  aa = (await setPassword(first.invite!.link, pw('aa'))).cookie;
  pa = await addAndActivate(aa, 'pa', { projectId: A, level: 'project_admin' });
  viewerM = await addAndActivate(aa, 'viewer', { projectId: A, level: 'member', switches: {} });
  editorM = await addAndActivate(aa, 'editor', { projectId: A, level: 'member', switches: { billing: true, edit: true, importExport: true } });
  planner = await addAndActivate(aa, 'planner', { projectId: A, level: 'member', switches: { planning: true } });
});

afterAll(async () => {
  delete process.env.LEGACY_ROLE_LOGINS;
  await db.delete(loginAttempts);
});

describe('I  Invite links', () => {
  it('only the SHA-256 of the token is stored; the link works once', async () => {
    const r = await inviteFromCommandLine({ email: email('inv1'), name: 'Test Invite One', projectId: A });
    const token = tokenOf(r.invite!.link);
    const rows = await db.select().from(memberInvites).where(eq(memberInvites.memberId, r.memberId));
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(sha256(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect((await setPassword(r.invite!.link, pw('inv1'))).res.status).toBe(200);
    const again = await setPassword(r.invite!.link, pw('inv1'));
    expect(again.res.status).toBe(400);
    expect((await again.res.json()).error).toMatch(/already been used/i);
  });

  it('an expired link is refused; a new link replaces the old one', async () => {
    const r = await inviteFromCommandLine({ email: email('inv2'), name: 'Test Invite Two', projectId: A });
    await db.update(memberInvites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(memberInvites.memberId, r.memberId));
    const late = await setPassword(r.invite!.link, pw('inv2'));
    expect(late.res.status).toBe(400);
    expect((await late.res.json()).error).toMatch(/expired/i);
    // A new link (⋮ → Copy invite link / Resend); the one before it stops working.
    const one = await actionsRoute.POST(req('/api/members/x/actions', aa, 'POST', { action: 'invite' }), params(r.memberId));
    const two = await actionsRoute.POST(req('/api/members/x/actions', aa, 'POST', { action: 'invite' }), params(r.memberId));
    const [l1, l2] = [(await one.json()).link, (await two.json()).link];
    expect((await setPassword(l1, pw('inv2'))).res.status).toBe(400);
    expect((await setPassword(l2, pw('inv2'))).res.status).toBe(200);
  });

  it('a made-up token is refused', async () => {
    expect((await setPassword(`http://x/invite/${'a'.repeat(43)}`, pw('nobody'))).res.status).toBe(400);
  });
});

describe('P  Password rules', () => {
  it('12 characters or more, not the email, not a common password', () => {
    const e = 'someone@example.test';
    expect(passwordProblem('short-pw', e)).toMatch(/12 characters/);
    expect(passwordProblem(e, e)).toMatch(/email/);
    expect(passwordProblem('someone', e)).toMatch(/12 characters/);
    expect(passwordProblem('Password1234', e)).toMatch(/common/);
    expect(passwordProblem('aaaaaaaaaaaaaa', e)).toMatch(/common/);
    expect(passwordProblem('a-long-unusual-phrase', e)).toBeNull();
  });

  it('the invite screen applies them and needs the two fields to match', async () => {
    const r = await inviteFromCommandLine({ email: email('inv3'), name: 'Test Invite Three', projectId: A });
    const token = tokenOf(r.invite!.link);
    const bad = await inviteRoute.POST(post('/api/auth/invite', { token, password: 'Password1234', confirm: 'Password1234' }));
    expect(bad.status).toBe(400);
    const mismatch = await inviteRoute.POST(post('/api/auth/invite', { token, password: pw('inv3'), confirm: `${pw('inv3')}x` }));
    expect(mismatch.status).toBe(400);
    // Refusals do not use up the link.
    expect((await setPassword(r.invite!.link, pw('inv3'))).res.status).toBe(200);
    const [m] = await db.select().from(members).where(eq(members.id, r.memberId));
    expect(m.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(m.status).toBe('active');
  });
});

describe('S  Sign-in', () => {
  it('email + password signs in with a session cookie; Edit Mode starts off', async () => {
    const res = await signIn('editor', pw('editor'), '10.9.1.1');
    expect(res.status).toBe(200);
    const s = await sessionFor(cookieOf(res));
    expect(s?.role).toBe('MEMBER');
    expect(s?.member?.email).toBe(email('editor'));
    expect(s?.editMode).toBe(false);
  });

  it('one generic error: wrong password, unknown email, no password yet, deactivated', async () => {
    const invited = await inviteFromCommandLine({ email: email('nopw'), name: 'Test No Password', projectId: A });
    expect(invited.invite).toBeTruthy();
    const answers = await Promise.all([signIn('editor', 'wrong-password-123', '10.9.1.2'), signIn('nobody-here', 'whatever-123456', '10.9.1.2'), signIn('nopw', 'whatever-123456', '10.9.1.2')]);
    for (const r of answers) {
      expect(r.status).toBe(401);
      expect((await r.json()).error).toBe(GENERIC_SIGN_IN_ERROR);
    }
  });

  it('5 wrong attempts lock that email from that address; another address still works', async () => {
    for (let i = 0; i < MEMBER_RATE_LIMIT.perAddress; i++) expect((await signIn('planner', 'wrong-password-123', '10.9.2.1')).status).toBe(401);
    expect((await signIn('planner', pw('planner'), '10.9.2.1')).status).toBe(429);
    expect((await signIn('planner', pw('planner'), '10.9.2.2')).status).toBe(200);
  });

  it('20 wrong attempts lock the email from every address; it unlocks after the window', async () => {
    for (let i = 0; i < MEMBER_RATE_LIMIT.perEmail; i++) await signIn('pa', 'wrong-password-123', `10.9.3.${i}`);
    expect((await signIn('pa', pw('pa'), '10.9.3.200')).status).toBe(429);
    // The window passes.
    await db
      .update(loginAttempts)
      .set({ at: new Date(Date.now() - (MEMBER_RATE_LIMIT.windowMinutes + 1) * 60_000) })
      .where(eq(loginAttempts.email, email('pa')));
    expect((await signIn('pa', pw('pa'), '10.9.3.200')).status).toBe(200);
  });
});

describe('T  Session limits', () => {
  it('60 minutes without a request ends the session', async () => {
    const cookie = cookieOf(await signIn('viewer', pw('viewer'), '10.9.4.1'));
    const s = (await sessionFor(cookie))!;
    await db.update(loginSessions).set({ lastSeenAt: new Date(Date.now() - 61 * 60_000) }).where(eq(loginSessions.id, s.id));
    expect(await sessionFor(cookie)).toBeNull();
    const [row] = await db.select().from(loginSessions).where(eq(loginSessions.id, s.id));
    expect(row.revokedAt).not.toBeNull();
  });

  it('the absolute expiry ends the session however active it is', async () => {
    const cookie = cookieOf(await signIn('viewer', pw('viewer'), '10.9.4.1'));
    const s = (await sessionFor(cookie))!;
    expect(s.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(12 * 3_600_000 + 5000);
    await db.update(loginSessions).set({ expiresAt: new Date(Date.now() - 1000), lastSeenAt: new Date() }).where(eq(loginSessions.id, s.id));
    expect(await sessionFor(cookie)).toBeNull();
  });

  it('Edit Mode goes off after 30 minutes without a request (the session stays)', async () => {
    const cookie = cookieOf(await signIn('editor', pw('editor'), '10.9.4.2'));
    expect((await editModeRoute.POST(req('/api/auth/edit-mode', cookie, 'POST', { on: true }))).status).toBe(200);
    const s = (await sessionFor(cookie))!;
    expect(s.editMode).toBe(true);
    await db.update(loginSessions).set({ lastSeenAt: new Date(Date.now() - 31 * 60_000) }).where(eq(loginSessions.id, s.id));
    const after = await sessionFor(cookie);
    expect(after).not.toBeNull();
    expect(after!.editMode).toBe(false);
  });
});

describe('D  Deactivation', () => {
  it('ends every live session at once; the person can no longer sign in', async () => {
    const live = await addAndActivate(aa, 'leaver', { projectId: A, level: 'member', switches: {} });
    const second = cookieOf(await signIn('leaver', pw('leaver'), '10.9.5.1'));
    expect((await page('/drawings', live)).status).toBe(200);
    const id = await memberId('leaver');
    expect((await actionsRoute.POST(req('/api/members/x/actions', aa, 'POST', { action: 'deactivate' }), params(id))).status).toBe(200);
    expect(await sessionFor(live)).toBeNull();
    expect(await sessionFor(second)).toBeNull();
    expect((await page('/drawings', live)).status).toBe(307);
    const again = await signIn('leaver', pw('leaver'), '10.9.5.2');
    expect(again.status).toBe(401);
    expect((await again.json()).error).toBe(GENERIC_SIGN_IN_ERROR);
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, 'DEACTIVATE_MEMBER')));
    expect(audit[0].userLabel).toContain(email('aa'));
  });
});

describe('E  Emergency sign-in', () => {
  it('the Super Admin password opens an audited Account Admin session; a wrong one does not', async () => {
    expect((await loginRoute.POST(post('/api/auth/login', { emergency: true, password: 'not-it-at-all' }, '10.9.6.1'))).status).toBe(401);
    const res = await loginRoute.POST(post('/api/auth/login', { emergency: true, password: SUPER_PW }, '10.9.6.1'));
    expect(res.status).toBe(200);
    expect((await res.json()).home).toBe('/settings/members');
    const s = (await sessionFor(cookieOf(res)))!;
    expect(s.emergency).toBe(true);
    expect((await page('/settings/members', cookieOf(res))).status).toBe(200);
    const rows = await db.select().from(auditLog).where(and(eq(auditLog.action, 'EMERGENCY_SIGN_IN'), eq(auditLog.entityId, s.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0].newValue).toBe('10.9.6.1');
    expect((await recentEmergencySignIns()).length).toBeGreaterThan(0);
  });
});

describe('C  Project scoping', () => {
  it('a member of A cannot read B: tree, drill-down, detail — also by guessing ids', async () => {
    expect((await dfsRoute.GET(req(`/api/dfs?projectId=${B}`, viewerM))).status).toBe(403);
    expect((await drawingRoute.GET(req('/api/drawings/x', viewerM), params(drawingB))).status).toBe(403);
    expect((await drawingRoute.GET(req('/api/drawings/x', viewerM), params(drawingA))).status).toBe(200);
    expect((await unitDrawingsRoute.GET(req(`/api/dfs/unit-drawings?key=${encodeURIComponent(`${B}|x|AR`)}`, viewerM))).status).toBe(403);
    // Unfiltered, only A is there.
    const body = await (await dfsRoute.GET(req('/api/dfs', viewerM))).json();
    expect(body.rows.length).toBeGreaterThan(0);
    const parents = await projectParents();
    const inA = (id: string) => {
      for (let p: string | null | undefined = id; p; p = parents.get(p)) if (p === A) return true;
      return false;
    };
    for (const r of body.rows) expect(inA(r.projectId)).toBe(true);
  });

  it('totals count only A', async () => {
    const body = await (await dfsRoute.GET(req('/api/dfs', viewerM))).json();
    const onlyA = modelTotals(await buildDfsModel({ scopeProjectIds: [A] }));
    const everything = modelTotals(await buildDfsModel({}));
    expect(body.totals.drawingsTotal).toBe(onlyA.drawingsTotal);
    expect(body.totals.packagesTotal).toBe(onlyA.packagesTotal);
    expect(onlyA.drawingsTotal).toBeLessThan(everything.drawingsTotal);
  });

  it('a member with Edit on A cannot write to B', async () => {
    await editModeRoute.POST(req('/api/auth/edit-mode', editorM, 'POST', { on: true }));
    expect((await drawingRoute.PATCH(req('/api/drawings/x', editorM, 'PATCH', { remarks: 'scoping test' }), params(drawingB))).status).toBe(403);
    expect((await packageRoute.PATCH(req('/api/status/packages/x', editorM, 'PATCH', { responsibleText: 'scoping test' }), params(packageB))).status).toBe(403);
    const [before] = await db.select({ remarks: drawings.remarks }).from(drawings).where(eq(drawings.id, drawingB));
    expect(before.remarks).not.toBe('scoping test');
  });

  it('exports hold only A; asking for B is refused', async () => {
    expect((await dfsExportRoute.GET(req(`/api/dfs/export?format=csv&projectId=${B}`, editorM))).status).toBe(403);
    const res = await dfsExportRoute.GET(req('/api/dfs/export?format=csv', editorM));
    expect(res.status).toBe(200);
    const csv = await res.text();
    // The Project column holds none of B's projects (as the Account Admin's export of B prints them).
    const projectsIn = (text: string) => {
      const wb = XLSX.read(text, { type: 'string' });
      const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1 });
      return new Set(rows.slice(1).map((r) => String(r[0] ?? '')).filter(Boolean));
    };
    const mine = projectsIn(csv);
    const ofB = projectsIn(await (await dfsExportRoute.GET(req(`/api/dfs/export?format=csv&projectId=${B}`, aa))).text());
    expect(mine.size).toBeGreaterThan(0);
    expect(ofB.size).toBeGreaterThan(0);
    for (const p of ofB) expect(mine.has(p), p).toBe(false);
    // The import history shows only A's runs.
    const { runs } = (await (await icHistory.GET(req('/api/import-centre/history', editorM))).json()) as { runs: { projectId?: string | null }[] };
    const parents = await projectParents();
    const inA = (id: string) => {
      for (let p: string | null | undefined = id; p; p = parents.get(p)) if (p === A) return true;
      return false;
    };
    for (const r of runs) if (r.projectId) expect(inA(r.projectId)).toBe(true);
  });
});

describe('W  Switches', () => {
  it('Billing off: no billing field or amount anywhere in the payload', async () => {
    const text = await (await dfsRoute.GET(req('/api/dfs', viewerM))).text();
    expect(text).not.toMatch(/"billing"|"billingFlags"|"billed|unbilled/i);
    const withBilling = await (await dfsRoute.GET(req('/api/dfs', editorM))).json();
    expect(withBilling.rows.some((r: { billing?: unknown }) => r.billing)).toBe(true);
  });

  it('Edit Mode is refused without the Edit switch', async () => {
    expect((await editModeRoute.POST(req('/api/auth/edit-mode', viewerM, 'POST', { on: true }))).status).toBe(403);
    expect((await editModeRoute.POST(req('/api/auth/edit-mode', editorM, 'POST', { on: true }))).status).toBe(200);
  });

  it('Import / Export is refused without its switch', async () => {
    expect((await dfsExportRoute.GET(req('/api/dfs/export?format=csv', viewerM))).status).toBe(403);
    expect((await icHistory.GET(req('/api/import-centre/history', viewerM))).status).toBe(403);
    expect((await page('/import-centre', viewerM)).status).toBe(403);
  });

  it('planning screens are refused without the Planning switch', async () => {
    // The screens that list every project need Planning on every project …
    for (const p of ['/fy26', '/goals', '/drawing-control', '/update-centre']) {
      expect((await page(p, viewerM)).status, p).toBe(403);
      expect((await page(p, planner)).status, p).toBe(403);
      expect((await page(p, aa)).status, p).toBe(200);
    }
    expect((await page('/', planner)).headers.get('location')).toMatch(/\/drawings$/);
    // … the per-project planning views follow the switch on the project.
    expect((await dfsRoute.GET(req('/api/dfs?view=summary', viewerM))).status).toBe(403);
    expect((await page('/drawings?view=summary', viewerM)).status).toBe(403);
    expect((await page('/drawings?view=summary', planner)).status).toBe(200);
    expect((await drawingRoute.DELETE(req('/api/drawings/x', viewerM, 'DELETE'), params(drawingA))).status).toBe(403);
    // Planning on every top-level project opens them.
    const roots = [...(await projectParents())].filter(([, parent]) => !parent).map(([id]) => id);
    const plannerId = await memberId('planner');
    for (const projectId of roots) expect((await accessRoute.POST(req('/api/members/x/access', aa, 'POST', { projectId, level: 'member', switches: { planning: true } }), params(plannerId))).status).toBe(200);
    const fresh = cookieOf(await signIn('planner', pw('planner'), '10.9.9.1'));
    for (const p of ['/fy26', '/goals', '/']) expect((await page(p, fresh)).status, p).toBe(200);
  });
});

describe('G  Guards', () => {
  it('a plain member cannot manage members', async () => {
    expect((await membersRoute.GET(req(`/api/members?projectId=${A}`, viewerM))).status).toBe(403);
    expect((await page('/settings/members', viewerM)).status).toBe(403);
  });

  it('a Project Admin manages only their projects, and nobody above their level', async () => {
    expect((await membersRoute.POST(req('/api/members', pa, 'POST', { name: 'Test Elsewhere', email: email('elsewhere'), projectId: B }))).status).toBe(403);
    expect((await membersRoute.POST(req('/api/members', pa, 'POST', { name: 'Test Boss', email: email('boss'), accountAdmin: true }))).status).toBe(403);
    expect((await membersRoute.POST(req('/api/members', pa, 'POST', { name: 'Test Helper', email: email('helper'), projectId: A, switches: { billing: true } }))).status).toBe(200);
    expect((await membersRoute.GET(req(`/api/members?projectId=${B}`, pa))).status).toBe(403);
    // A switch on a project they do not administer.
    expect((await accessRoute.POST(req('/api/members/x/access', pa, 'POST', { projectId: B, switches: { billing: true } }), params(await memberId('viewer')))).status).toBe(403);
    // The Account Admin flag is not theirs to give.
    expect((await memberRoute.PATCH(req('/api/members/x', pa, 'PATCH', { accountAdmin: true }), params(await memberId('viewer')))).status).toBe(403);
  });

  it('a member on a project the Project Admin does not run cannot be deactivated by them', async () => {
    const id = await memberId('planner');
    expect((await accessRoute.POST(req('/api/members/x/access', aa, 'POST', { projectId: B, level: 'member' }), params(id))).status).toBe(200);
    expect((await actionsRoute.POST(req('/api/members/x/actions', pa, 'POST', { action: 'deactivate' }), params(id))).status).toBe(403);
  });

  it('nobody deactivates themselves; the last active Account Admin stays', async () => {
    const aaId = await memberId('aa');
    expect((await actionsRoute.POST(req('/api/members/x/actions', aa, 'POST', { action: 'deactivate' }), params(aaId))).status).toBe(409);
    expect((await memberRoute.PATCH(req('/api/members/x', aa, 'PATCH', { accountAdmin: false }), params(aaId))).status).toBe(409);
    // The emergency sign-in cannot remove the last one either.
    const em = cookieOf(await loginRoute.POST(post('/api/auth/login', { emergency: true, password: SUPER_PW }, '10.9.7.1')));
    expect((await actionsRoute.POST(req('/api/members/x/actions', em, 'POST', { action: 'deactivate' }), params(aaId))).status).toBe(409);
  });
});

describe('F  Import of Forma’s Members export', () => {
  function formaExport() {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['Members'],
        ['Name', 'Email', 'Company', 'Role', 'Access level', 'Status', 'Added on'],
        ['Test Forma One', email('forma1'), `Test Co ${PID}`, 'Architect', 'Project Admin', 'Active', '2026-01-02'],
        ['Test Forma Two', email('forma2'), `Test Co ${PID}`, `Test Role ${PID}`, 'Executive', 'Pending', '2026-01-03'],
        ['Test Forma Dup', email('forma2'), null, null, 'Member', 'Active', '2026-01-04'],
        ['Test Forma Bad', 'not-an-email', null, null, 'Member', 'Active', '2026-01-05'],
      ]),
      'Members',
    );
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }

  const upload = (cookie: string, apply: boolean) => {
    const form = new FormData();
    form.set('file', new File([new Uint8Array(formaExport())], 'members-export.xlsx'));
    form.set('projectId', A);
    form.set('apply', apply ? '1' : '0');
    return importRoute.POST(new Request('http://test.local/api/members/import', { method: 'POST', headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(cookie)}` }, body: form }));
  };

  it('reads the headers by name: "Project Admin" → Project Admin, anything else → Member', () => {
    const p = parseMembersWorkbook(formaExport());
    expect(p.rows.map((r) => r.level)).toEqual(['project_admin', 'member', 'member']);
    expect(p.errors).toHaveLength(1);
  });

  it('a dry run first (nothing written), then the import; unknown companies and roles are added', async () => {
    const dry = await (await upload(aa, false)).json();
    expect(dry.counts).toEqual({ new: 2, updated: 0, skipped: 1, errors: 1 });
    expect(await db.select().from(members).where(eq(members.email, email('forma1')))).toHaveLength(0);
    const done = await (await upload(aa, true)).json();
    expect(done.links).toHaveLength(2);
    const [one] = await db.select().from(members).where(eq(members.email, email('forma1')));
    const [g] = await db.select().from(projectMembers).where(and(eq(projectMembers.memberId, one.id), eq(projectMembers.projectId, A)));
    expect(g.accessLevel).toBe('project_admin');
    expect(one.status).toBe('invited');
    expect(await db.select().from(companies).where(eq(companies.name, `Test Co ${PID}`))).toHaveLength(1);
    // A plain member cannot import.
    expect((await upload(viewerM, false)).status).toBe(403);
  });
});

describe('L  Shared role sign-ins (LEGACY_ROLE_LOGINS)', () => {
  it('work while on; refused (and their sessions end) when off; members and the emergency sign-in keep working', async () => {
    delete process.env.LEGACY_ROLE_LOGINS;
    const legacy = await loginRoute.POST(post('/api/auth/login', { role: 'SUPER_ADMIN', password: SUPER_PW }, '10.9.8.1'));
    expect(legacy.status).toBe(200);
    const legacyCookie = cookieOf(legacy);
    expect(await sessionFor(legacyCookie)).not.toBeNull();
    process.env.LEGACY_ROLE_LOGINS = 'false';
    try {
      expect((await loginRoute.POST(post('/api/auth/login', { role: 'VIEWER' }, '10.9.8.2'))).status).toBe(403);
      expect(await sessionFor(legacyCookie)).toBeNull();
      expect((await signIn('editor', pw('editor'), '10.9.8.3')).status).toBe(200);
      expect((await loginRoute.POST(post('/api/auth/login', { emergency: true, password: SUPER_PW }, '10.9.8.4'))).status).toBe(200);
    } finally {
      delete process.env.LEGACY_ROLE_LOGINS;
    }
  });
});

describe('Audit', () => {
  it('member changes carry the name and email of the person who made them', async () => {
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'MEMBER'), isNotNull(auditLog.userLabel), sql`${auditLog.userLabel} like ${`%${email('aa')}%`}`));
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.some((r) => r.action === 'ADD_MEMBER')).toBe(true);
  });
});
