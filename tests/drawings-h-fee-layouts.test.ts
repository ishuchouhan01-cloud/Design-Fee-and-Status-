/**
 * Design Fee layouts and batch → package linking (generic importer).
 *
 *   L1  PACKAGE_TOTAL: one fee per package ("Total Fee | Released Till Date |
 *       Balance | Billed till Dec'yy"), package rows coded with the sheet's
 *       department prefix (AR-BB26-2 → package BB26-2), heading rows
 *       (BB26 | GFC | Villa Block 26) are headings, never packages
 *   L2  DISCIPLINE_BLOCKS stays as it was, and can be pinned
 *   L3  batch → package on the code without its discipline prefix on BOTH
 *       sides; padding variants; nothing guessed
 *   L4  the Design Fee sheet is chosen deterministically and can be changed;
 *       a sheet of another layout is reported, never fatal
 *   L5  disciplines: SR sheets, UD / SR prefixes
 *
 * Every workbook here is built in the test — no real data.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { centreManifest } from '@/lib/import/centre-manifest';
import {
  chooseFeeSheet,
  feeLayoutOf,
  feeSheetCandidates,
  feeSheetRevision,
  PACKAGE_FEE_LINE,
  packageCodeForBatch,
  packageLineCode,
  parseDesignFee,
} from '@/lib/import/drawing-register/design-fee';
import { manifestSchema } from '@/lib/import/drawing-register/manifest';
import { parseSources, sheetDiscipline } from '@/lib/import/drawing-register/parse';
import { buildPlan } from '@/lib/import/drawing-register/plan';
import { readTextWorkbook, type TextSheet } from '@/lib/import/drawing-register/read';

type Cell = string | number | null;
const sheet = (name: string, rows: Cell[][], hidden = false): TextSheet => ({ name, hidden, rows: rows.map((r) => r.map((v) => (v == null ? null : String(v)))) });

/** A Design Fee sheet with one fee per package; per-discipline blocks to the right that do NOT add up. */
function packageTotalRows(billedTill = "Billed till Dec'25"): Cell[][] {
  const H: Cell[] = [null, null, '0999 | Sample Estate Phase 2c', null, 'Total Fee', 'Released Till Date', 'Balance', billedTill, 'Planned Billing CY 26', 'Q1', 'Q2', 'Q3', 'Q4'];
  H[20] = 'AR';
  H[22] = 'Fee';
  H[23] = 'Billing YTD';
  const row = (b: Cell, c: Cell, d: Cell, total: number | null, released: number | null, balance: number | null, billed: number | null, arFee: number | null = null) => {
    const r: Cell[] = [null, b, c, d, total, released, balance, billed];
    if (arFee != null) r[22] = arFee;
    return r;
  };
  return [
    [null, null, null, null, 'Packages Design Fee', null, null, '2026'],
    [],
    H,
    [null, null, 'Design Packages', null, 9, 6, 3, 5],
    [null, null, 'Design Fee', null, 3.5, 2.1, 1.4, 1.6],
    [],
    [null, 'DESIGN', null, null, 1.0, 1.0, 0, 1.0],
    row(1, 'Contract + Design Brief', null, 0.6, 0.6, 0, 0.6),
    row('DC 01', 'Schematic Concept', null, 0.4, 0.4, 0, 0.4),
    [null, 'CONSTRUCTION DOCUMENTS', null, null, 2.2, 1.1, 1.1, 0.6],
    row('BB26', 'GFC | Villa Block 26', null, 1.0, 0.7, 0.3, 0.5),
    row('AR-BB26-1', 'Foundations and Sub-Grade Structure', null, 0.4, 0.4, 0, 0.3, 0.1),
    row('AR-BB26-2', 'Super Structure', null, 0.6, 0.3, 0.3, 0.2, 0.1),
    row('MP', 'GFC | Master Plan', null, 1.2, 0.4, 0.8, 0.1),
    row('AR-MP-1', 'Master Plan', null, 0.7, 0.4, 0.3, 0.1),
    row('AR-PDV30-1', 'V30 Default and its variants', null, 0.5, 0, 0.5, 0),
    [null, 'POST-CONSTRUCTION', null, null, 0.3, 0, 0.3, 0],
    row('MA', 'Master Archives', null, 0.3, 0, 0.3, 0),
    row('AR-MA-1', 'Complete set of As-Built drawings', null, 0.3, 0, 0.3, 0),
    [null, 'REWORK'],
  ];
}

