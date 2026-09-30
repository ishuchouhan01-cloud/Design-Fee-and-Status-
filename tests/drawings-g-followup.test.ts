/**
 * Follow-up fixes: the project heading (PoRR), "Updated On" from the source,
 * and formula text never becoming a value. Runs after drawings-a..f (the PoaRR
 * and Violet Hill registers, the Project List and Drawing Control edits are in
 * place).
 *
 *   C cells: formula evaluation, dates on any time zone
 *   U "Updated On": source date / period / "—" / edits only
 *   H hierarchy: real projects on top, towers below, sums, options
 *   S scan: no "=…" value in the database or the API
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { drawingImportBatches, drawings, projects } from '@/db/schema';
import { evaluateFormula, resolveSheet, serialToDate, type RawCell } from '@/lib/import/cells';
import { readTextWorkbook } from '@/lib/import/drawing-register/read';
import { runDrawingImport } from '@/lib/import/drawing-register';
import { buildDfsModel, loadDfs, modelTotals, type DfsModel, type DfsRow } from '@/lib/services/dfs';
import { drawingWhere, listDrawings, projectOptions } from '@/lib/services/drawing-register';
import { updateDrawing } from '@/lib/services/drawing-control';
import { sourceDating, updatedOnText } from '@/lib/updated-on';
import * as dfsRoute from '@/app/api/dfs/route';
import * as unitDrawingsRoute from '@/app/api/dfs/unit-drawings/route';
import * as drawingsRoute from '@/app/api/drawings/route';

const PORR_MANIFEST = path.resolve(process.cwd(), 'data/drawing-sources/poarr.json');
const VH_MANIFEST = 'data/drawing-sources/violet-hill.json';
const available = fs.existsSync(PORR_MANIFEST);
const editor = { id: null, label: 'Follow-up tester (EDITOR)' };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-followup-'));

function req(url: string) {
  return new Request(`http://test.local${url}`, { headers: { 'x-user-email': 'admin@company.local' } });
}
async function project(code: string) {
  const [p] = await db.select().from(projects).where(eq(projects.projectCode, code)).limit(1);
  return p;
}
const kids = (m: DfsModel, key: string) => (m.children.get(key) ?? []).map((k) => m.rows.get(k)!);

// ---------------------------------------------------------------------------
describe('C  Cells: formulas and dates', () => {
  const cellsOf = (grid: Record<string, RawCell>) => {
    const list = Object.entries(grid).map(([a1, cell]) => ({ ...XLSX.utils.decode_cell(a1), cell }));
    const get = (r: number, c: number) => grid[XLSX.utils.encode_cell({ r, c })];
    return { list, get };
  };

  it('works out CONCATENATE / & / TEXT from the referenced cells', () => {
    const v = { B2: 'MP', C2: 'CO', D2: 7 } as Record<string, string | number>;
    expect(evaluateFormula('=CONCATENATE(B2,"-",C2,"-",TEXT(D2,"0000"))', (a) => v[a] ?? null)).toBe('MP-CO-0007');
    expect(evaluateFormula('=B2&"-"&C2', (a) => v[a] ?? null)).toBe('MP-CO');
    expect(() => evaluateFormula('=VLOOKUP(B2,Sheet2!A:B,2,0)', () => null)).toThrow();
  });

  it('a cached value is used; formula text in a Text cell is worked out; what cannot be worked out is empty and reported', () => {
    const { list, get } = cellsOf({
      B2: { t: 's', v: 'MP' },
      C2: { t: 's', v: 'CO' },
      D2: { t: 's', v: '0001' },
      A2: { t: 's', v: '=CONCATENATE(B2,"-",C2,"-",D2)' }, // typed into a Text cell: no cached value
      A3: { t: 's', v: 'MP-CO-0002', f: 'CONCATENATE(B3,"-",C3)' }, // cached value
      A4: { t: 's', v: '=VLOOKUP(B2,Other!A:B,2,0)' },
      A5: { t: 'e', v: 7 },
    });
    const { values, issues } = resolveSheet('Drawing list', list, get);
    expect(values.get('1:0')).toBe('MP-CO-0001');
    expect(values.get('2:0')).toBe('MP-CO-0002');
    expect(values.get('3:0')).toBeNull();
    expect(values.get('4:0')).toBeNull();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ sheet: 'Drawing list', row: 4, col: 0 });
    for (const x of values.values()) expect(typeof x === 'string' && x.startsWith('=')).toBe(false);
  });

  it('a workbook read never gives "=…" as a value, and the reader reports what it could not work out', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Drawing number', 'Discipline', 'Code', 'Seq'],
      ['=CONCATENATE(B2,"-",C2,"-",D2)', 'MP', 'CO', '0001'],
      ['=INDIRECT("A1")', 'MP', 'CO', '0002'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Drawing list');
    const f = path.join(TMP, 'formula-text.xlsx');
    XLSX.writeFile(wb, f);
    const [s] = readTextWorkbook(f);
    expect(s.rows[1][0]).toBe('MP-CO-0001');
    expect(s.rows[2][0]).toBeNull();
    expect(s.formulaIssues?.length).toBe(1);
  });

  it('a date cell is the date typed in it on every time zone (17-Aug-2026 stays 17-Aug-2026 in India)', () => {
    const serial = 46251; // 17-Aug-2026
    expect(serialToDate(serial)!.toISOString().slice(0, 10)).toBe('2026-08-17');
    const ws: XLSX.WorkSheet = { A1: { t: 's', v: 'Date of release' }, A2: { t: 'n', v: serial, z: 'dd-mmm-yyyy' }, '!ref': 'A1:A2' };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const f = path.join(TMP, 'date.xlsx');
    XLSX.writeFile(wb, f);
    const tsx = path.resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
    const code = `import { readTextWorkbook } from '../src/lib/import/drawing-register/read'; import { readWorkbook, date } from '../src/lib/import/workbook'; const [s] = readTextWorkbook(${JSON.stringify(f)}); const w = readWorkbook(${JSON.stringify(f)}); console.log(s.rows[1][0] + ' ' + date(w.sheets[0].rows[1][0])!.toISOString().slice(0, 10));`;
    const script = path.join(process.cwd(), 'scripts', `.tz-check-${process.pid}.ts`);
    fs.writeFileSync(script, code);
    try {
      for (const tz of ['Asia/Kolkata', 'UTC', 'America/New_York']) {
        const r = spawnSync(process.execPath, [tsx, script], { env: { ...process.env, TZ: tz }, encoding: 'utf8', cwd: process.cwd() });
        expect(r.stdout.trim(), `${tz}: ${r.stderr}`).toBe('2026-08-17 2026-08-17');
      }
    } finally {
      fs.rmSync(script, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
describe('U  "Updated On"', () => {
  it('source date → the date; period → as the source gives it; neither → "—"; an edit → its date and time', () => {
    expect(updatedOnText(sourceDating(new Date(Date.UTC(2026, 7, 17)), 'Issued 2026 Q2'))).toBe('17-Aug-2026');
    expect(updatedOnText(sourceDating(null, 'Issued 2026 Q2'))).toBe('Quarter 2, 2026');
    expect(updatedOnText(sourceDating(null, 'Issued in 2025'))).toBe('2025');
    expect(updatedOnText(sourceDating(null, 'Issued before 01-Jan-2026'))).toBe('Before 01-Jan-2026');
    expect(updatedOnText(sourceDating(null, null))).toBe('—');
    expect(updatedOnText(sourceDating(null, null, new Date(Date.UTC(2026, 1, 3))))).toBe('03-Feb-2026');
    expect(updatedOnText({ ...sourceDating(null, 'Issued 2026 Q2'), editedAt: new Date(Date.UTC(2026, 8, 30, 10, 5)) })).toBe('30-Sep-2026 15:35'); // India time
    const q = sourceDating(null, 'Issued 2026 Q2');
    expect(q.sourcePeriodStart!.toISOString().slice(0, 10)).toBe('2026-04-01');
    expect(q.sourcePeriodEnd!.toISOString().slice(0, 10)).toBe('2026-06-30');
  });

  describe.skipIf(!available)('on the imported registers', () => {
    it('an import never gives a drawing the time it ran: every date is the source date or period', async () => {
      const batches = await db.select({ at: drawingImportBatches.startedAt }).from(drawingImportBatches);
      const days = new Set(batches.map((b) => b.at?.toISOString().slice(0, 10)));
      const [x] = await db
        .select({
          editedByImport: sql<number>`(count(*) filter (where ${drawings.editedAt} is not null and ${drawings.userEditedFields} = ''))::int`,
          sourceNotFromSource: sql<number>`(count(*) filter (where ${drawings.sourceDate} is not null and ${drawings.completionStatus} = 'COMPLETED' and ${drawings.releasedById} is null and position('actualReleaseDate' in ${drawings.userEditedFields}) = 0 and ${drawings.sourceDate} is distinct from ${drawings.actualReleaseDate}))::int`,
          withDate: sql<number>`count(${drawings.sourceDate})::int`,
          withPeriod: sql<number>`count(${drawings.sourcePeriodLabel})::int`,
        })
        .from(drawings)
        .where(eq(drawings.isManual, false));
      expect(x.editedByImport).toBe(0);
      expect(x.sourceNotFromSource).toBe(0);
      expect(x.withDate).toBeGreaterThan(0);
      expect(x.withPeriod).toBeGreaterThan(0);
      // No source date on a day an import ran unless a released drawing's source says so.
      const onImportDays = await db
        .select({ d: drawings.sourceDate })
        .from(drawings)
        .where(and(isNotNull(drawings.sourceDate), isNull(drawings.actualReleaseDate)));
      expect(onImportDays.filter((r) => days.has(r.d!.toISOString().slice(0, 10)))).toHaveLength(0);
    });

    it('a drawing whose source gives neither a date nor a period shows "—"', async () => {
      const [d] = await db
        .select()
        .from(drawings)
        .where(and(isNull(drawings.editedAt), isNull(drawings.sourceDate), isNull(drawings.sourcePeriodLabel)))
        .limit(1);
      expect(d).toBeDefined();
      expect(updatedOnText(d)).toBe('—');
    });

    it('a Drawing Control edit sets only the edit time; the source date / period stay; an import keeps the edit time', async () => {
      const [d] = await db
        .select()
        .from(drawings)
        .innerJoin(projects, eq(drawings.projectId, projects.id))
        .where(and(eq(projects.projectCode, 'VIOLET-HILL'), isNull(drawings.editedAt), isNotNull(drawings.sourceDate)))
        .limit(1);
      const before = d.drawings;
      const t0 = Date.now();
      await updateDrawing(before.id, { remarks: 'Follow-up test: Updated On' }, editor);
      const [after] = await db.select().from(drawings).where(eq(drawings.id, before.id));
      expect(after.editedAt!.getTime()).toBeGreaterThanOrEqual(t0 - 1000);
      expect(after.sourceDate?.getTime()).toBe(before.sourceDate?.getTime());
      expect(after.sourcePeriodLabel).toBe(before.sourcePeriodLabel);
      expect(updatedOnText(after)).toMatch(/^\d{2}-[A-Z][a-z]{2}-\d{4} \d{2}:\d{2}$/);
      await runDrawingImport({ apply: true, manifestPath: VH_MANIFEST, actor: { id: null, label: 'Follow-up import' } });
      const [again] = await db.select().from(drawings).where(eq(drawings.id, before.id));
      expect(again.editedAt?.getTime()).toBe(after.editedAt!.getTime());
      expect(again.sourceDate?.getTime()).toBe(before.sourceDate?.getTime());
    });

    it('the source date wins over an actual date an earlier import stored wrongly (one day early)', async () => {
      const [d] = await db
        .select({ id: drawings.id, actual: drawings.actualReleaseDate })
        .from(drawings)
        .innerJoin(projects, eq(drawings.projectId, projects.id))
        .where(and(eq(projects.projectCode, 'VIOLET-HILL'), isNull(drawings.editedAt), isNull(drawings.releasedById), isNotNull(drawings.actualReleaseDate)))
        .limit(1);
      const wrong = new Date(d.actual!.getTime() - 86_400_000);
      await db.update(drawings).set({ actualReleaseDate: wrong, sourceDate: wrong }).where(eq(drawings.id, d.id));
      await runDrawingImport({ apply: true, manifestPath: VH_MANIFEST, actor: { id: null, label: 'Follow-up import' } });
      const [fixed] = await db.select().from(drawings).where(eq(drawings.id, d.id));
      expect(fixed.actualReleaseDate!.getTime()).toBe(d.actual!.getTime());
      expect(fixed.sourceDate!.getTime()).toBe(d.actual!.getTime());
      expect(fixed.editedAt).toBeNull();
    });

    it('the Drawing list sorts and filters by Updated On', async () => {
      const desc = await listDrawings({ sort: 'updated', dir: 'desc', pageSize: 20 });
      const keys = desc.rows.map((r) => r.updatedOn?.getTime() ?? -Infinity);
      expect([...keys].sort((a, b) => b - a)).toEqual(keys);
      const q = await listDrawings({ dateField: 'updated', dateFrom: new Date(Date.UTC(2026, 3, 1)), dateTo: new Date(Date.UTC(2026, 5, 30)), pageSize: 500 });
      expect(q.total).toBeGreaterThan(0);
      for (const r of q.rows) {
        const text = updatedOnText(r);
        expect(text).toMatch(/2026/);
      }
    });
  });
});

// ---------------------------------------------------------------------------
describe.skipIf(!available)('H  Project heading and towers', () => {
  let porr: typeof projects.$inferSelect;
  beforeAll(async () => {
    porr = await project('PORR');
  });

  it('the drawing import itself gives the hierarchy (from the manifest), whatever else was run', async () => {
    expect(porr.displayName).toBe('Pursuit of a Radical Rhapsody');
    for (const [code, name] of [['POARR-RES', 'Residential'], ['POARR-T08', 'Tower 08'], ['POARR-T09', 'Tower 09']]) {
      const p = await project(code);
      expect(p.parentProjectId).toBe(porr.id);
      expect(p.displayName).toBe(name);
    }
    expect((await project('VIOLET-HILL')).displayName).toBe('Violet Hill');
  });

  it('top rows are the real projects; PoRR is the sum of its towers; the header is unchanged', async () => {
    const m = await buildDfsModel({});
    const top = m.roots.map((k) => m.rows.get(k)!);
    expect(top.map((r) => r.name)).toEqual(expect.arrayContaining(['Pursuit of a Radical Rhapsody', 'Violet Hill']));
    for (const r of top) expect(r.name).not.toMatch(/^(PoaRR-|POARR|T0\d)/);
    const p = top.find((r) => r.name === 'Pursuit of a Radical Rhapsody')!;
    const towers = kids(m, p.key);
    expect(towers.map((t) => t.name)).toEqual(['Residential', 'Tower 08', 'Tower 09']);
    const sum = (f: keyof DfsRow) => towers.reduce((s, t) => s + (t[f] as number), 0);
    for (const f of ['packagesComplete', 'packagesTotal', 'drawingsReleased', 'drawingsTotal'] as const) expect(p[f]).toBe(sum(f));
    const t = modelTotals(m);
    expect(t.drawingsTotal).toBe(top.reduce((s, r) => s + r.drawingsTotal, 0));
    expect(t.packagesTotal).toBe(top.reduce((s, r) => s + r.packagesTotal, 0));
  });

  it('filtered to Tower 08, PoRR stays the heading with the same totals as Tower 08', async () => {
    const t08 = await project('POARR-T08');
    const m = await buildDfsModel({ projectId: t08.id });
    expect(m.roots).toEqual([`P:${porr.id}`]);
    const head = m.rows.get(`P:${porr.id}`)!;
    const [tower] = kids(m, head.key);
    expect(tower.name).toBe('Tower 08');
    expect(head.drawingsTotal).toBe(tower.drawingsTotal);
    expect(head.packagesTotal).toBe(tower.packagesTotal);
    const { units } = await loadDfs({ projectId: t08.id });
    expect(tower.drawingsTotal).toBe(units.reduce((s, u) => s + u.all.drawings, 0));
  });

  it('project options: the real projects, with the towers as sub-options; choosing PoRR includes its towers', async () => {
    const opts = await projectOptions();
    const i = opts.findIndex((o) => o.value === porr.id);
    expect(opts[i]).toMatchObject({ depth: 0, label: 'Pursuit of a Radical Rhapsody', leaf: false });
    expect(opts.slice(i + 1, i + 4).map((o) => [o.depth, o.label.trim(), o.path])).toEqual([
      [1, 'Residential', 'Pursuit of a Radical Rhapsody › Residential'],
      [1, 'Tower 08', 'Pursuit of a Radical Rhapsody › Tower 08'],
      [1, 'Tower 09', 'Pursuit of a Radical Rhapsody › Tower 09'],
    ]);
    expect(opts.filter((o) => o.depth === 0).map((o) => o.label)).toEqual(expect.arrayContaining(['Pursuit of a Radical Rhapsody', 'Violet Hill']));
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(drawings).where(drawingWhere({ projectId: porr.id }));
    const [{ m }] = await db
      .select({ m: sql<number>`count(*)::int` })
      .from(drawings)
      .innerJoin(projects, eq(drawings.projectId, projects.id))
      .where(eq(projects.parentProjectId, porr.id));
    expect(n).toBe(m);
    expect(n).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe('S  No formula text anywhere', () => {
  it('no text column of the DFS tables holds a value starting with "="', async () => {
    const cols: [string, string][] = [
      ['drawings', 'drawing_code'],
      ['drawings', 'drawing_number'],
      ['drawings', 'drawing_name'],
      ['drawings', 'partial_number'],
      ['drawings', 'revision'],
      ['drawings', 'batch_code'],
      ['drawings', 'batch'],
      ['drawings', 'location'],
      ['drawings', 'area_of_works'],
      ['drawing_revisions', 'revision'],
      ['packages', 'package_code'],
      ['packages', 'package_name'],
      ['projects', 'project_code'],
      ['projects', 'project_name'],
      ['projects', 'display_name'],
      ['dfs_wbs_nodes', 'name'],
    ];
    for (const [t, c] of cols) {
      const r = await db.execute(sql.raw(`select count(*)::int as n from ${t} where ${c} ~ '^\\s*=[A-Za-z(]'`));
      expect((r.rows[0] as { n: number }).n, `${t}.${c}`).toBe(0);
    }
  });

  it.skipIf(!available)('no API response carries "=…" as a value', async () => {
    const bodies: string[] = [];
    const top = await dfsRoute.GET(req('/api/dfs?expand=packages'));
    bodies.push(await top.text());
    const m = await buildDfsModel({});
    const units = [...m.rows.values()].filter((r) => r.unitKey).slice(0, 40);
    for (const u of units) bodies.push(await (await unitDrawingsRoute.GET(req(`/api/dfs/unit-drawings?key=${encodeURIComponent(u.unitKey!)}&pageSize=200`))).text());
    bodies.push(await (await drawingsRoute.GET(req('/api/drawings?pageSize=500'))).text());
    for (const b of bodies) expect(b).not.toMatch(/":"\s*=[A-Za-z(]/);
  });
});
