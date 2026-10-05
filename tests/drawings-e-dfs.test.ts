/**
 * DFS (Design Fee Schedule), DFS Summary and billing — the hierarchy from the
 * base DFS (Design Fee sheet), every status and figure from the drawing
 * records. Runs after drawings-a..d (the PoaRR register, its base DFS and the
 * Drawing Control edits are in place).
 *
 *   W WBS parser (generic, any project)   H permissions
 *   G hierarchy (V40, towers, T08)        I release without a date
 *   A package completion                  J reschedule engine
 *   B billing trigger                     K baseline protection
 *   C–E roll-ups / summary                L import protection
 *   F Scope / Actual separation           M no FY26 regression
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { dfsWbsNodes, disciplines, drawingImportBatches, drawingImportIssues, drawings, packageFees, packages, projects, users } from '@/db/schema';
import { nodeTypeOf, parseDesignFee } from '@/lib/import/drawing-register/design-fee';
import { headingResolver } from '@/lib/import/drawing-register/plan';
import type { TextSheet } from '@/lib/import/drawing-register/read';
import { runDrawingImport } from '@/lib/import/drawing-register';
import { newId } from '@/lib/ids';
import { addDays, startOfDay } from '@/lib/periods';
import { applyReschedule } from '@/lib/reschedule';
import {
  NO_PACKAGE,
  buildDfsModel,
  bucketOfPeriod,
  dfsPeriods,
  dfsSummary,
  drawingReleasePeriod,
  latestPeriod,
  loadDfs,
  modelTotals,
  parseUnitKey,
  rowsOf,
  unitDrawings,
  unitKey,
  type DfsModel,
  type DfsRow,
  type DfsUnit,
} from '@/lib/services/dfs';
import { setUnitApplicability } from '@/lib/services/dfs-admin';
import { DrawingRuleError, releaseDrawing, unreleaseDrawing, updateDrawing } from '@/lib/services/drawing-control';
import * as dfsRoute from '@/app/api/dfs/route';
import * as unitDrawingsRoute from '@/app/api/dfs/unit-drawings/route';
import * as applicabilityRoute from '@/app/api/dfs/applicability/route';

const MANIFEST = path.resolve(process.cwd(), 'data/drawing-sources/poarr.json');
const available = fs.existsSync(MANIFEST);
const editor = { id: null, label: 'DFS tester (EDITOR)' };
const admin = { id: null, label: 'DFS tester (ADMIN)' };

const EMAIL = {
  VIEWER: 'drawing-viewer@test.local',
  EDITOR: 'drawing-editor@test.local',
  MANAGER: 'drawing-manager@test.local',
  ADMIN: 'admin@company.local',
} as const;
type Role = keyof typeof EMAIL;
function req(role: Role, url: string, method = 'GET', body?: unknown) {
  return new Request(`http://test.local${url}`, {
    method,
    headers: { 'x-user-email': EMAIL[role], 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function project(code: string) {
  const [p] = await db.select().from(projects).where(eq(projects.projectCode, code)).limit(1);
  return p;
}
async function unitOf(key: string): Promise<DfsUnit> {
  const { projectId } = parseUnitKey(key)!;
  const { units } = await loadDfs({ projectId });
  const u = units.find((x) => x.key === key);
  if (!u) throw new Error(`unit ${key} not found`);
  return u;
}
async function drawingsOfUnit(key: string) {
  const res = await unitDrawings(key, {}, 1, 200);
  return res.rows;
}
const kids = (m: DfsModel, key: string) => (m.children.get(key) ?? []).map((k) => m.rows.get(k)!);
function rowNamed(m: DfsModel, under: string, name: string): DfsRow | undefined {
  for (const r of kids(m, under)) {
    if (r.name === name) return r;
    const c = rowNamed(m, r.key, name);
    if (c) return c;
  }
  return undefined;
}
const packageRows = (m: DfsModel, under: string): DfsRow[] => kids(m, under).flatMap((r) => (r.kind === 'PACKAGE' ? [r] : r.kind === 'DISCIPLINE' ? [] : packageRows(m, r.key)));
/** Every aggregate row equals the sum of its children, at every level. */
function expectParentIsSum(m: DfsModel) {
  for (const [k, r] of m.rows) {
    const c = kids(m, k);
    if (!c.length) continue;
    const sum = (f: keyof DfsRow) => c.reduce((s, x) => s + (x[f] as number), 0);
    expect(r.drawingsTotal).toBe(sum('drawingsTotal'));
    expect(r.drawingsReleased).toBe(sum('drawingsReleased'));
    if (r.kind === 'PROJECT' || r.kind === 'NODE') {
      for (const f of ['packagesTotal', 'packagesComplete', 'packagesPending', 'packagesNa'] as const) expect(r[f]).toBe(sum(f));
      expect(r.packagesTotal).toBe(r.packagesComplete + r.packagesPending);
      expect(r.packagesTotal + r.packagesNa).toBe(packageRows(m, k).length);
    }
  }
}
async function feeRows() {
  return db.select().from(packageFees).orderBy(packageFees.id);
}
async function fy26Counts() {
  const t = await db.execute(sql`select tablename from pg_tables where schemaname = current_schema() and tablename like 'fy26%' order by 1`);
  const out: Record<string, number> = {};
  for (const r of t.rows as { tablename: string }[]) {
    const c = await db.execute(sql.raw(`select count(*)::int as n from "${r.tablename}"`));
    out[r.tablename] = Number((c.rows[0] as { n: number }).n);
  }
  return out;
}

const r4 = (v: number) => Math.round(v * 10000) / 10000;

