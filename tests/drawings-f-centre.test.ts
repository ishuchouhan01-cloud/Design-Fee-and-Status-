/**
 * Import Centre and the project hierarchy — runs after drawings-a..e.
 *
 *   Project List      full names; PoRR above Residential / Tower 08 / Tower 09,
 *                     re-parented in place (same ids), totals reconcile
 *   Violet Hill       its 03-Year Plan through the Import Centre, no duplicates
 *   Synthetic         a workbook of another shape, a new project, no code
 *                     changes: dry run → commit → idempotent re-run → undo
 *   Autodesk Construction Cloud export: releases, then undo
 *   Upload rules, templates, permissions
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db';
import { dfsWbsNodes, drawings, packages, projects, users } from '@/db/schema';
import { importHistory, inspectWorkbook, runCentreImport, savedMapping, templateWorkbook, undoImport, validateUpload, CENTRE_FILE_TYPES } from '@/lib/import/centre';
import { loadManifest } from '@/lib/import/drawing-register';
import { newId } from '@/lib/ids';
import { buildDfsModel, dfsRootProjects, type DfsModel, type DfsRow } from '@/lib/services/dfs';
import { updateDrawing } from '@/lib/services/drawing-control';
import * as historyRoute from '@/app/api/import-centre/history/route';

const admin = { id: null, label: 'Import Centre tester (Administrator)' };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-centre-'));
const PORR = path.resolve(process.cwd(), 'data/drawing-sources/poarr.json');
const available = fs.existsSync(PORR);

const kids = (m: DfsModel, key: string) => (m.children.get(key) ?? []).map((k) => m.rows.get(k)!);
function expectParentIsSum(m: DfsModel) {
  for (const [k, r] of m.rows) {
    const c = kids(m, k);
    if (!c.length) continue;
    const sum = (f: keyof DfsRow) => c.reduce((s, x) => s + (x[f] as number), 0);
    expect(r.drawingsTotal).toBe(sum('drawingsTotal'));
    expect(r.drawingsReleased).toBe(sum('drawingsReleased'));
    if (r.kind === 'PROJECT' || r.kind === 'NODE') {
      expect(r.packagesTotal).toBe(sum('packagesTotal'));
      expect(r.packagesComplete).toBe(sum('packagesComplete'));
    }
  }
}

function writeBook(name: string, sheets: Record<string, (string | number | null)[][]>) {
  const wb = XLSX.utils.book_new();
  for (const [n, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), n);
  const file = path.join(TMP, name);
  XLSX.writeFile(wb, file);
  return file;
}

async function project(code: string) {
  const [p] = await db.select().from(projects).where(eq(projects.projectCode, code)).limit(1);
  return p;
}

async function count(projectId: string) {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(drawings).where(eq(drawings.projectId, projectId));
  return r.n;
}

describe('Upload rules and templates', () => {
  const buf = fs.readFileSync(path.resolve(process.cwd(), 'data/project-sources/project-list.xlsx'));
  it('accepts a plain .xlsx and refuses macro-enabled, macro-carrying, oversized or non-workbook files', () => {
    expect(() => validateUpload('list.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buf.length, buf)).not.toThrow();
    expect(() => validateUpload('list.xlsm', '', buf.length, buf)).toThrow(/Macro-enabled/);
    expect(() => validateUpload('list.xls', '', buf.length, buf)).toThrow(/\.xlsx/);
    expect(() => validateUpload('list.xlsx', 'text/plain', buf.length, buf)).toThrow(/not an Excel/);
    const fake = Buffer.concat([buf, Buffer.from('xl/vbaProject.bin')]);
    expect(() => validateUpload('list.xlsx', '', fake.length, fake)).toThrow(/macros/);
    const text = Buffer.from('hello');
    expect(() => validateUpload('list.xlsx', '', text.length, text)).toThrow(/not an Excel/);
    expect(() => validateUpload('list.xlsx', '', 50 * 1024 * 1024, buf)).toThrow(/larger/);
  });

  it('every template is recognised as its own file type', () => {
    for (const t of CENTRE_FILE_TYPES) {
      const f = path.join(TMP, `template-${t}.xlsx`);
      fs.writeFileSync(f, templateWorkbook(t));
      expect(inspectWorkbook(f, path.basename(f)).detected).toBe(t);
    }
  });
});

describe.skipIf(!available)('Project List → the project hierarchy', () => {
  let before: Record<string, string>;
  beforeAll(async () => {
    before = Object.fromEntries((await db.select().from(projects).where(inArray(projects.projectCode, ['POARR-RES', 'POARR-T08', 'POARR-T09', 'VIOLET-HILL']))).map((p) => [p.projectCode, p.id]));
  });

  it('dry run, then import: the parent project the drawing import made is kept; the towers keep their ids', async () => {
    const file = path.resolve(process.cwd(), 'data/project-sources/project-list.xlsx');
    // The drawing import already gave the hierarchy from its manifest (drawings-a);
    // the Project List adds only what it says beyond that (the display order).
    const porrBefore = await project('PORR');
    expect(porrBefore?.displayName).toBe('Pursuit of a Radical Rhapsody');
    const dry = await runCentreImport({ file, fileName: 'project-list.xlsx', fileType: 'PROJECT_LIST', apply: false, actor: admin });
    expect(dry.mode).toBe('PREVIEW');
    expect(dry.counts).toMatchObject({ create: 0 });
    const done = await runCentreImport({ file, fileName: 'project-list.xlsx', fileType: 'PROJECT_LIST', apply: true, actor: admin });
    expect(done.mode).toBe('APPLIED');
    const porr = await project('PORR');
    expect(porr.id).toBe(porrBefore.id);
    expect(porr.displayName).toBe('Pursuit of a Radical Rhapsody');
    for (const [code, name] of [['POARR-RES', 'Residential'], ['POARR-T08', 'Tower 08'], ['POARR-T09', 'Tower 09']]) {
      const p = await project(code);
      expect(p.id).toBe(before[code]);
      expect(p.displayName).toBe(name);
      expect(p.parentProjectId).toBe(porr.id);
    }
    expect((await project('VIOLET-HILL')).displayName).toBe('Violet Hill');
    // Idempotent: a second run changes nothing.
    const again = await runCentreImport({ file, fileName: 'project-list.xlsx', fileType: 'PROJECT_LIST', apply: false, actor: admin });
    expect(again.counts).toMatchObject({ create: 0, update: 0, unchanged: 5 });
  });

  it('the Project filter lists only top-level projects, by full name', async () => {
    const names = (await dfsRootProjects()).map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['Pursuit of a Radical Rhapsody', 'Violet Hill']));
    expect(names).not.toContain('Residential');
    expect(names.some((n) => /POARR|VIOLET-HILL/.test(n))).toBe(false);
  });

  it('Pursuit of a Radical Rhapsody holds Residential, Tower 08 and Tower 09; totals reconcile to the source counts, once each', async () => {
    const porr = await project('PORR');
    const m = await buildDfsModel({ projectId: porr.id });
    expect(m.roots).toEqual([`P:${porr.id}`]);
    const top = m.rows.get(`P:${porr.id}`)!;
    expect(top.name).toBe('Pursuit of a Radical Rhapsody');
    const towers = kids(m, top.key);
    expect(towers.map((t) => [t.name, t.typeLabel])).toEqual([
      // A project under another is a Phase, or a Tower / Product … by its name.
      ['Residential', 'Phase'],
      ['Tower 08', 'Tower'],
      ['Tower 09', 'Tower'],
    ]);
    expectParentIsSum(m);
    // The source's own validation targets (the manifest), against what the database now holds.
    const expected = loadManifest(PORR).manifest.expected!;
    for (const t of towers) {
      const code = { Residential: 'POARR-RES', 'Tower 08': 'POARR-T08', 'Tower 09': 'POARR-T09' }[t.name]!;
      const p = await project(code);
      const [db1] = await db
        .select({ n: sql<number>`count(*)::int`, r: sql<number>`(count(*) filter (where ${drawings.completionStatus} = 'COMPLETED'))::int` })
        .from(drawings)
        .where(eq(drawings.projectId, p.id));
      expect(t.drawingsTotal).toBe(db1.n);
      expect(t.drawingsReleased).toBe(db1.r);
      const [imported] = await db.select({ n: sql<number>`count(*)::int` }).from(drawings).where(and(eq(drawings.projectId, p.id), eq(drawings.isManual, false)));
      // Conflicts resolved in Drawing Control (drawings-b) may add a drawing the register held back.
      expect(imported.n).toBeGreaterThanOrEqual(expected.projects[code].drawings);
      expect(t.drawingsReleased).toBeGreaterThanOrEqual(expected.projects[code].released);
    }
    expect(top.drawingsTotal).toBe(towers.reduce((a, t) => a + t.drawingsTotal, 0));
    // Whole view: PoRR counted once, never again through its towers.
    const all = await buildDfsModel({});
    expect(all.roots.filter((k) => all.rows.get(k)!.name === 'Residential')).toHaveLength(0);
    expectParentIsSum(all);
  });
});

describe.skipIf(!available)('Violet Hill 03-Year Plan through the Import Centre', () => {
  const src = path.resolve(process.cwd(), 'data/drawing-sources/violet-hill/0118_Violet Hill_ 03YPlan_01012026 - Ph 1 trail.xlsx');

  it('is read as a drawing register with a Design Fee sheet; importing it adopts the existing drawings (no duplicates)', async () => {
    const vh = await project('VIOLET-HILL');
    const n0 = await count(vh.id);
    const file = path.join(TMP, path.basename(src));
    fs.copyFileSync(src, file);
    const ins = inspectWorkbook(file, path.basename(file));
    expect(ins.detected).toBe('PLAN');
    expect(ins.designFee?.packages).toBe(24);
    const dry = await runCentreImport({ file, fileName: path.basename(file), fileType: 'PLAN', projectId: vh.id, apply: false, actor: admin });
    expect(dry.counts.create).toBe(0);
    const done = await runCentreImport({ file, fileName: path.basename(file), fileType: 'PLAN', projectId: vh.id, apply: true, actor: admin });
    expect(done.mode).toBe('APPLIED');
    expect(await count(vh.id)).toBe(n0);
    const nodes = await db.select().from(dfsWbsNodes).where(eq(dfsWbsNodes.projectId, vh.id));
    expect(nodes.map((n) => n.name).sort()).toEqual(['Clubhouse + Amenities', 'DESIGN CONCEPT', 'Master Plan']);
    const m = await buildDfsModel({ projectId: vh.id });
    expectParentIsSum(m);
    const top = m.rows.get(`P:${vh.id}`)!;
    expect(top.drawingsReleased).toBe(top.drawingsTotal);
    // Every package with drawings is complete (all 88 are released); the rest have none yet.
    const rows = [...m.rows.values()].filter((r) => r.kind === 'PACKAGE');
    for (const r of rows) expect(r.status).toBe(r.drawingsTotal > 0 ? 'COMPLETE' : 'NOT_COMPLETE');
    expect(top.packagesComplete).toBe(rows.filter((r) => r.drawingsTotal > 0).length);
  }, 300_000);
});

describe('A workbook of another shape, for a new project — no code changes', () => {
  let file: string;
  let projectId: string;
  const DESIGN_FEE: (string | number | null)[][] = [
    [null, 'Synthetic Park', null, null, 'AR', null, 'ST'],
    [null, null, null, null, '%', 'Fee', '%', 'Fee'],
    [],
    [],
    [null, 'CONSTRUCTION DOCUMENTS'],
    [null, '1', null, 'Block 1'],
    [null, '1', 'BLK1-01', 'Foundations', 0.1, 0.5, 0.1, 0.2],
    [null, '2', 'BLK1-02', 'Superstructure', 0.1, 0.7, 0.1, 0.3],
    [null, '2', null, 'Block 2'],
    [null, '1', 'BLK2-01', 'Shell and core', 0.1, 0.4, 0.1, 0.1],
    [null, null, null, 'Design Fees', null, 1.6, null, 0.6],
  ];
  const REGISTER: (string | number | null)[][] = [
    ['Synthetic Park — drawing register'],
    ['Discipline', 'Drawing No.', 'Drawing name', 'Location', 'Batch Code', 'Revision', 'Date of release'],
    ['AR', 'SP-AR-1001', 'Block 1 foundation plan', 'BLK1', 'AR-BLK1-1', 'R0', '2026-03-10'],
    ['ST', 'SP-ST-1001', 'Block 1 foundation reinforcement', 'BLK1', 'ST-BLK1-1', 'R1', '2026-03-12'],
    ['AR', 'SP-AR-1002', 'Block 1 typical floor plan', 'BLK1', 'AR-BLK1-2', 'R0', '2026-05-02'],
    ['AR', 'SP-AR-1003', 'Block 1 roof plan', 'BLK1', 'AR-BLK1-2', 'R0', null],
    ['AR', null, 'Block 1 staircase details', 'BLK1', 'AR-BLK1-2', null, null],
  ];

  beforeAll(() => {
    file = writeBook('Synthetic Park register.xlsx', { 'Design Fee': DESIGN_FEE, 'Drawing Register': REGISTER });
  });

  it('is recognised and its columns are read from the headers', () => {
    const ins = inspectWorkbook(file, 'Synthetic Park register.xlsx');
    expect(ins.detected).toBe('PLAN');
    const m = ins.mapping.find((x) => x.sheet === 'Drawing Register')!;
    expect(m.columns).toMatchObject({ number: 'B', title: 'C', location: 'D', batchCode: 'E', revision: 'F', discipline: 'A', releaseDate: 'G' });
    expect(ins.designFee).toMatchObject({ packages: 3, headings: 2 });
  });

  it('dry run for a new project writes nothing; the import creates the project, its packages and drawings', async () => {
    const newProject = { fullName: 'Synthetic Park', shortCode: 'SYN-PARK' };
    const dry = await runCentreImport({ file, fileName: 'Synthetic Park register.xlsx', fileType: 'PLAN', newProject, apply: false, actor: admin });
    expect(dry.mode).toBe('PREVIEW');
    expect(dry.counts.create).toBe(5);
    expect(await project('SYN-PARK')).toBeUndefined();
    const mapping = { columns: { 'Drawing Register': { number: 'B', title: 'C', location: 'D', batchCode: 'E' } } };
    const done = await runCentreImport({ file, fileName: 'Synthetic Park register.xlsx', fileType: 'PLAN', newProject, mapping, apply: true, actor: admin });
    expect(done.mode).toBe('APPLIED');
    const p = await project('SYN-PARK');
    projectId = p.id;
    expect(p.displayName).toBe('Synthetic Park');
    expect(await count(p.id)).toBe(5);
    expect(await savedMapping(p.id, 'PLAN')).toEqual(mapping);
    const pk = await db.select().from(packages).where(eq(packages.projectId, p.id));
    expect(pk.map((x) => x.packageCode).sort()).toEqual(['BLK1-01', 'BLK1-02', 'BLK2-01']);
    // Not-yet-numbered drawings are included; no date is made up.
    const nyn = await db.select().from(drawings).where(and(eq(drawings.projectId, p.id), eq(drawings.numberStatus, 'NOT_YET_NUMBERED')));
    expect(nyn).toHaveLength(1);
    const undated = await db.select().from(drawings).where(and(eq(drawings.projectId, p.id), eq(drawings.drawingCode, 'SP-AR-1003')));
    expect(undated[0].completionStatus).toBe('NOT_COMPLETED');
    expect(undated[0].actualReleaseDate).toBeNull();
  }, 300_000);

  it('DFS shows it like any other project: headings, package status, parent = sum', async () => {
    const m = await buildDfsModel({ projectId });
    expectParentIsSum(m);
    const top = m.rows.get(`P:${projectId}`)!;
    expect(top.name).toBe('Synthetic Park');
    // Block 2 has no drawings yet: an empty row, not shown and not counted …
    expect(kids(m, top.key).map((r) => r.name)).toEqual(['Block 1']);
    const status = Object.fromEntries([...m.rows.values()].filter((r) => r.kind === 'PACKAGE').map((r) => [r.code, [r.status, r.noDrawings]]));
    expect(status).toEqual({ 'BLK1-01': ['COMPLETE', false], 'BLK1-02': ['NOT_COMPLETE', false] });
    expect(top).toMatchObject({ packagesComplete: 1, packagesTotal: 2, drawingsReleased: 3, drawingsTotal: 5 });
    // … and back, greyed and Pending, with "Show empty rows" (Edit Mode).
    const e = await buildDfsModel({ projectId, showEmpty: true });
    expect(kids(e, `P:${projectId}`).map((r) => [r.name, Boolean(r.empty)])).toEqual([['Block 1', false], ['Block 2', true]]);
    expect([...e.rows.values()].find((r) => r.code === 'BLK2-01')).toMatchObject({ status: 'NOT_COMPLETE', noDrawings: true, empty: true, packagesTotal: 0 });
  });

  it('a second run of the same file creates nothing (idempotent)', async () => {
    const r = await runCentreImport({ file, fileName: 'Synthetic Park register.xlsx', fileType: 'PLAN', projectId, apply: true, actor: admin });
    expect(r.counts.create).toBe(0);
    expect(await count(projectId)).toBe(5);
  }, 300_000);

  it('Undo this import: only the latest run; a drawing edited since is kept', async () => {
    const [second, first] = (await importHistory()).filter((h) => h.status === 'Imported');
    expect(second.canUndo).toBe(true);
    await expect(undoImport(first.id, admin)).rejects.toThrow(/latest/);
    await undoImport(second.id, admin);
    expect(await count(projectId)).toBe(5);
    // Someone edits one of the drawings the first run created.
    const [edited] = await db.select().from(drawings).where(and(eq(drawings.projectId, projectId), eq(drawings.drawingCode, 'SP-AR-1002')));
    await updateDrawing(edited.id, { remarks: 'checked on site' }, admin, 'test edit');
    const res = await undoImport(first.id, admin);
    expect(res.removedDrawings).toBe(4);
    expect(res.kept.some((k) => k.startsWith('SP-AR-1002'))).toBe(true);
    const left = await db.select().from(drawings).where(eq(drawings.projectId, projectId));
    expect(left.map((d) => d.drawingCode)).toEqual(['SP-AR-1002']);
    expect(await project('SYN-PARK')).toBeDefined(); // still holds the kept drawing
    expect((await importHistory()).find((h) => h.id === first.id)!.status).toBe('Undone');
  }, 300_000);
});

describe.skipIf(!available)('Autodesk Construction Cloud release export', () => {
  it('releases matching drawings with their dates, reports unknown numbers, and can be undone', async () => {
    const t08 = await project('POARR-T08');
    const open = await db
      .select()
      .from(drawings)
      .where(and(eq(drawings.projectId, t08.id), eq(drawings.completionStatus, 'NOT_COMPLETED'), eq(drawings.numberStatus, 'NUMBERED'), eq(drawings.userEditedFields, '')))
      .limit(2);
    expect(open).toHaveLength(2);
    const file = writeBook('acc-export.xlsx', {
      Released: [
        ['Number', 'Title', 'Date of Release'],
        [open[0].drawingCode, open[0].drawingName, 'Mar 13, 2026'],
        [open[1].drawingCode, open[1].drawingName, '2026-03-20'],
        ['ZZ-NOT-A-DRAWING', 'Unknown', 'Mar 13, 2026'],
      ],
    });
    expect(inspectWorkbook(file, 'acc-export.xlsx').detected).toBe('ACC');
    const dry = await runCentreImport({ file, fileName: 'acc-export.xlsx', fileType: 'ACC', projectId: t08.id, apply: false, actor: admin });
    expect(dry.counts).toMatchObject({ update: 2, create: 0 });
    expect(dry.issues.find((i) => i.code === 'ACC_NUMBER_NOT_FOUND')).toMatchObject({ sheet: 'Released', row: 4, value: 'ZZ-NOT-A-DRAWING' });
    const done = await runCentreImport({ file, fileName: 'acc-export.xlsx', fileType: 'ACC', projectId: t08.id, apply: true, actor: admin });
    const after = await db.select().from(drawings).where(inArray(drawings.id, open.map((d) => d.id)));
    for (const d of after) expect(d.completionStatus).toBe('COMPLETED');
    expect(after.find((d) => d.id === open[0].id)!.actualReleaseDate?.toISOString()).toBe('2026-03-13T00:00:00.000Z');
    await undoImport(done.batchId!, admin);
    const back = await db.select().from(drawings).where(inArray(drawings.id, open.map((d) => d.id)));
    for (const d of back) {
      expect(d.completionStatus).toBe('NOT_COMPLETED');
      expect(d.actualReleaseDate).toBeNull();
    }
  });
});

describe('Import Centre permissions', () => {
  beforeAll(async () => {
    for (const [role, email] of [
      ['VIEWER', 'centre-viewer@test.local'],
      ['EDITOR', 'centre-editor@test.local'],
      ['MANAGER', 'centre-manager@test.local'],
    ]) {
      await db.insert(users).values({ id: newId('us_'), name: role, email, role, active: true }).onConflictDoUpdate({ target: users.email, set: { role } });
    }
  });
  it('Administrator and Manager only', async () => {
    const call = (email: string) => historyRoute.GET(new Request('http://test.local/api/import-centre/history', { headers: { 'x-user-email': email } }));
    expect((await call('centre-viewer@test.local')).status).toBe(403);
    expect((await call('centre-editor@test.local')).status).toBe(403);
    expect((await call('centre-manager@test.local')).status).toBe(200);
    expect((await call('admin@company.local')).status).toBe(200);
  });
});
