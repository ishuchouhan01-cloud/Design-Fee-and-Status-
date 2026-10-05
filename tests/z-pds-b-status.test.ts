/**
 * Project Drawing Status — the table, billing and Edit Mode.
 *
 *   T  roll-ups: every parent is the sum of its children (packages, drawings,
 *      billing); each package once; Not Applicable only at discipline level
 *   E  Edit Mode: inline edits recompute status, roll-ups and billing at
 *      once, with audit and reschedule history
 *   I  a re-import keeps what was edited
 *
 * Runs last (the registers are imported by drawings-a; nothing after it depends on these edits).
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { auditLog, drawings, packageFees, packages, projects, rescheduleHistory } from '@/db/schema';
import { SESSION_COOKIE } from '@/lib/access';
import { ensureLoginAccounts, setEditMode, sessionFor, signIn } from '@/lib/login';
import { runDrawingImport } from '@/lib/import/drawing-register';
import { BANNED_PHRASES } from '@/lib/labels';
import { buildDfsModel, modelBilling, modelTotals, type DfsModel, type DfsRow } from '@/lib/services/dfs';
import { aggregateStatus } from '@/components/status/status-tree';
import * as dfsRoute from '@/app/api/dfs/route';
import * as billingRoute from '@/app/api/status/billing/route';
import * as responsibleRoute from '@/app/api/status/responsible/route';
import * as packageRoute from '@/app/api/status/packages/[id]/route';
import * as packagesRoute from '@/app/api/status/packages/route';
import * as disciplinesRoute from '@/app/api/status/disciplines/route';
import * as towersRoute from '@/app/api/status/towers/route';
import * as archiveRoute from '@/app/api/status/archive/route';
import * as pkgDepsRoute from '@/app/api/status/packages/[id]/dependencies/route';
import * as rescheduleRoute from '@/app/api/reschedule/route';
import * as drawingRoute from '@/app/api/drawings/[id]/route';
import * as drawingsRoute from '@/app/api/drawings/route';

const VH = 'data/drawing-sources/violet-hill.json';
const available = fs.existsSync(path.resolve(process.cwd(), VH));
const PW = `admin-test-b-${process.pid}`;

const kids = (m: DfsModel, key: string) => (m.children.get(key) ?? []).map((k) => m.rows.get(k)!);
const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-6);

let cookie = '';
function req(url: string, method = 'GET', body?: unknown) {
  return new Request(`http://test.local${url}`, {
    method,
    headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(cookie)}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
async function call(p: Promise<Response>) {
  const r = await p;
  const body = await r.json();
  if (r.status >= 300) throw new Error(`${r.status}: ${JSON.stringify(body)}`);
  return body;
}

beforeAll(async () => {
  await ensureLoginAccounts({ ADMIN_PASSWORD: PW });
  cookie = (await signIn('ADMIN', PW, '10.9.0.1')).cookie;
  const s = await sessionFor(cookie);
  await setEditMode(s!.id, true);
});

// ---------------------------------------------------------------------------
describe('T  Roll-ups', () => {
  it('every parent row is the sum of its children — packages, drawings and billing; each package once', async () => {
    const m = await buildDfsModel({});
    for (const [k, r] of m.rows) {
      const c = kids(m, k);
      if (!c.length) continue;
      const sum = (f: keyof DfsRow) => c.reduce((s, x) => s + (x[f] as number), 0);
      expect(r.drawingsTotal, r.name).toBe(sum('drawingsTotal'));
      expect(r.drawingsReleased, r.name).toBe(sum('drawingsReleased'));
      if (r.kind === 'PROJECT' || r.kind === 'NODE') {
        for (const f of ['packagesTotal', 'packagesComplete', 'packagesPending', 'packagesNa'] as const) expect(r[f], `${r.name} ${f}`).toBe(sum(f));
      }
      // A package with one fee for the whole package carries it itself, not its disciplines.
      if (r.billing && r.group !== 'PKG') {
        const b = c.filter((x) => x.billing && (r.kind !== 'PROJECT' || x.kind !== 'DISCIPLINE'));
        near(r.billing.total, b.reduce((s, x) => s + x.billing!.total, 0));
        near(r.billing.billed, b.reduce((s, x) => s + x.billing!.billed, 0));
        near(r.billing.unbilled, r.billing.total - r.billing.billed);
      }
    }
    // Each package once: the root total equals the sum over package rows.
    const pkgRows = [...m.rows.values()].filter((r) => r.kind === 'PACKAGE');
    expect(new Set(pkgRows.map((r) => r.packageId)).size).toBe(pkgRows.length);
    const all = modelBilling(m)!;
    near(all.total, pkgRows.reduce((s, r) => s + (r.billing?.total ?? 0), 0));
    // The fee lines in SQL (every package in view, shown or not) = shown + left out (no drawing released).
    const ids = m.packages.filter((p) => p.visible && p.packageId).map((p) => p.packageId!);
    const [fees] = (
      await db.execute(sql`
        select (coalesce((select sum(round(f.fee_value::numeric, 4)) from package_fees f where f.applicability <> 'NA' and f.package_id in (${sql.join(ids.map((x) => sql`${x}`), sql`, `)})), 0)
              + coalesce((select sum(round(p.fee_value::numeric, 4)) from packages p where p.id in (${sql.join(ids.map((x) => sql`${x}`), sql`, `)})), 0))::float8 as total,
               (coalesce((select sum(round(f.billed_to_date_value::numeric, 4)) from package_fees f where f.applicability <> 'NA' and f.package_id in (${sql.join(ids.map((x) => sql`${x}`), sql`, `)})), 0)
              + coalesce((select sum(round(p.billed_to_date_value::numeric, 4)) from packages p where p.id in (${sql.join(ids.map((x) => sql`${x}`), sql`, `)})), 0))::float8 as billed`)
    ).rows as { total: number; billed: number }[];
    expect(Math.abs(all.total + m.excluded.noRelease.total - fees.total)).toBeLessThan(1e-6);
    expect(Math.abs(all.billed + m.excluded.noRelease.billed - fees.billed)).toBeLessThan(1e-6);
  });

  it('Not Applicable only at discipline (or a package marked so); it is out of the "of" denominators', async () => {
    const m = await buildDfsModel({});
    for (const r of m.rows.values()) {
      if (r.kind === 'PROJECT' || r.kind === 'NODE') {
        expect(r.status).toBeNull();
        expect(aggregateStatus(r)).not.toMatch(/not applicable/i);
        expect(r.packagesTotal).toBe(r.packagesComplete + r.packagesPending);
      }
    }
    const porr = [...m.rows.values()].find((r) => r.name === 'Pursuit of a Radical Rhapsody')!;
    expect(`${porr.packagesComplete} + ${porr.packagesPending} = ${porr.packagesTotal}`).toBe(`${porr.packagesComplete} + ${porr.packagesPending} = ${porr.packagesComplete + porr.packagesPending}`);
    expect(aggregateStatus(porr)).toBe(`${porr.packagesComplete} complete · ${porr.packagesPending} pending`);
    // A Not Applicable discipline has no drawings: it is an empty row, shown only with "Show empty rows" (Edit Mode).
    expect([...m.rows.values()].some((r) => r.kind === 'DISCIPLINE' && r.status === 'NA')).toBe(false);
    const withEmpty = await buildDfsModel({ showEmpty: true });
    expect([...withEmpty.rows.values()].some((r) => r.kind === 'DISCIPLINE' && r.status === 'NA' && r.empty)).toBe(true);
  });

  it('no "no drawings yet" (or any banned phrase) in a status response; a package with no drawings is Pending', async () => {
    const body = await (await dfsRoute.GET(req('/api/dfs?expand=packages'))).text();
    for (const p of BANNED_PHRASES) expect(body.toLowerCase()).not.toContain(p);
    const m = await buildDfsModel({});
    // A package with no drawings is an empty row: not shown, counted nowhere …
    expect([...m.rows.values()].some((r) => r.kind === 'PACKAGE' && r.drawingsTotal === 0)).toBe(false);
    // … and, shown in Edit Mode, it is Pending, greyed, with no billing.
    const withEmpty = await buildDfsModel({ showEmpty: true });
    const empty = [...withEmpty.rows.values()].filter((r) => r.kind === 'PACKAGE' && r.empty && r.status !== 'NA');
    expect(empty.length).toBeGreaterThan(0);
    for (const r of empty) {
      expect(r.status).toBe('NOT_COMPLETE');
      expect(r.packagesTotal).toBe(0);
      expect(r.billing).toBeNull();
    }
    // A pending package with released drawings and an amount to bill is flagged "eligible after completion".
    expect([...m.rows.values()].some((r) => r.kind === 'PACKAGE' && r.status === 'NOT_COMPLETE' && r.drawingsReleased > 0 && (r.billingFlags ?? []).includes('ELIGIBLE_AFTER_COMPLETION'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('E  Edit Mode', () => {
  it('releasing the last open drawing of a discipline completes it, and the package and totals move at once', async () => {
    // A discipline with exactly one drawing not released.
    const [u] = (
      await db.execute(sql`
        select d.package_id, d.discipline_id, min(d.id) filter (where d.completion_status = 'NOT_COMPLETED') as open_id
        from drawings d where d.package_id is not null and d.archived_at is null
        group by d.package_id, d.discipline_id
        having count(*) filter (where d.completion_status = 'NOT_COMPLETED') = 1 and count(*) > 1
        limit 1`)
    ).rows as { package_id: string; open_id: string }[];
    const before = modelTotals(await buildDfsModel({}));
    await call(drawingRoute.PATCH(req(`/api/drawings/${u.open_id}`, 'PATCH', { completionStatus: 'COMPLETED', actualReleaseDate: '2026-09-01' }), params(u.open_id)));
    const m = await buildDfsModel({});
    const after = modelTotals(m);
    expect(after.drawingsReleased).toBe(before.drawingsReleased + 1);
    const pkg = [...m.rows.values()].find((r) => r.kind === 'PACKAGE' && r.packageId === u.package_id)!;
    const disc = kids(m, pkg.key).find((r) => r.drawingsTotal > 0 && r.drawingsReleased === r.drawingsTotal);
    expect(disc?.status).toBe('COMPLETE');
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.entityId, u.open_id), eq(auditLog.action, 'RELEASE_DRAWING')));
    expect(audit.length).toBeGreaterThan(0);
    // Put it back (a withdrawal needs a reason, and is audited too).
    await call(drawingRoute.PATCH(req(`/api/drawings/${u.open_id}`, 'PATCH', { completionStatus: 'NOT_COMPLETED', reason: 'Edit Mode test: put back' }), params(u.open_id)));
    expect(modelTotals(await buildDfsModel({})).drawingsReleased).toBe(before.drawingsReleased);
  });

  it('Billed on a pending package: billing recomputes at once, the warning shows, the audit records it', async () => {
    const m0 = await buildDfsModel({});
    const pending = [...m0.rows.values()].find((r) => r.kind === 'DISCIPLINE' && r.status === 'NOT_COMPLETE' && r.packageId && r.billing && r.billing.billed === 0 && r.billing.total > 0)!;
    const b0 = modelBilling(m0)!;
    await call(billingRoute.PATCH(req('/api/status/billing', 'PATCH', { packageId: pending.packageId, group: pending.group, billed: 0.0125 })));
    const m1 = await buildDfsModel({});
    const row = m1.rows.get(pending.key)!;
    near(row.billing!.billed, 0.0125);
    near(row.billing!.unbilled, row.billing!.total - 0.0125);
    expect(row.billingFlags).toContain('BILLED_BEFORE_COMPLETION');
    near(modelBilling(m1)!.billed, b0.billed + 0.0125);
    const pkg = m1.rows.get(row.parentKey!)!;
    expect(pkg.billingFlags).toContain('BILLED_BEFORE_COMPLETION');
    // Neither value is changed by the system; an invalid amount is refused plainly.
    const bad = await billingRoute.PATCH(req('/api/status/billing', 'PATCH', { packageId: pending.packageId, group: pending.group, billed: -1 }));
    expect(bad.status).toBe(422);
    const a = await db.select().from(auditLog).where(and(eq(auditLog.entityId, pending.packageId!), eq(auditLog.field, `billing.billed.${pending.group}`)));
    expect(a.length).toBe(1);
    const [fee] = await db.execute(sql`select f.user_edited_fields from package_fees f join disciplines d on d.id = f.discipline_id where f.package_id = ${pending.packageId} and coalesce(d.dfs_group, d.code) = ${pending.group}`).then((r) => r.rows as { user_edited_fields: string }[]);
    expect(fee.user_edited_fields).toContain('billedToDateValue');
    await call(billingRoute.PATCH(req('/api/status/billing', 'PATCH', { packageId: pending.packageId, group: pending.group, billed: 0 })));
  });

  it('a package expected date moves through the reschedule engine: history kept, baseline unchanged', async () => {
    const [p] = await db.select().from(packages).where(and(isNull(packages.archivedAt), sql`${packages.currentExpectedReleaseDate} is not null`, isNull(packages.actualReleaseDate))).limit(1);
    const before = p.baselineReleaseDate?.getTime() ?? null;
    const target = new Date(p.currentExpectedReleaseDate!.getTime() + 14 * 86_400_000).toISOString().slice(0, 10);
    const res = await call(rescheduleRoute.POST(req('/api/reschedule', 'POST', { entityType: 'PACKAGE', ids: [p.id], newExpectedDate: target, reason: 'Edit Mode test: two weeks later', scope: 'ITEM', confirm: true })));
    expect(res.mode).toBe('APPLIED');
    const [after] = await db.select().from(packages).where(eq(packages.id, p.id));
    expect(after.currentExpectedReleaseDate!.toISOString().slice(0, 10)).toBe(target);
    expect(after.baselineReleaseDate?.getTime() ?? null).toBe(before);
    expect(after.userEditedFields).toContain('currentExpectedReleaseDate');
    const h = await db.select().from(rescheduleHistory).where(and(eq(rescheduleHistory.entityType, 'PACKAGE'), eq(rescheduleHistory.entityId, p.id)));
    expect(h.some((x) => x.reason === 'Edit Mode test: two weeks later')).toBe(true);
    // A drawing's date as well, with a reason.
    const [d] = await db.select().from(drawings).where(and(eq(drawings.completionStatus, 'NOT_COMPLETED'), isNull(drawings.archivedAt), sql`${drawings.currentExpectedReleaseDate} is not null`)).limit(1);
    await call(rescheduleRoute.POST(req('/api/reschedule', 'POST', { entityType: 'DRAWING', ids: [d.id], newExpectedDate: '2027-03-31', reason: 'Edit Mode test: drawing', scope: 'ITEM', confirm: true })));
    const [dd] = await db.select().from(drawings).where(eq(drawings.id, d.id));
    expect(dd.baselineReleaseDate?.getTime()).toBe(d.baselineReleaseDate?.getTime());
    expect(dd.editedAt).not.toBeNull();
  });

  it('add a tower, a package under it, a discipline and a drawing; archive them; totals follow', async () => {
    const [vh] = await db.select().from(projects).where(eq(projects.projectCode, 'VIOLET-HILL'));
    const t0 = modelTotals(await buildDfsModel({}));
    const tower = await call(towersRoute.POST(req('/api/status/towers', 'POST', { parentProjectId: vh.id, name: 'Block Test' })));
    expect((await towersRoute.POST(req('/api/status/towers', 'POST', { parentProjectId: vh.id, name: 'Block Test' }))).status).toBe(400);
    const pkg = await call(packagesRoute.POST(req('/api/status/packages', 'POST', { projectId: tower.id, packageCode: 'BT-01', packageName: 'Block Test Package', expectedReleaseDate: '2027-01-15', responsible: 'Test Lead' })));
    const dup = await packagesRoute.POST(req('/api/status/packages', 'POST', { projectId: tower.id, packageCode: 'bt-01', packageName: 'Again' }));
    expect(dup.status).toBe(400);
    expect((await dup.json()).error).toMatch(/already used/);
    const ar = (await db.execute(sql`select id from disciplines where code = 'AR'`)).rows[0] as { id: string };
    await call(disciplinesRoute.POST(req('/api/status/disciplines', 'POST', { packageId: pkg.id, disciplineId: ar.id })));
    // With no drawing yet the new package is an empty row: shown in Edit Mode ("Show empty rows"), not counted.
    let m = await buildDfsModel({ projectId: vh.id, showEmpty: true });
    const pkgRow = [...m.rows.values()].find((r) => r.packageId === pkg.id && r.kind === 'PACKAGE')!;
    expect(pkgRow.responsible).toBe('Test Lead');
    expect(pkgRow.status).toBe('NOT_COMPLETE');
    expect(pkgRow.empty).toBe(true);
    expect(kids(m, pkgRow.key).map((r) => r.name)).toEqual(['Architecture']);
    expect([...(await buildDfsModel({ projectId: vh.id })).rows.values()].some((r) => r.packageId === pkg.id)).toBe(false);
    expect(modelTotals(await buildDfsModel({})).packagesTotal).toBe(t0.packagesTotal);
    const created = await call(drawingsRoute.POST(req('/api/drawings', 'POST', { projectId: tower.id, packageId: pkg.id, disciplineId: ar.id, drawingNumber: 'BT-AR-0001', drawingName: 'Block test plan', expectedReleaseDate: '2027-01-10' })));
    m = await buildDfsModel({ projectId: vh.id });
    const disc = kids(m, [...m.rows.values()].find((r) => r.packageId === pkg.id && r.kind === 'PACKAGE')!.key)[0];
    expect(disc.drawingsTotal).toBe(1);
    const t1 = modelTotals(await buildDfsModel({}));
    expect(t1.drawingsTotal).toBe(t0.drawingsTotal + 1);
    expect(t1.packagesTotal).toBe(t0.packagesTotal + 1);
    // Dependencies under the package: the empty-row pattern (add, then close).
    await call(pkgDepsRoute.POST(req(`/api/status/packages/${pkg.id}/dependencies`, 'POST', { department: 'Structure', description: 'Loads from structure', ownerText: 'Test Lead', targetDate: '2026-12-01' }), params(pkg.id)));
    expect((await call(pkgDepsRoute.GET(req(`/api/status/packages/${pkg.id}/dependencies`), params(pkg.id)))).rows).toHaveLength(1);
    // Archive the drawing, then the tower: gone from the table, kept in the database and the audit trail.
    await call(archiveRoute.POST(req('/api/status/archive', 'POST', { kind: 'DRAWING', id: created.id, reason: 'Edit Mode test' })));
    expect(modelTotals(await buildDfsModel({})).drawingsTotal).toBe(t0.drawingsTotal);
    expect((await archiveRoute.POST(req('/api/status/archive', 'POST', { kind: 'PROJECT', id: vh.id, reason: 'Edit Mode test' }))).status).toBe(400);
    await call(archiveRoute.POST(req('/api/status/archive', 'POST', { kind: 'PROJECT', id: tower.id, reason: 'Edit Mode test' })));
    const t2 = modelTotals(await buildDfsModel({}));
    expect(t2.packagesTotal).toBe(t0.packagesTotal);
    expect((await db.select().from(drawings).where(eq(drawings.id, created.id))).length).toBe(1);
    expect((await db.select().from(auditLog).where(and(eq(auditLog.action, 'ARCHIVE'), eq(auditLog.entityId, tower.id)))).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe.skipIf(!available)('I  A re-import keeps what was edited', () => {
  it('package name, code and Responsible Person, a billed amount and a drawing name survive the import; nothing is duplicated', async () => {
    const [vh] = await db.select().from(projects).where(eq(projects.projectCode, 'VIOLET-HILL'));
    const [p] = await db.select().from(packages).where(and(eq(packages.projectId, vh.id), isNull(packages.archivedAt), sql`${packages.sourceWorkbook} is not null`)).limit(1);
    const [f] = await db.select().from(packageFees).where(eq(packageFees.packageId, p.id)).limit(1);
    const group = ((await db.execute(sql`select coalesce(dfs_group, code) as g from disciplines where id = ${f.disciplineId}`)).rows[0] as { g: string }).g;
    const [d] = await db.select().from(drawings).where(and(eq(drawings.projectId, vh.id), isNull(drawings.archivedAt))).limit(1);
    const oldCode = p.packageCode;
    await call(packageRoute.PATCH(req(`/api/status/packages/${p.id}`, 'PATCH', { packageName: 'Renamed in Edit Mode', packageCode: `${oldCode}-E` }), params(p.id)));
    await call(responsibleRoute.PATCH(req('/api/status/responsible', 'PATCH', { kind: 'PACKAGE', id: p.id, name: 'Edit Mode Lead' })));
    await call(responsibleRoute.PATCH(req('/api/status/responsible', 'PATCH', { kind: 'DRAWING', id: d.id, name: 'Drawing Lead' })));
    await call(billingRoute.PATCH(req('/api/status/billing', 'PATCH', { packageId: p.id, group, total: 9.8765 })));
    await call(drawingRoute.PATCH(req(`/api/drawings/${d.id}`, 'PATCH', { drawingName: 'Renamed drawing', reason: 'Edit Mode test' }), params(d.id)));
    const counts = async () => ({
      packages: Number(((await db.execute(sql`select count(*)::int n from packages where project_id = ${vh.id}`)).rows[0] as { n: number }).n),
      drawings: Number(((await db.execute(sql`select count(*)::int n from drawings where project_id = ${vh.id}`)).rows[0] as { n: number }).n),
    });
    const before = await counts();
    await runDrawingImport({ apply: true, manifestPath: VH, actor: { id: null, label: 'Re-import test' } });
    expect(await counts()).toEqual(before);
    const [p2] = await db.select().from(packages).where(eq(packages.id, p.id));
    expect(p2.packageName).toBe('Renamed in Edit Mode');
    expect(p2.packageCode).toBe(`${oldCode}-E`);
    expect(p2.responsibleText).toBe('Edit Mode Lead');
    const [f2] = await db.select().from(packageFees).where(eq(packageFees.id, f.id));
    expect(f2.feeValue).toBe(9.8765);
    const [d2] = await db.select().from(drawings).where(eq(drawings.id, d.id));
    expect(d2.drawingName).toBe('Renamed drawing');
    expect(d2.responsibleText).toBe('Drawing Lead');
    expect(d2.packageId).toBe(d.packageId);
  });
});