describe('DFS rules (pure)', () => {
  it('I: release periods come only from actual dates or evidence; nothing is invented', () => {
    const d = new Date('2026-05-10T00:00:00Z');
    expect(drawingReleasePeriod(d, 'whatever')).toEqual({ kind: 'DATE', date: d });
    expect(drawingReleasePeriod(null, 'Issued before 01-Jan-2026')).toEqual({ kind: 'BEFORE', year: 2026 });
    expect(drawingReleasePeriod(null, 'Issued 2026 Q1')).toEqual({ kind: 'QUARTER', year: 2026, quarter: 1 });
    expect(drawingReleasePeriod(null, 'Issued in 2025')).toEqual({ kind: 'YEAR', year: 2025 });
    expect(drawingReleasePeriod(null, 'Released per site team')).toEqual({ kind: 'UNKNOWN' });
    expect(drawingReleasePeriod(null, null)).toEqual({ kind: 'UNKNOWN' });
    expect(latestPeriod([{ kind: 'DATE', date: d }, { kind: 'UNKNOWN' }])).toEqual({ kind: 'UNKNOWN' });
    expect(latestPeriod([{ kind: 'BEFORE', year: 2026 }, { kind: 'QUARTER', year: 2026, quarter: 1 }])).toEqual({ kind: 'QUARTER', year: 2026, quarter: 1 });
  });

  it('year / quarter buckets are labelled in full and never turn evidence into a date', () => {
    expect(bucketOfPeriod({ kind: 'DATE', date: new Date('2026-02-15T00:00:00Z') }, 'CY')).toMatchObject({ year: 'Calendar Year 2026', quarter: 1, label: 'Quarter 1' });
    expect(bucketOfPeriod({ kind: 'DATE', date: new Date('2026-02-15T00:00:00Z') }, 'FY')).toMatchObject({ year: 'Financial Year 2025–26', quarter: 4 });
    expect(bucketOfPeriod({ kind: 'DATE', date: new Date('2026-04-01T00:00:00Z') }, 'FY')).toMatchObject({ year: 'Financial Year 2026–27', quarter: 1 });
    expect(bucketOfPeriod({ kind: 'QUARTER', year: 2026, quarter: 1 }, 'FY')).toMatchObject({ year: 'Financial Year 2025–26', quarter: 4 });
    expect(bucketOfPeriod({ kind: 'BEFORE', year: 2026 }, 'CY')).toMatchObject({ key: 'BEFORE-2026', label: 'Before 01-Jan-2026', year: null, quarter: null });
    expect(bucketOfPeriod({ kind: 'YEAR', year: 2025 }, 'CY')).toMatchObject({ year: 'Calendar Year 2025', quarter: null });
    expect(bucketOfPeriod({ kind: 'UNKNOWN' }, 'FY')).toMatchObject({ key: 'UNKNOWN', quarter: null });
  });

  it('unit keys round-trip', () => {
    const k = unitKey('pr_1', NO_PACKAGE, 'MEP');
    expect(parseUnitKey(k)).toEqual({ projectId: 'pr_1', packageKey: NO_PACKAGE, group: 'MEP' });
  });
});

// ---------------------------------------------------------------------------
// W — the base-DFS parser is generic: a new project with another hierarchy
// ---------------------------------------------------------------------------

function sheet(rows: (string | null)[][]): TextSheet {
  return { name: 'Design Fee', hidden: false, rows };
}

describe('W base-DFS WBS parser (generic)', () => {
  // A different project: phases, a tower, villas with a nested type, a block,
  // a repeated code, a heading with no package, and discipline blocks AR / ST.
  const S = sheet([
    [null, 'Project X', null, null, 'AR', 'Fee', 'Billed YTD', 'ST', 'Fee', 'Billed YTD'],
    [null, 'Design Packages', null, null, null, null, null, null, null, null],
    [null, 'Design Fees', null, null, null, '3', '0', null, '1.5', '0'],
    [null, null, null, null],
    [null, 'CONSTRUCTION DOCUMENTS'],
    [null, null, null, 'Phase 1'],
    [null, null, '1', 'GFC | Tower A', null, '1', null, null, '0.5'],
    [null, 'TA-01', '1', 'Foundations', '0.1', '0.4', '0', '0.1', '0.2', '0'],
    [null, 'TA-02', '2', 'Superstructure', '0.1', '0.6', '0', '0.1', '0.3', '0'],
    [null, null, '2', 'GFC | Villas', null, '1', null, null, '0.5'],
    [null, '2.1', '2.1', 'Villa Type X'],
    [null, 'VX-01', '1', 'Villa X — all levels', '0.1', '1', '0', '0.1', '0.5', '0'],
    [null, null, '3', 'GFC | Empty heading', null, '0'],
    [null, null, null, 'Phase 2'],
    [null, null, '1', 'Block 2 — Retail', null, '1'],
    [null, 'RB-01', '1', 'Retail shell', '0.1', '1', '0', '0.1', '0.5', '0'],
    [null, 'TA-01', '1', 'Repeated code', '0.1', '0.1', '0', null, null, null],
  ]);
  const parsed = parseDesignFee({ file: 'x.xlsx', projectCode: 'NEW-PROJECT' }, S, { labelPrefix: '^GFC\\s*\\|\\s*' });
  const byName = new Map(parsed.nodes.map((n) => [n.name, n]));
  const parentName = (name: string) => parsed.nodes.find((n) => n.key === byName.get(name)?.parentKey)?.name ?? null;

  it('builds the tree from the headings, nested by outline, with the source names', () => {
    expect(parsed.nodes.map((n) => [n.type, n.name, parentName(n.name)])).toEqual([
      ['PHASE', 'Phase 1', null],
      ['TOWER', 'Tower A', 'Phase 1'],
      ['VILLA', 'Villas', 'Phase 1'],
      ['VILLA', 'Villa Type X', 'Villas'],
      ['PHASE', 'Phase 2', null],
      ['BLOCK', 'Block 2 — Retail', 'Phase 2'],
    ]);
    expect(byName.get('Tower A')!.sourceLabel).toBe('GFC | Tower A');
  });

  it('puts every package under the heading it sits beneath; headings without packages are not nodes', () => {
    const under = (code: string) => parsed.nodes.find((n) => n.key === parsed.packages.find((p) => p.code === code)!.nodeKey)?.name;
    expect(under('TA-01')).toBe('Tower A');
    expect(under('TA-02')).toBe('Tower A');
    expect(under('VX-01')).toBe('Villa Type X');
    expect(under('RB-01')).toBe('Block 2 — Retail');
    expect(byName.has('Empty heading')).toBe(false);
    expect(parsed.packages.find((p) => p.code === 'TA-01')!.ordinal).toBe(1);
  });

  it('logs a repeated package code instead of merging it', () => {
    expect(parsed.packages.map((p) => p.code)).toEqual(['TA-01', 'TA-02', 'VX-01', 'RB-01']);
    expect(parsed.issues.filter((i) => i.code === 'DUPLICATE_PACKAGE_CODE')).toHaveLength(1);
  });

  it('types headings by rule — manifest rules first, then plain construction words, else GROUP', () => {
    expect(nodeTypeOf('Tower—01')).toBe('TOWER');
    expect(nodeTypeOf('Villas—Cluster 3')).toBe('VILLA');
    expect(nodeTypeOf('Individual Homes')).toBe('PRODUCT');
    expect(nodeTypeOf('Independent Subgrade Structure—Block 04')).toBe('BLOCK');
    expect(nodeTypeOf('Master Plan')).toBe('GROUP');
    expect(nodeTypeOf('Cluster North', [{ pattern: '^cluster', type: 'VILLA' }])).toBe('VILLA');
  });

  it('resolves an unlinked drawing from its heading only when the heading names exactly one package', () => {
    const r = headingResolver(['V40-01', 'V50-01', 'BB02-2', 'BB02-3', 'MP-1', 'T2V-01', 'T2V-02']);
    expect(r(['Individual Home V40', 'ELECTRICAL'])).toEqual({ code: 'V40-01', heading: 'Individual Home V40' });
    expect(r(['BB02-2 Foundations & Grade Slab'])).toEqual({ code: 'BB02-2', heading: 'BB02-2 Foundations & Grade Slab' });
    expect(r(['Tower T2V'])).toMatchObject({ ambiguous: ['T2V-01', 'T2V-02'] });
    expect(r(['Tower - 2V - 6V'])).toEqual({});
    expect(r(['MP drawings'])).toEqual({}); // two-letter tokens are never matched as locations
  });
});