/** The PoRR-style layout: one block per discipline (AR · ST), each with Fee / Billing YTD. */
function disciplineBlockRows(): Cell[][] {
  return [
    [null, null, null, 'AR', null, 'Fee', 'Billing YTD', 'ST', null, 'Fee', 'Billing YTD'],
    [],
    [],
    [],
    [null, 'CONSTRUCTION DOCUMENTS'],
    [null, '1', 'GFC | Tower—01'],
    [null, 'T01-01', 'Foundation', 0.05, null, 0.4, 0.4, 0.05, null, 0.2, 0.1],
    [null, 'T01-02', 'Parking Level', 0.05, null, 0.3, 0, 0.05, null, 0.1, 0],
    [null, null, 'Design Fees', null, null, 0.7, null, null, null, 0.3],
  ];
}

describe('L1 PACKAGE_TOTAL — one fee per package', () => {
  const s = sheet('Design Fee', packageTotalRows());
  const p = parseDesignFee({ file: 'x.xlsx', projectCode: 'P' }, s, { labelPrefix: '^GFC\\s*\\|\\s*' });

  it('is detected from the Total Fee / Balance column set', () => {
    expect(feeLayoutOf(s)).toBe('PACKAGE_TOTAL');
    expect(p.layout).toBe('PACKAGE_TOTAL');
  });

  it('reads every package row, on its code without the department prefix; headings stay headings', () => {
    expect(p.packages.map((x) => x.code)).toEqual(['BB26-1', 'BB26-2', 'MP-1', 'PDV30-1', 'MA-1']);
    expect(p.packages.map((x) => x.lineCode)).toEqual(['AR-BB26-1', 'AR-BB26-2', 'AR-MP-1', 'AR-PDV30-1', 'AR-MA-1']);
    expect(p.packages.find((x) => x.code === 'BB26-2')!.name).toBe('Super Structure');
    // BB26 / MP / MA are the headings the packages sit under — never packages themselves.
    expect(p.nodes.map((n) => [n.code, n.name])).toEqual([
      ['BB26', 'Villa Block 26'],
      ['MP', 'Master Plan'],
      ['MA', 'Master Archives'],
    ]);
    expect(p.packages.find((x) => x.code === 'BB26-1')!.nodeKey).toBe(p.nodes[0].key);
    // A design-stage line ("DC 01 Schematic Concept") is not a package.
    expect(p.packages.some((x) => x.code.startsWith('DC'))).toBe(false);
  });

  it('stores one fee line per package — Total, Billed till Dec, Released and Balance as given; no split invented', () => {
    const bb = p.packages.find((x) => x.code === 'BB26-2')!;
    expect(bb.disciplines).toEqual([{ discipline: PACKAGE_FEE_LINE, percent: null, fee: 0.6, billedToDate: 0.2, totalDrawings: null, releasedToDate: 0.3, balance: 0.3 }]);
  });

  it('reconciles with the sheet total row: packages + outside packages = Design Fee', () => {
    expect(p.sheetTotal[PACKAGE_FEE_LINE]).toBe(3.5);
    expect(p.sheetBilled![PACKAGE_FEE_LINE]).toBe(1.6);
    expect(p.packageFees[PACKAGE_FEE_LINE]).toBe(2.5);
    expect(p.packageBilled![PACKAGE_FEE_LINE]).toBe(0.6);
    expect(p.feesOutsidePackages[PACKAGE_FEE_LINE]).toBe(1);
  });

  it('gives the sheet title as the default project name', () => {
    expect(p.title).toEqual({ code: '0999', name: 'Sample Estate Phase 2c' });
  });

  it('Billed is the till-date column when the sheet has no "Billed till Dec" column', () => {
    const rows = packageTotalRows().map((r) => [...r]);
    rows[2][5] = 'Billed Till Date';
    rows[2][7] = 'Planned Billing CY 26';
    const q = parseDesignFee({ file: 'x.xlsx', projectCode: 'P' }, sheet('Design Fee', rows));
    const bb = q.packages.find((x) => x.code === 'BB26-2')!.disciplines[0];
    expect(bb.billedToDate).toBe(0.3);
    expect(bb.releasedToDate).toBeNull();
  });
});

