/**
 * Project Drawing Status — screen rules A–C, on a fixture project built here.
 *
 *   A  empty verticals: a discipline / package / heading / project with no
 *      drawings is not shown and counts nowhere; Edit Mode can show it
 *   B  no billing without a released drawing: such a fee line shows "—", is
 *      left out of every roll-up and the header, and — when it carries a
 *      Billed amount — is listed under "Billing to review"; source = shown +
 *      left out
 *   C  "Expand to" opens exactly the chosen depth
 *   Viewer still receives no billing fields.
 *
 * The fixture (no real data):
 *   Fixture Estate (project) → Phase X (part of it) → Villa Block 1 (heading)
 *     P1  AR 2 released, ST 1 released; fee lines AR 1.0/0.5, ST 0.5/0.2,
 *         MEP 0.3/0.02 (no drawings), LS 0.1/0 (no drawings)
 *     P2  one AR drawing, not released; one fee for the whole package 0.8/0.1
 *     P3  no drawings at all; AR fee 0.2/0
 *     P4  two ST drawings released; one fee for the whole package 0.4/0.4
 *   Empty Tower (part of Fixture Estate) — a package with no drawings only
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { dfsWbsNodes, disciplines, drawings, packageFees, packages, projects } from '@/db/schema';
import { SESSION_COOKIE } from '@/lib/access';
import { newId } from '@/lib/ids';
import { ensureLoginAccounts, signIn } from '@/lib/login';
import { lineBilling } from '@/lib/services/billing-rollup';
import { buildDfsModel, DFS_LEVELS, forRole, levelRank, modelBilling, modelTotals, rowsOf, type DfsLevel, type DfsModel, type DfsRow } from '@/lib/services/dfs';
import * as dfsRoute from '@/app/api/dfs/route';

const ids = { estate: newId('pr_'), phase: newId('pr_'), emptyTower: newId('pr_'), node: newId('wbs_'), p1: newId('pk_'), p2: newId('pk_'), p3: newId('pk_'), p4: newId('pk_'), p5: newId('pk_') };
const kids = (m: DfsModel, key: string) => (m.children.get(key) ?? []).map((k) => m.rows.get(k)!);
const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-6);

async function model(extra: Record<string, unknown> = {}) {
  return buildDfsModel({ projectId: ids.estate, ...extra });
}

beforeAll(async () => {
  const disc = new Map((await db.select().from(disciplines)).map((d) => [d.code, d.id]));
  const stamp = new Date();
  await db.insert(projects).values([
    { id: ids.estate, projectCode: `FIX-${ids.estate.slice(-6)}`, projectName: 'Fixture Estate', displayName: 'Fixture Estate', updatedAt: stamp },
    { id: ids.phase, projectCode: `FIX-${ids.phase.slice(-6)}`, projectName: 'Phase X', displayName: 'Phase X', parentProjectId: ids.estate, updatedAt: stamp },
    { id: ids.emptyTower, projectCode: `FIX-${ids.emptyTower.slice(-6)}`, projectName: 'Empty Tower', displayName: 'Empty Tower', parentProjectId: ids.estate, updatedAt: stamp },
  ]);
  await db.insert(dfsWbsNodes).values({ id: ids.node, projectId: ids.phase, nodeType: 'BLOCK', name: 'Villa Block 1', code: 'BB01', sourceLabel: 'GFC | Villa Block 1', nodeKey: 'fixture::Villa Block 1', sequence: 10 });
  const pkg = (id: string, projectId: string, code: string, name: string, seq: number, fee?: { total: number; billed: number }) => ({
    id,
    projectId,
    packageCode: code,
    sourceCode: code,
    packageName: name,
    sequence: seq,
    wbsNodeId: projectId === ids.phase ? ids.node : null,
    feeValue: fee?.total ?? null,
    billedToDateValue: fee?.billed ?? null,
    updatedAt: stamp,
  });
  await db.insert(packages).values([
    pkg(ids.p1, ids.phase, 'BB01-1', 'Foundations', 10),
    pkg(ids.p2, ids.phase, 'BB01-2', 'Super Structure', 20, { total: 0.8, billed: 0.1 }),
    pkg(ids.p3, ids.phase, 'BB01-3', 'Building Envelope', 30),
    pkg(ids.p4, ids.phase, 'BB01-4', 'Terrace', 40, { total: 0.4, billed: 0.4 }),
    pkg(ids.p5, ids.emptyTower, 'ET-1', 'Nothing yet', 10, { total: 0.5, billed: 0 }),
  ]);
  const line = (packageId: string, code: string, fee: number, billed: number) => ({ id: newId('pf_'), packageId, disciplineId: disc.get(code)!, feeValue: fee, billedToDateValue: billed, applicability: 'APPLICABLE', updatedAt: stamp });
  await db.insert(packageFees).values([line(ids.p1, 'AR', 1.0, 0.5), line(ids.p1, 'ST', 0.5, 0.2), line(ids.p1, 'MEP', 0.3, 0.02), line(ids.p1, 'LS', 0.1, 0), line(ids.p3, 'AR', 0.2, 0)]);
  let n = 0;
  const dw = (packageId: string, code: string, released: boolean) => ({
    id: newId('dw_'),
    projectId: ids.phase,
    packageId,
    disciplineId: disc.get(code)!,
    drawingCode: `FIX-${code}-${++n}-${ids.phase.slice(-4)}`,
    drawingNumber: `FIX-${code}-${n}-${ids.phase.slice(-4)}`,
    drawingName: `Fixture drawing ${n}`,
    completionStatus: released ? 'COMPLETED' : 'NOT_COMPLETED',
    updatedAt: stamp,
  });
  await db.insert(drawings).values([dw(ids.p1, 'AR', true), dw(ids.p1, 'AR', true), dw(ids.p1, 'ST', true), dw(ids.p2, 'AR', false), dw(ids.p4, 'ST', true), dw(ids.p4, 'ST', true)]);
});

function expectParentIsSum(m: DfsModel) {
  for (const r of m.rows.values()) {
    const c = kids(m, r.key);
    if (!c.length || r.kind === 'DISCIPLINE') continue;
    const sub = r.kind === 'PACKAGE' ? c : c.filter((x) => x.kind !== 'DISCIPLINE' || r.kind === 'PROJECT');
    expect(r.drawingsTotal, r.name).toBe(sub.reduce((a, x) => a + x.drawingsTotal, 0));
    expect(r.drawingsReleased, r.name).toBe(sub.reduce((a, x) => a + x.drawingsReleased, 0));
    if (r.kind === 'PACKAGE') continue;
    expect(r.packagesTotal, r.name).toBe(c.reduce((a, x) => a + x.packagesTotal, 0));
    expect(r.packagesComplete, r.name).toBe(c.reduce((a, x) => a + x.packagesComplete, 0));
    const b = c.reduce((a, x) => a + (x.billing?.total ?? 0), 0);
    near(r.billing?.total ?? 0, b);
    near(r.billing?.billed ?? 0, c.reduce((a, x) => a + (x.billing?.billed ?? 0), 0));
  }
}

describe('A  empty verticals are not shown and count nowhere', () => {
  it('a discipline with no drawings is not a row; the package status ignores it', async () => {
    const m = await model();
    const p1 = m.rows.get(`K:${ids.phase}|${ids.p1}`)!;
    expect(kids(m, p1.key).map((r) => r.name)).toEqual(['Architecture', 'Structural']);
    expect(p1.status).toBe('COMPLETE');
    expect(p1.drawingsTotal).toBe(3);
  });

  it('a package, tower or project with no drawings is not shown and is not counted', async () => {
    const m = await model();
    expect(m.rows.has(`K:${ids.phase}|${ids.p3}`)).toBe(false);
    expect(m.rows.has(`P:${ids.emptyTower}`)).toBe(false);
    const estate = m.rows.get(`P:${ids.estate}`)!;
    // P1 and P4 complete, P2 pending; P3 and the empty tower's package nowhere.
    expect([estate.packagesComplete, estate.packagesPending, estate.packagesTotal]).toEqual([2, 1, 3]);
    expect([estate.drawingsReleased, estate.drawingsTotal]).toEqual([5, 6]);
    expect(kids(m, estate.key).map((r) => r.name)).toEqual(['Phase X']);
  });

  it('Edit Mode "Show empty rows": the rows come back, marked empty, still not counted', async () => {
    const m = await model({ showEmpty: true });
    const p1 = m.rows.get(`K:${ids.phase}|${ids.p1}`)!;
    expect(kids(m, p1.key).map((r) => [r.name, Boolean(r.empty)])).toEqual([
      ['Architecture', false],
      ['Structural', false],
      ['Mechanical, Electrical & Plumbing', true],
      ['Landscape', true],
    ]);
    const p3 = m.rows.get(`K:${ids.phase}|${ids.p3}`)!;
    expect(p3.empty).toBe(true);
    expect(m.rows.get(`P:${ids.emptyTower}`)!.empty).toBe(true);
    const estate = m.rows.get(`P:${ids.estate}`)!;
    expect([estate.packagesComplete, estate.packagesPending, estate.packagesTotal]).toEqual([2, 1, 3]);
  });
});

describe('B  no billing without a released drawing', () => {
  it('the rule itself: a line with no released drawing contributes nothing and is reported', () => {
    expect(lineBilling({ total: 0.3, billed: 0.02, released: 0 })).toEqual({ billing: null, excluded: { total: 0.3, billed: 0.02 } });
    expect(lineBilling({ total: 1, billed: 0.5, released: 1 })).toEqual({ billing: { total: 1, billed: 0.5, unbilled: 0.5 }, excluded: null });
    expect(lineBilling({ total: null, billed: null, released: 3 })).toEqual({ billing: null, excluded: null });
  });

  it('a package bills only its lines with released drawings; a whole-package fee with none shows "—"', async () => {
    const m = await model();
    const p1 = m.rows.get(`K:${ids.phase}|${ids.p1}`)!;
    expect(p1.billing).toEqual({ total: 1.5, billed: 0.7, unbilled: 0.8 });
    const p2 = m.rows.get(`K:${ids.phase}|${ids.p2}`)!;
    expect(p2.billing).toBeNull();
    expect(p2.billingFlags).toContain('EXCLUDED_NO_RELEASE');
    expect(p2.billingFlags).not.toContain('ELIGIBLE_AFTER_COMPLETION');
    const p4 = m.rows.get(`K:${ids.phase}|${ids.p4}`)!;
    expect(p4.billing).toEqual({ total: 0.4, billed: 0.4, unbilled: 0 });
    expect(p4.group).toBe('PKG');
  });

  it('"Billing to review": billed lines with no drawing released — the MEP line and the whole-package line', async () => {
    const m = await model();
    expect(m.review.map((r) => [r.packageCode, r.discipline, r.total, r.billed, r.reason]).sort()).toEqual([
      ['BB01-1', 'MEP', 0.3, 0.02, 'No drawings released'],
      ['BB01-2', 'PKG', 0.8, 0.1, 'No drawings released'],
    ]);
  });

  it('parent = sum of the visible children; header = sum of the top rows; source = shown + left out', async () => {
    const m = await model();
    expectParentIsSum(m);
    const header = modelBilling(m)!;
    const top = m.roots.map((k) => m.rows.get(k)!);
    near(header.total, top.reduce((a, r) => a + (r.billing?.total ?? 0), 0));
    expect(header).toEqual({ total: 1.9, billed: 1.1, unbilled: 0.8 });
    // Stored: P1 1.9/0.72, P2 0.8/0.1, P3 0.2/0, P4 0.4/0.4, empty tower 0.5/0 → 3.8 / 1.22.
    expect(m.source).toEqual({ total: 3.8, billed: 1.22 });
    near(m.source.total, header.total + m.excluded.noRelease.total + m.excluded.notApplicable.total);
    near(m.source.billed, header.billed + m.excluded.noRelease.billed + m.excluded.notApplicable.billed);
    const t = modelTotals(m);
    expect([t.packagesComplete, t.packagesTotal, t.drawingsReleased, t.drawingsTotal]).toEqual([2, 3, 5, 6]);
  });
});

describe('C  "Expand to" opens exactly the chosen depth', () => {
  it('each level shows every row down to it and nothing below', async () => {
    const m = await model();
    const deepest = (rows: DfsRow[]) => Math.max(...rows.map((r) => levelRank(r.level)));
    const expected: Record<DfsLevel, string[]> = {
      PROJECT: ['PROJECT'],
      PHASE: ['PROJECT', 'PHASE'],
      TOWER: ['PROJECT', 'PHASE', 'TOWER'],
      PACKAGE: ['PROJECT', 'PHASE', 'TOWER', 'PACKAGE'],
      DISCIPLINE: ['PROJECT', 'PHASE', 'TOWER', 'PACKAGE', 'DISCIPLINE'],
      DRAWING: ['PROJECT', 'PHASE', 'TOWER', 'PACKAGE', 'DISCIPLINE'],
    };
    for (const level of DFS_LEVELS) {
      const rows = rowsOf(m, null, level);
      expect([...new Set(rows.map((r) => r.level))], level).toEqual(expected[level]);
      expect(deepest(rows), level).toBeLessThanOrEqual(Math.min(levelRank(level), levelRank('DISCIPLINE')));
    }
    expect(rowsOf(m, null, 'PACKAGE').filter((r) => r.kind === 'PACKAGE').map((r) => r.code)).toEqual(['BB01-1', 'BB01-2', 'BB01-4']);
    // One row's ▸ still opens one level.
    expect(rowsOf(m, `P:${ids.estate}`).map((r) => r.level)).toEqual(['PHASE']);
  });

  it('each row carries its level and tag', async () => {
    const m = await model();
    expect(m.rows.get(`P:${ids.estate}`)!.level).toBe('PROJECT');
    expect(m.rows.get(`P:${ids.phase}`)!).toMatchObject({ level: 'PHASE', typeLabel: 'Phase' });
    expect(m.rows.get(`W:${ids.node}`)!).toMatchObject({ level: 'TOWER', typeLabel: 'Block' });
  });

  it('the filters apply when expanding', async () => {
    const m = await model({ release: 'NOT_COMPLETED' });
    expect(rowsOf(m, null, 'PACKAGE').filter((r) => r.kind === 'PACKAGE').map((r) => r.code)).toEqual(['BB01-2']);
  });
});

describe('Viewer', () => {
  it('receives no billing fields, at any level', async () => {
    await ensureLoginAccounts({});
    const { cookie } = await signIn('VIEWER', undefined, '10.7.0.1');
    const res = await dfsRoute.GET(new Request(`http://test.local/api/dfs?projectId=${ids.estate}&expand=discipline`, { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(cookie)}` } }));
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as { rows: Record<string, unknown>[]; totals: Record<string, unknown> };
    expect(body.rows.length).toBeGreaterThan(5);
    for (const r of body.rows) {
      expect('billing' in r).toBe(false);
      expect('billingFlags' in r).toBe(false);
    }
    expect('billing' in body.totals).toBe(false);
    expect(text).not.toMatch(/feeValue|billedToDate|review/);
    const m = await model();
    for (const r of m.rows.values()) expect(Object.keys(forRole(r, false))).not.toContain('billing');
  });

  it('cannot see empty rows (Edit Mode only)', async () => {
    const { cookie } = await signIn('VIEWER', undefined, '10.7.0.2');
    const res = await dfsRoute.GET(new Request(`http://test.local/api/dfs?projectId=${ids.estate}&expand=discipline&showEmpty=1`, { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(cookie)}` } }));
    const body = (await res.json()) as { rows: DfsRow[] };
    expect(body.rows.some((r) => r.empty)).toBe(false);
  });
});

describe('cleanup', () => {
  it('removes the fixture', async () => {
    await db.delete(drawings).where(eq(drawings.projectId, ids.phase));
    await db.delete(packages).where(inArray(packages.projectId, [ids.phase, ids.emptyTower]));
    await db.delete(dfsWbsNodes).where(eq(dfsWbsNodes.projectId, ids.phase));
    await db.delete(projects).where(inArray(projects.id, [ids.phase, ids.emptyTower]));
    await db.delete(projects).where(eq(projects.id, ids.estate));
    expect((await db.select().from(projects).where(eq(projects.id, ids.estate))).length).toBe(0);
  });
});