// ---------------------------------------------------------------------------
// Against the imported register
// ---------------------------------------------------------------------------

describe.skipIf(!available)('Design Fee Schedule (DFS) and billing (PoaRR, Violet Hill)', () => {
  let res: Awaited<ReturnType<typeof project>>;
  let t08: Awaited<ReturnType<typeof project>>;
  let fy26Before: Record<string, number>;
  let userNaKey: string | undefined;

  beforeAll(async () => {
    res = await project('POARR-RES');
    t08 = await project('POARR-T08');
    fy26Before = await fy26Counts();
    for (const [role, email] of Object.entries(EMAIL)) {
      if (role === 'ADMIN') continue;
      await db
        .insert(users)
        .values({ id: newId('us_'), name: `Test ${role.toLowerCase()}`, email, role, active: true })
        .onConflictDoUpdate({ target: users.email, set: { role } });
    }
  });

  describe('G hierarchy — from the base DFS', () => {
    it('V40 sits in "Individual Homes" with its sibling products — not a phase, not a batch', async () => {
      const m = await buildDfsModel({ projectId: res.id });
      const homes = rowNamed(m, `P:${res.id}`, 'Individual Homes')!;
      expect(homes.kind).toBe('NODE');
      expect(homes.typeLabel).toBe('Product');
      const pk = kids(m, homes.key);
      expect(pk.map((k) => k.code)).toEqual(['C20-01', 'L30-01', 'L45-01', 'V50-01', 'V40-01', 'R11-01', 'R22-01', 'C20P-01', 'L30P-01', 'L45P-01']);
      const v40 = pk.find((k) => k.code === 'V40-01')!;
      expect(v40.name).toBe("V40 Default and it's variants");
      expect(kids(m, v40.key).map((u) => u.name)).toEqual(expect.arrayContaining(['Architecture', 'Mechanical, Electrical & Plumbing', 'Landscape']));
      expect(rowNamed(m, `P:${res.id}`, 'V40')).toBeUndefined();
      const [v40pkg] = await db.select().from(packages).where(and(eq(packages.projectId, res.id), eq(packages.packageCode, 'V40-01')));
      const [{ n }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(drawings)
        .where(and(eq(drawings.projectId, res.id), sql`${drawings.batchCode} ~ '^MEP-V4[1-5]-'`, eq(drawings.packageId, v40pkg.id)));
      expect(n).toBe(5);
    });

    it('towers, villas and blocks are grouping rows with their own packages; Block rows sit under their group', async () => {
      const m = await buildDfsModel({ projectId: res.id });
      const t1 = rowNamed(m, `P:${res.id}`, 'Tower—01')!;
      expect(t1.typeLabel).toBe('Tower');
      const t1p = kids(m, t1.key);
      expect(t1p.map((k) => k.code)).toEqual(['T01-01', 'T01-02', 'T01-03', 'T01-04', 'T01-05', 'T01-06', 'T01-07', 'T01-08', 'T01-09', 'T01-10']);
      expect(t1p[0].name).toBe('Foundation and Grade Slab');
      const iss = rowNamed(m, `P:${res.id}`, 'Independent Subgrade Structure [Tower 1-7]')!;
      expect(kids(m, iss.key).filter((c) => c.kind === 'NODE').map((c) => [c.typeLabel, c.name])).toEqual([
        ['Block', 'Independent Subgrade Structure—Block 01'],
        ['Block', 'Independent Subgrade Structure—Block 02'],
        ['Block', 'Independent Subgrade Structure—Block 03'],
        ['Block', 'Independent Subgrade Structure—Block 04'],
        ['Block', 'Independent Subgrade Structure—Block 09'],
      ]);
      expect(rowNamed(m, `P:${res.id}`, 'Villas—Cluster 3')!.typeLabel).toBe('Villa');
      expect(kids(m, `P:${res.id}`).filter((r) => r.kind === 'NODE').map((n) => n.name)).toEqual([
        'Tower—01', 'Tower—2V', 'Tower—2S', 'Tower—3V-5V', 'Tower—3S-5S', 'Tower—6V', 'Tower—6S', 'Tower—07',
        'Independent Subgrade Structure [Tower 1-7]', 'Villas—Cluster 1 & 2', 'Villas—Cluster 3', 'Individual Homes', 'Master Plan', 'Amenities & Facilities',
      ]);
    });

    it('Tower 08: its own groups and codes (BB01, BB02, PD, MP, AM); L20-1 holds the L20B drawings', async () => {
      const m = await buildDfsModel({ projectId: t08.id });
      const nodes = kids(m, `P:${t08.id}`).filter((r) => r.kind === 'NODE');
      expect(nodes.map((n) => [n.code, n.name])).toEqual([
        ['BB01', 'Tower—08'],
        ['BB02', 'Independent Subgrade Structure - Tower 8'],
        ['PD', 'Individual Homes'],
        ['MP', 'Master Plan'],
        ['AM', 'Amenities & Facilities'],
      ]);
      expect(kids(m, nodes.find((n) => n.code === 'PD')!.key).map((k) => k.code)).toEqual(['R25-1', 'L20-1', 'D35-1', 'L22-1', 'R25P-1', 'L20P-1', 'D35P-1', 'L22P-1']);
      const [l20] = await db.select().from(packages).where(and(eq(packages.projectId, t08.id), eq(packages.packageCode, 'L20-1')));
      const [{ n }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(drawings)
        .where(and(eq(drawings.projectId, t08.id), sql`${drawings.drawingCode} like '%L20B%'`, eq(drawings.packageId, l20.id)));
      expect(n).toBeGreaterThan(0);
    });

    it('c) package counts are package records only — never towers, disciplines or drawings; no generic batch appears', async () => {
      const m = await buildDfsModel({});
      for (const r of m.rows.values()) {
        if (r.kind === 'PACKAGE') {
          expect(r.name).not.toMatch(/^Batch\b/);
          for (const c of kids(m, r.key)) expect(c.kind).toBe('DISCIPLINE');
        }
        if (r.kind === 'NO_PACKAGE') {
          expect(r.packagesTotal).toBe(0);
          expect(r.status).toBeNull();
        }
        if (r.kind === 'DISCIPLINE') expect(r.packagesTotal).toBe(0);
        if (r.kind === 'NODE') expect(['Architecture', 'Structural', 'Mechanical, Electrical & Plumbing', 'Landscape']).not.toContain(r.name);
      }
      const [{ n }] = await db
        .select({ n: sql<number>`count(distinct ${packages.id})::int` })
        .from(packages)
        // Only packages that hold drawings are counted: a package with none is an empty row (not shown).
        .where(sql`${packages.archivedAt} is null and exists (select 1 from ${drawings} d where d.package_id = ${packages.id} and d.archived_at is null)`);
      const t = modelTotals(m);
      expect(t.packagesTotal + t.packagesNa).toBe(n);
    });

    it('base-DFS headings keep their source traceability (19 Residential / 5 Tower 08)', async () => {
      const rows = await db.select().from(dfsWbsNodes);
      expect(rows.filter((r) => r.projectId === res.id)).toHaveLength(19);
      expect(rows.filter((r) => r.projectId === t08.id)).toHaveLength(5);
      for (const r of rows) {
        expect(r.sourceWorkbook).toMatch(/03YPlan/);
        expect(r.sourceSheet).toBe('Design Fee');
        expect(r.sourceRow).toBeGreaterThan(0);
        expect(r.importBatchId).toBeTruthy();
      }
    });

    it('drawings no package holds are listed apart, not guessed, and every one has an import issue behind it', async () => {
      const m = await buildDfsModel({ projectId: res.id });
      const loose = kids(m, `P:${res.id}`).find((r) => r.kind === 'NO_PACKAGE')!;
      expect(loose.packagesTotal).toBe(0);
      const [batch] = await db.select().from(drawingImportBatches).where(eq(drawingImportBatches.status, 'APPLIED')).orderBy(sql`${drawingImportBatches.startedAt} desc`).limit(1);
      const iss = await db.select().from(drawingImportIssues).where(and(eq(drawingImportIssues.batchId, batch.id), eq(drawingImportIssues.projectCode, 'POARR-RES')));
      const logged = iss.filter((i) => i.code === 'BATCH_WITHOUT_FEE_PACKAGE' || i.code === 'DRAWING_PACKAGE_AMBIGUOUS').reduce((s, i) => s + Number(JSON.parse(i.payload ?? '{}').drawings ?? 0), 0);
      expect(logged).toBe(loose.drawingsTotal);
      expect(iss.filter((i) => i.code === 'BATCH_RESOLVED_BY_DFS_HEADING').length).toBe(5);
    });

    it('every drawing of a project is counted exactly once', async () => {
      for (const p of [res, t08]) {
        const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(drawings).where(eq(drawings.projectId, p.id));
        const m = await buildDfsModel({ projectId: p.id });
        expect(m.rows.get(`P:${p.id}`)!.drawingsTotal).toBe(n);
      }
    });
  });

  describe('d) status rules — binary, from the drawings only', () => {
    it('a package is Complete exactly when it has drawings and every one is released; none yet → Pending', async () => {
      const { packages: pk } = await loadDfs({});
      for (const p of pk.filter((x) => x.packageId)) {
        const all = p.units.reduce((a, u) => ({ d: a.d + u.all.drawings, r: a.r + u.all.released }), { d: 0, r: 0 });
        if (p.status === 'NA') {
          expect(all.d).toBe(0);
          continue;
        }
        expect(p.status).toBe(all.d > 0 && all.r === all.d ? 'COMPLETE' : 'NOT_COMPLETE');
        expect(p.noDrawings).toBe(all.d === 0);
      }
    });

    it('a) Violet Hill: a package whose drawings are all released is never Pending', async () => {
      const vh = await project('VIOLET-HILL');
      const m = await buildDfsModel({ projectId: vh.id });
      const rows = packageRows(m, `P:${vh.id}`);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        if (r.drawingsTotal > 0 && r.drawingsReleased === r.drawingsTotal) expect(r.status).toBe('COMPLETE');
        if (r.drawingsTotal === 0) expect(r.status === 'NOT_COMPLETE' && r.noDrawings).toBe(true);
      }
      // Master Planning drawings count under Architecture (disciplines.dfs_group), with the Architecture fee.
      const [mp] = await db.select().from(disciplines).where(eq(disciplines.code, 'MP'));
      expect(mp.dfsGroup).toBe('AR');
      const top = m.rows.get(`P:${vh.id}`)!;
      expect(top.packagesComplete).toBe(rows.filter((r) => r.drawingsTotal > 0 && r.drawingsReleased === r.drawingsTotal).length);
    });

    it('a discipline row follows the same rule over its own drawings', async () => {
      const m = await buildDfsModel({});
      for (const r of m.rows.values()) {
        if (r.kind !== 'DISCIPLINE' || r.status === 'NA') continue;
        expect(r.status).toBe(r.drawingsTotal > 0 && r.drawingsReleased === r.drawingsTotal ? 'COMPLETE' : 'NOT_COMPLETE');
      }
    });
  });

  describe('b) roll-ups and the DFS Summary', () => {
    it('parent = sum of children at every level (whole view and one project)', async () => {
      expectParentIsSum(await buildDfsModel({}));
      expectParentIsSum(await buildDfsModel({ projectId: res.id }));
      expectParentIsSum(await buildDfsModel({ release: 'NOT_COMPLETED' }));
    });

    it('drawing totals reconcile with the database, released and not released', async () => {
      const m = await buildDfsModel({});
      for (const k of m.roots) {
        const r = m.rows.get(k)!;
        const id = k.slice(2);
        const q = await db.execute(
          sql`select count(*)::int as n, (count(*) filter (where completion_status = 'COMPLETED'))::int as r from drawings where project_id = ${id} or project_id in (select id from projects where parent_project_id = ${id})`,
        );
        const row = q.rows[0] as { n: number; r: number };
        expect(r.drawingsTotal).toBe(row.n);
        expect(r.drawingsReleased).toBe(row.r);
      }
    });

    it('Summary: Packages = Complete + Pending; Unbilled = Total − Billed; billing is the sum of its disciplines', async () => {
      const s = await dfsSummary({});
      for (const b of [...s.projects, s.total]) {
        expect(b.row.packages).toBe(b.row.complete + b.row.pending);
        expect(b.row.total).toBeCloseTo(b.disciplines.reduce((x, d) => x + d.total, 0), 3);
        expect(b.row.billed).toBeCloseTo(b.disciplines.reduce((x, d) => x + d.billed, 0), 3);
        expect(b.row.unbilled).toBeCloseTo(b.row.total - b.row.billed, 3);
        if (b.row.packages) expect(b.row.overall).toBeCloseTo(b.row.complete / b.row.packages, 6);
        expect(b.disciplines.slice(0, 4).map((d) => d.label)).toEqual(['Architecture', 'Structural', 'Mechanical, Electrical & Plumbing', 'Landscape']);
        for (const d of b.disciplines) expect(d.packages).toBe(d.complete + d.pending);
      }
      const t = modelTotals(await buildDfsModel({}));
      expect(s.total.row.packages).toBe(t.packagesTotal);
      expect(s.total.row.complete).toBe(t.packagesComplete);
    });

    it('project Scope per discipline reconciles to the Design Fee sheet (Residential / Tower 08)', async () => {
      const expected: Record<string, Record<string, number>> = {
        'POARR-RES': { AR: 28.7972, ST: 6.6586, MEP: 3.1271, LS: 0.734 },
        'POARR-T08': { AR: 11.445, ST: 3.4042, MEP: 1.0633, LS: 0.1572 },
      };
      for (const p of [res, t08]) {
        const { units } = await loadDfs({ projectId: p.id });
        for (const [g, v] of Object.entries(expected[p.projectCode])) {
          const scope = r4(units.filter((u) => u.group === g).reduce((s2, u) => s2 + (u.scope ?? 0), 0));
          expect(scope).toBeCloseTo(v, 3);
        }
      }
    });

    it('filters change what is counted, never how a package is judged', async () => {
      const all = await loadDfs({ projectId: t08.id });
      const byKey = new Map(all.units.map((u) => [u.key, u]));
      const filtered = await loadDfs({ projectId: t08.id, release: 'NOT_COMPLETED' });
      const shown = filtered.units.filter((u) => u.shown.drawings > 0);
      expect(shown.length).toBeGreaterThan(0);
      for (const u of filtered.units) {
        const whole = byKey.get(u.key)!;
        expect(u.status).toBe(whole.status);
        expect(u.all.drawings).toBe(whole.all.drawings);
        expect(u.shown.drawings).toBeLessThanOrEqual(u.all.drawings);
        expect(u.shown.released).toBe(0);
      }
      const m = await buildDfsModel({ projectId: t08.id, release: 'NOT_COMPLETED' });
      expect(m.rows.get(`P:${t08.id}`)!.drawingsTotal).toBe(all.units.reduce((s2, u) => s2 + u.all.drawings - u.all.released, 0));
      expect(m.rows.get(`P:${t08.id}`)!.drawingsReleased).toBe(0);
    });

    it('search keeps the ancestor rows of what it finds', async () => {
      const m = await buildDfsModel({ search: 'L20B' });
      const hits = [...m.rows.values()].filter((r) => r.kind === 'DISCIPLINE');
      expect(hits.length).toBeGreaterThan(0);
      for (const h of hits) {
        let p = h.parentKey ? m.rows.get(h.parentKey) : undefined;
        while (p && p.parentKey) p = m.rows.get(p.parentKey);
        expect(m.roots).toContain(p!.key);
      }
    });

    it('rowsOf: lazy children, and "Expand to Packages" stops at package rows', async () => {
      const m = await buildDfsModel({});
      const top = rowsOf(m, null);
      expect(top.every((r) => r.depth === 0)).toBe(true);
      const deep = rowsOf(m, null, 'PACKAGE');
      expect(deep.some((r) => r.kind === 'PACKAGE')).toBe(true);
      expect(deep.some((r) => r.kind === 'DISCIPLINE')).toBe(false);
    });
  });

  describe('e) Drawing Control edits show in DFS at once; billing follows completion', () => {
    let target: DfsUnit;
    let drawingId: string;
    let feesBefore: Awaited<ReturnType<typeof feeRows>>;

    beforeAll(async () => {
      const { units } = await loadDfs({});
      for (const u of units.filter((x) => x.status === 'COMPLETE' && (x.scope ?? 0) > 0 && x.packageKey !== NO_PACKAGE && x.all.releasedNoDate < x.all.released)) {
        const d = (await drawingsOfUnit(u.key)).find((x) => x.actualReleaseDate);
        if (d) {
          target = u;
          drawingId = d.id;
          break;
        }
      }
      expect(target).toBeDefined();
      feesBefore = await feeRows();
    });

    it('complete unit: Billed = Total', () => {
      expect(target.status).toBe('COMPLETE');
      expect(target.actual).toBe(target.scope);
    });

    it('withdrawing one release makes the package Pending at once; releasing it again completes it', async () => {
      const [d] = await db.select().from(drawings).where(eq(drawings.id, drawingId));
      const actualDate = d.actualReleaseDate!;
      const baseline = d.baselineReleaseDate;
      await unreleaseDrawing(drawingId, 'DFS test: withdraw', admin);
      const u = await unitOf(target.key);
      expect(u.status).toBe('NOT_COMPLETE');
      expect(u.actual).toBe(0);
      expect(u.scope).toBe(target.scope);
      expect(u.all.drawings - u.all.released).toBe(1);
      const m = await buildDfsModel({ projectId: target.projectId });
      expect(m.rows.get(`K:${target.projectId}|${target.packageKey}`)!.status).toBe('NOT_COMPLETE');

      await releaseDrawing(drawingId, { actualReleaseDate: actualDate, remarks: 'DFS test: re-release' }, editor);
      const again = await unitOf(target.key);
      expect(again.status).toBe('COMPLETE');
      expect(again.actual).toBe(target.scope);
      const [after] = await db.select().from(drawings).where(eq(drawings.id, drawingId));
      expect(after.baselineReleaseDate?.toISOString() ?? null).toBe(baseline?.toISOString() ?? null);
    });

    it('releasing every drawing of an open package completes it and bills its Total', async () => {
      const { units } = await loadDfs({ projectId: t08.id });
      const open = units.find((x) => x.status === 'NOT_COMPLETE' && (x.scope ?? 0) > 0 && x.all.drawings > 0 && x.all.drawings - x.all.released <= 3 && x.packageKey !== NO_PACKAGE);
      expect(open).toBeDefined();
      const ds = (await drawingsOfUnit(open!.key)).filter((d) => d.completionStatus !== 'COMPLETED');
      for (let i = 0; i < ds.length; i++) {
        await releaseDrawing(ds[i].id, { actualReleaseDate: startOfDay(new Date()) }, editor);
        const mid = await unitOf(open!.key);
        if (i < ds.length - 1) {
          expect(mid.status).toBe('NOT_COMPLETE');
          expect(mid.actual).toBe(0);
        }
      }
      const done = await unitOf(open!.key);
      expect(done.status).toBe('COMPLETE');
      expect(done.actual).toBe(open!.scope);
    });

    it('completion never writes to the fee rows', async () => {
      const after = await feeRows();
      expect(after.map((f) => [f.id, f.feeValue, f.feePercent, f.billedToDateValue, f.applicability])).toEqual(
        feesBefore.map((f) => [f.id, f.feeValue, f.feePercent, f.billedToDateValue, f.applicability]),
      );
    });

    it('source billing never marks a package complete', async () => {
      const { units } = await loadDfs({});
      for (const u of units.filter((x) => x.flags.includes('BILLED_BEFORE_COMPLETION'))) {
        expect(u.status).toBe('NOT_COMPLETE');
        expect(u.actual).toBe(0);
      }
    });
  });

  describe('Not Applicable only when explicitly set', () => {
    let pkgId: string;
    let key: string;
    beforeAll(async () => {
      const { units } = await loadDfs({});
      const u = units.find((x) => x.status === 'NOT_COMPLETE' && x.all.drawings === 0 && (x.scope ?? 0) > 0 && x.packageId && ['AR', 'ST', 'MEP', 'LS'].includes(x.group))!;
      pkgId = u.packageId!;
      key = u.key;
    });

    it('a fee line with no drawings is Pending (flagged, no text on screen)', async () => {
      const u = await unitOf(key);
      expect(u.status).toBe('NOT_COMPLETE');
      expect(u.flags).toContain('NO_DRAWINGS');
      expect(u.actual).toBe(0);
    });

    it('marking it Not Applicable is audited and removes its fee from billing', async () => {
      const { group } = parseUnitKey(key)!;
      await setUnitApplicability({ packageId: pkgId, discipline: group, applicability: 'NA', reason: 'DFS test: not in scope' }, admin);
      const u = await unitOf(key);
      expect(u.status).toBe('NA');
      expect(u.scope).toBeNull();
      const audit = await db.execute(sql`select count(*)::int as n from audit_log where entity_type = 'PACKAGE' and entity_id = ${pkgId} and field = ${`applicability.${group}`}`);
      expect(Number((audit.rows[0] as { n: number }).n)).toBeGreaterThan(0);
      await setUnitApplicability({ packageId: pkgId, discipline: group, applicability: 'APPLICABLE', reason: 'DFS test: back in scope' }, admin);
      expect((await unitOf(key)).status).toBe('NOT_COMPLETE');
      await setUnitApplicability({ packageId: pkgId, discipline: group, applicability: 'NA', reason: 'DFS test: not in scope' }, admin);
      userNaKey = key;
    });
  });

  describe('Release without a date', () => {
    it('a released drawing with no date is Released, keeps the date empty and keeps its evidence for the detail panel', async () => {
      const [d] = await db
        .select()
        .from(drawings)
        .where(and(eq(drawings.projectId, res.id), eq(drawings.completionStatus, 'COMPLETED'), isNull(drawings.actualReleaseDate), isNotNull(drawings.releaseEvidence), isNotNull(drawings.packageId)))
        .limit(1);
      expect(d).toBeDefined();
      const { units } = await loadDfs({ projectId: res.id });
      // The discipline row that holds this drawing.
      let u: DfsUnit | undefined;
      let row: Awaited<ReturnType<typeof drawingsOfUnit>>[number] | undefined;
      for (const x of units.filter((y) => y.packageKey === d.packageId && y.all.releasedNoDate > 0)) {
        row = (await drawingsOfUnit(x.key)).find((r) => r.id === d.id);
        if (row) {
          u = x;
          break;
        }
      }
      expect(u!.releaseDate).toBeNull();
      if (!row) throw new Error('drawing not found in its discipline row');
      expect(row.completionStatus).toBe('COMPLETED');
      expect(row.actualReleaseDate).toBeNull();
      expect(row.releaseEvidence).toBe(d.releaseEvidence);
    });

    it('period reporting uses evidence buckets, not invented quarter dates', async () => {
      const p = await dfsPeriods({ projectId: res.id }, 'CY');
      expect(p.columns.some((c) => c.key === 'BEFORE-2026')).toBe(true);
      const { units, packages: pk } = await loadDfs({ projectId: res.id });
      const real = new Set(pk.filter((x) => x.packageId).map((x) => x.key));
      const applicable = units.filter((u) => u.status !== 'NA' && real.has(`${u.projectId}|${u.packageKey}`));
      expect(p.total.totals.planned).toBe(applicable.length);
      expect(p.total.totals.completed).toBe(applicable.filter((u) => u.status === 'COMPLETE').length);
      const fy = await dfsPeriods({ projectId: res.id }, 'FY');
      expect(fy.total.totals).toEqual(p.total.totals);
      expect(fy.columns.filter((c) => c.year).every((c) => /^Financial Year \d{4}–\d{2}$/.test(c.year!))).toBe(true);
    });
  });

  describe('Reschedule through the engine', () => {
    it('moves the plan; baseline, status and fee unchanged', async () => {
      const { units } = await loadDfs({ projectId: t08.id });
      const u = units.find((x) => x.status === 'NOT_COMPLETE' && x.all.drawings > x.all.released && x.all.latestExpected && x.packageKey !== NO_PACKAGE)!;
      const d = (await drawingsOfUnit(u.key)).find((r) => r.completionStatus !== 'COMPLETED' && r.currentExpectedReleaseDate)!;
      const [before] = await db.select().from(drawings).where(eq(drawings.id, d.id));
      const target = addDays(startOfDay(u.all.latestExpected!), 45);
      const r = await applyReschedule({ entityType: 'DRAWING', entityIds: [d.id], newExpectedDate: target, reason: 'DFS test: re-plan', scope: 'ITEM' }, editor);
      expect(r.applied).toBe(1);
      const [after] = await db.select().from(drawings).where(eq(drawings.id, d.id));
      expect(after.baselineReleaseDate?.toISOString() ?? null).toBe(before.baselineReleaseDate?.toISOString() ?? null);
      expect(after.currentExpectedReleaseDate?.toISOString()).toBe(target.toISOString());
      const moved = await unitOf(u.key);
      expect(moved.all.latestExpected?.toISOString()).toBe(target.toISOString());
      expect(moved.status).toBe('NOT_COMPLETE');
      expect(moved.scope).toBe(u.scope);
    });
  });

  describe('Drawing Control package assignment', () => {
    it('rejects a package from another project', async () => {
      const [d] = await db.select().from(drawings).where(eq(drawings.projectId, t08.id)).limit(1);
      const [other] = await db.select().from(packages).where(eq(packages.projectId, res.id)).limit(1);
      await expect(updateDrawing(d.id, { packageId: other.id }, editor, 'wrong project')).rejects.toBeInstanceOf(DrawingRuleError);
    });
  });

  describe('Import protection', () => {
    it('a re-import keeps a user-set package and an explicit Not Applicable, and the same hierarchy rows', async () => {
      const { units } = await loadDfs({ projectId: t08.id });
      const naKey = userNaKey ?? units.find((u) => u.status === 'NA' && u.packageId)!.key;
      const fromUnit = units.find((u) => u.packageKey !== NO_PACKAGE && u.all.drawings > 1 && u.group === 'AR')!;
      const [d] = await drawingsOfUnit(fromUnit.key);
      const pk = await db.select().from(packages).where(and(eq(packages.projectId, t08.id), isNotNull(packages.sourceWorkbook)));
      const newPkg = pk.find((p) => p.id !== fromUnit.packageId)!.id;
      await updateDrawing(d.id, { packageId: newPkg }, editor, 'DFS test: re-package');
      const nodesBefore = (await db.select().from(dfsWbsNodes)).map((n) => [n.id, n.nodeKey, n.parentId]).sort();
      const pkgNodesBefore = (await db.select({ id: packages.id, w: packages.wbsNodeId }).from(packages)).sort((a, b) => a.id.localeCompare(b.id));

      const r = await runDrawingImport({ manifestPath: MANIFEST, apply: true, actor: admin });
      expect(r.mode).toBe('APPLIED');
      const [after] = await db.select().from(drawings).where(eq(drawings.id, d.id));
      expect(after.packageId).toBe(newPkg);
      expect(after.userEditedFields).toMatch(/packageId/);
      expect((await unitOf(naKey)).status).toBe('NA');
      expect((await db.select().from(dfsWbsNodes)).map((n) => [n.id, n.nodeKey, n.parentId]).sort()).toEqual(nodesBefore);
      expect((await db.select({ id: packages.id, w: packages.wbsNodeId }).from(packages)).sort((a, b) => a.id.localeCompare(b.id))).toEqual(pkgNodesBefore);
    }, 300_000);
  });

  describe('Permissions', () => {
    it('Viewer reads the rows and a discipline row’s drawings; the Summary and Year / Quarter (billing) need billing permission', async () => {
      const rows = await dfsRoute.GET(req('VIEWER', `/api/dfs?projectId=${t08.id}`));
      expect(rows.status).toBe(200);
      const body = (await rows.json()) as { rows: DfsRow[] };
      expect(body.rows).toHaveLength(1);
      expect(body.rows[0].kind).toBe('PROJECT');
      expect((await dfsRoute.GET(req('VIEWER', `/api/dfs?view=periods&basis=FY&projectId=${t08.id}`))).status).toBe(403);
      expect((await dfsRoute.GET(req('VIEWER', `/api/dfs?view=summary&projectId=${t08.id}`))).status).toBe(403);
      expect((await dfsRoute.GET(req('MANAGER', `/api/dfs?view=periods&basis=FY&projectId=${t08.id}`))).status).toBe(200);
      const sum = await dfsRoute.GET(req('MANAGER', `/api/dfs?view=summary&projectId=${t08.id}`));
      expect(sum.status).toBe(200);
      expect(((await sum.json()) as { projects: unknown[] }).projects).toHaveLength(1);
      const { units } = await loadDfs({ projectId: t08.id });
      const u = units.find((x) => x.all.drawings > 0)!;
      const r = await unitDrawingsRoute.GET(req('VIEWER', `/api/dfs/unit-drawings?key=${encodeURIComponent(u.key)}`));
      expect(r.status).toBe(200);
      expect(((await r.json()) as { total: number }).total).toBe(u.all.drawings);
    });

    it('only Admin may change Not Applicable; Viewer / Editor / Manager get 403', async () => {
      const [pk] = await db.select().from(packages).where(and(eq(packages.projectId, t08.id), isNotNull(packages.sourceWorkbook))).limit(1);
      const body = { packageId: pk.id, discipline: 'LS', applicability: 'APPLICABLE', reason: 'permission probe' };
      for (const role of ['VIEWER', 'EDITOR', 'MANAGER'] as const) {
        expect((await applicabilityRoute.POST(req(role, '/api/dfs/applicability', 'POST', body))).status).toBe(403);
      }
      expect((await applicabilityRoute.POST(req('ADMIN', '/api/dfs/applicability', 'POST', body))).status).toBe(200);
      expect((await applicabilityRoute.POST(req('ADMIN', '/api/dfs/applicability', 'POST', { ...body, discipline: 'XX' }))).status).toBe(422);
    });

    it('an unknown user is a Viewer: can read DFS, cannot change it', async () => {
      const h = { 'x-user-email': 'dfs-unknown@nowhere.test', 'content-type': 'application/json' };
      expect((await dfsRoute.GET(new Request('http://test.local/api/dfs', { headers: h }))).status).toBe(200);
      const [pk] = await db.select().from(packages).limit(1);
      const post = new Request('http://test.local/api/dfs/applicability', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ packageId: pk.id, discipline: 'AR', applicability: 'NA', reason: 'probe' }),
      });
      expect((await applicabilityRoute.POST(post)).status).toBe(403);
    });
  });

  describe('No Design Goals regression', () => {
    it('migrations 0003–0007 never touch the Design Goals tables and never drop or rename', () => {
      for (const f of ['0003_fearless_praxagora.sql', '0004_silent_red_ghost.sql', '0005_redundant_james_howlett.sql', '0006_wording.sql', '0007_wording.sql']) {
        const t = fs.readFileSync(path.resolve(process.cwd(), 'drizzle', f), 'utf8');
        expect(t).not.toMatch(/fy26|DROP |RENAME/i);
      }
      const t5 = fs.readFileSync(path.resolve(process.cwd(), 'drizzle/0005_redundant_james_howlett.sql'), 'utf8');
      for (const s2 of t5.split('--> statement-breakpoint').map((x) => x.trim()).filter(Boolean)) expect(s2).toMatch(/^(CREATE TABLE|ALTER TABLE "[a-z_]+" ADD (COLUMN|CONSTRAINT)|CREATE (UNIQUE )?INDEX)/);
      const t6 = fs.readFileSync(path.resolve(process.cwd(), 'drizzle/0006_wording.sql'), 'utf8').replace(/--.*$/gm, '').trim();
      expect(t6).toMatch(/^UPDATE "import_issues" SET "message"/);
    });

    it('DFS work leaves every Design Goals table untouched', async () => {
      expect(await fy26Counts()).toEqual(fy26Before);
    });
  });
});