describe('L2 DISCIPLINE_BLOCKS', () => {
  it('a per-discipline sheet reads as before (fee per discipline)', () => {
    const s = sheet('Design Fee', disciplineBlockRows());
    expect(feeLayoutOf(s)).toBe('DISCIPLINE_BLOCKS');
    const p = parseDesignFee({ file: 'x.xlsx', projectCode: 'P' }, s);
    expect(p.packages.map((x) => x.code)).toEqual(['T01-01', 'T01-02']);
    expect(p.packages[0].disciplines.map((d) => [d.discipline, d.fee, d.billedToDate])).toEqual([
      ['AR', 0.4, 0.4],
      ['ST', 0.2, 0.1],
    ]);
  });

  it('a sheet with both column sets can be pinned to its discipline blocks', () => {
    const p = parseDesignFee({ file: 'x.xlsx', projectCode: 'P', layout: 'DISCIPLINE_BLOCKS' }, sheet('Design Fee', packageTotalRows()));
    expect(p.layout).toBe('DISCIPLINE_BLOCKS');
    expect(p.packages.find((x) => x.code === 'BB26-1')!.disciplines.map((d) => d.discipline)).toEqual(['AR']);
  });

  it('pinning one fee per package on a sheet without that column set is an error, not a guess', () => {
    expect(() => parseDesignFee({ file: 'x.xlsx', projectCode: 'P', layout: 'PACKAGE_TOTAL' }, sheet('Design Fee', disciplineBlockRows()))).toThrow(/Total Fee \/ Balance/);
  });
});

describe('L3 batch → package', () => {
  const codes = new Set(['BB26-1', 'BB26-2', 'MP-1', 'MP-2', 'PDV30-1', 'T9-3', 'T01-01', 'BB01-1']);
  it('drops the discipline / department prefix on both sides', () => {
    expect(packageLineCode('AR-BB26-2')).toEqual({ code: 'BB26-2', prefix: 'AR' });
    expect(packageCodeForBatch('ST-BB26-2', codes)).toBe('BB26-2');
    expect(packageCodeForBatch('MEP-MP-1', codes)).toBe('MP-1');
    expect(packageCodeForBatch('UD-MP-2', codes)).toBe('MP-2');
    expect(packageCodeForBatch('SR-PDV30-1', codes)).toBe('PDV30-1');
    expect(packageCodeForBatch('AR-PDV30-1', codes)).toBe('PDV30-1');
    expect(packageCodeForBatch('BB26-1', codes)).toBe('BB26-1');
  });
  it('keeps the padding rules: number and location', () => {
    expect(packageCodeForBatch('AR-T01-1', codes)).toBe('T01-01');
    expect(packageCodeForBatch('AR-BB01-1', codes)).toBe('BB01-1');
    expect(packageCodeForBatch('T09-3', codes)).toBe('T9-3');
    expect(packageCodeForBatch('AR-BB1-1', codes)).toBe('BB01-1');
  });
  it('links nothing it cannot match exactly', () => {
    expect(packageCodeForBatch('ST-BB27-2', codes)).toBeNull();
    expect(packageCodeForBatch('LS-BB26', codes)).toBeNull();
    expect(packageCodeForBatch('MP-3', codes)).toBeNull();
    expect(packageCodeForBatch(null, codes)).toBeNull();
  });
});

describe('L4 choosing the Design Fee sheet', () => {
  const unreadable = sheet('Design Fee R (2)', [[null, null, 'Fee'], [null, 'T01-02', 'Foundation', 1]], true);
  const older = sheet('Design Fee R (3)', packageTotalRows("Billed till Dec'23"), true);
  const current = sheet('Design Fee', packageTotalRows("Billed till Dec'25"));

  it('reads the revision from the name', () => {
    expect([feeSheetRevision('Design Fee'), feeSheetRevision('Design Fee R'), feeSheetRevision('Design Fee R (2)'), feeSheetRevision('Design Fees')]).toEqual([0, 1, 2, 0]);
  });

  it('prefers a readable, visible sheet, then the latest "Billed till Dec", then the highest revision', () => {
    const list = feeSheetCandidates([unreadable, older, current]);
    expect(list.map((c) => c.sheet)).toEqual(['Design Fee', 'Design Fee R (3)', 'Design Fee R (2)']);
    expect(list[2].problem).toBeTruthy();
    expect(chooseFeeSheet([unreadable, older, current])!.sheet).toBe('Design Fee');
    const r = sheet('Design Fee R', packageTotalRows("Billed till Dec'25"));
    expect(chooseFeeSheet([current, r])!.sheet).toBe('Design Fee R');
  });

  it('the sheet the user chose wins', () => {
    expect(chooseFeeSheet([unreadable, older, current], 'Design Fee R (3)')!.sheet).toBe('Design Fee R (3)');
  });

  it('reports the blocks beside a one-fee-per-package sheet, and whether they add up', () => {
    const c = feeSheetCandidates([current])[0];
    expect(c.layout).toBe('PACKAGE_TOTAL');
    expect(c.blocks).toEqual({ total: 0.2, packageTotal: 2.5, complete: false });
  });

  it('a Design Fee sheet of another layout is reported; the drawings still import', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pds-fee-'));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Odd'], [null, 'T01-02', 'Foundation', 1]]), 'Design Fee');
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        [null, 'Discipline', 'Dwg. No.', 'Drawing name', 'Location', 'Batch Code', 'Batch', "Till Dec'25"],
        [],
        [null, 'AR', 'AR-T01-100', 'Ground floor plan', 'T01', 'AR-T01-1', '1', '1'],
        [null, 'AR', 'AR-T01-101', 'First floor plan', 'T01', 'AR-T01-1', '1', null],
      ]),
      'Drawing List | AR',
    );
    XLSX.writeFile(wb, path.join(dir, 'odd.xlsx'));
    const m = manifestSchema.parse({
      name: 't',
      sourceDir: '.',
      planSheetPattern: 'drawing list',
      planWorkbooks: [{ file: 'odd.xlsx', projectCode: 'P', role: 'CURRENT', label: 'odd', snapshotDate: null, planYear: 2026 }],
      designFees: [{ file: 'odd.xlsx', projectCode: 'P', sheet: 'Design Fee', label: 'odd' }],
      phaseMap: {},
    });
    const src = parseSources(m, dir);
    const plan = buildPlan(m, src);
    expect(plan.drawings).toHaveLength(2);
    expect(plan.issues.map((i) => i.code)).toContain('DESIGN_FEE_LAYOUT_NOT_READ');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('L5 disciplines and the Import Centre manifest', () => {
  it('a "Drawing List | SR" sheet is the Services discipline', () => {
    expect(sheetDiscipline('Drawing List | SR')).toBe('SR');
    expect(sheetDiscipline('AR | Drawing List')).toBe('AR');
  });

  it('the Import Centre manifest uses the chosen sheet and layout; the plan links every drawing by its batch', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pds-fee-'));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(packageTotalRows()), 'Design Fee');
    const list = (disc: string, rows: [string, string, string][]) =>
      XLSX.utils.aoa_to_sheet([
        [null, 'Discipline', 'Dwg. No.', 'Drawing name', 'Location', 'Batch Code', 'Batch', "Till Dec'25"],
        [],
        ...rows.map(([no, batch, rel]) => [null, disc, no, `${no} title`, 'BB26', batch, '1', rel]),
      ]);
    XLSX.utils.book_append_sheet(wb, list('AR', [['AR-BB26-100', 'AR-BB26-2', '1']]), 'Drawing List | AR');
    XLSX.utils.book_append_sheet(wb, list('ST', [['ST-BB26-100', 'ST-BB26-2', '1'], ['ST-BB26-101', 'ST-BB26-1', '']]), 'Drawing List | ST');
    XLSX.utils.book_append_sheet(wb, list('MEP', [['MEP-BB26-100', 'MEP-MP-1', '1']]), 'Drawing List | SR');
    XLSX.writeFile(wb, path.join(dir, 'estate.xlsx'));
    const sheets = readTextWorkbook(path.join(dir, 'estate.xlsx'));
    const m = centreManifest({ fileName: 'estate.xlsx', fileType: 'PLAN', sheets, mapping: { feeLayout: 'AUTO' }, code: 'EST', name: 'Estate' });
    expect(m.designFees).toEqual([{ file: 'estate.xlsx', projectCode: 'EST', sheet: 'Design Fee', label: 'estate.xlsx — Design Fee', layout: 'AUTO' }]);
    const plan = buildPlan(m, parseSources(m, dir));
    expect(plan.packages.map((p) => p.code)).toEqual(['BB26-1', 'BB26-2', 'MP-1', 'PDV30-1', 'MA-1']);
    expect(plan.packages.find((p) => p.code === 'BB26-2')!.packageFee).toEqual({ fee: 0.6, billedToDate: 0.2, releasedToDate: 0.3, balance: 0.3 });
    expect(plan.packages.every((p) => p.fees.length === 0)).toBe(true);
    expect(plan.drawings.map((d) => [d.drawingNumber, d.packageCode, d.packageRule]).sort()).toEqual([
      ['AR-BB26-100', 'BB26-2', 'BATCH'],
      ['MEP-BB26-100', 'MP-1', 'BATCH'],
      ['ST-BB26-100', 'BB26-2', 'BATCH'],
      ['ST-BB26-101', 'BB26-1', 'BATCH'],
    ]);
    // The fees reconcile to the sheet's own total row: packages + outside packages = Design Fee.
    const fee = plan.counts.fees.EST;
    expect(fee.layout).toBe('PACKAGE_TOTAL');
    expect(fee.sheetTotal[PACKAGE_FEE_LINE]).toBe(3.5);
    expect(fee.packageFees[PACKAGE_FEE_LINE] + fee.feesOutsidePackages[PACKAGE_FEE_LINE]).toBeCloseTo(3.5, 6);
    expect(fee.sheetBilled![PACKAGE_FEE_LINE]).toBe(1.6);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
