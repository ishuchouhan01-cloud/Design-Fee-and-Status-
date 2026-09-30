/**
 * Row classification for Design Goals FY 26.
 *
 * These are the two rules the module turns on, so they are tested directly
 * rather than only through the importer.
 */
import { describe, expect, it } from 'vitest';
import { classifyRow, mapColumns, type SheetColumns } from '@/lib/import/design-goals-fy26/classify';
import type { Row } from '@/lib/import/workbook';

/** Layout A: billing in J-M, no Phase/Discipline columns. */
const HEADER_A: Row = [
  null,
  'Project',
  'Description',
  'Release date',
  'Responsible',
  'Remarks',
  null,
  null,
  null,
  'Plan - Billing [Cr.]',
  'Plan - Pkgs',
  'Actuals - Billing [Cr.]',
  'Actuals - Pkgs',
];

/** Layout B (ITQE, OTR): billing shifted left to H-K, Phase and Discipline at L-M. */
const HEADER_B: Row = [
  null,
  'Project',
  'Description',
  'Release date',
  'Responsible',
  'Remarks',
  null,
  'Plan - Billing [Cr.]',
  'Plan - Pkgs',
  'Actuals - Billing [Cr.]',
  'Actuals - Pkgs',
  'Phase',
  'Discipline',
];

function columnsFor(header: Row): SheetColumns {
  const mapped = mapColumns([[], [], header]);
  expect(mapped).not.toBeNull();
  return mapped!.columns;
}

function row(cells: Record<number, unknown>): Row {
  const out: Row = [];
  for (let i = 0; i <= 13; i += 1) out[i] = (cells[i] ?? null) as never;
  return out;
}

describe('column mapping', () => {
  it('finds the header row and maps billing by label, not by letter', () => {
    const a = mapColumns([[], [], HEADER_A])!;
    const b = mapColumns([[], [], HEADER_B])!;
    expect(a.headerRow).toBe(2);
    expect(a.columns.planBilling).toBe(9); // column J
    expect(b.columns.planBilling).toBe(7); // column H — two columns left
    expect(a.columns.phase).toBeUndefined();
    expect(b.columns.phase).toBe(11);
    expect(b.columns.discipline).toBe(12);
  });

  it('handles a header row that is not on row 3', () => {
    const mapped = mapColumns([[], [], [], HEADER_A]);
    expect(mapped?.headerRow).toBe(3);
  });
});

describe('dependency detection', () => {
  const c = columnsFor(HEADER_A);

  it('accepts a Step-marked row', () => {
    const r = classifyRow(row({ 1: 'Step 1', 2: 'MEP coordinated layout', 4: 'Bhavya' }), 9, c);
    expect(r.cls).toBe('DEPENDENCY');
  });

  it('accepts a row with NO value in column B — the 65-row case', () => {
    const r = classifyRow(
      row({ 2: 'Glazing Details - Skylight, Car Parking Canopy', 3: new Date('2026-09-24'), 4: 'Gokul' }),
      7,
      c,
    );
    expect(r.cls).toBe('DEPENDENCY');
    expect(r.scopeLabel).toBeNull();
  });

  it('keeps a real task whose owner cell is still the template placeholder', () => {
    const r = classifyRow(
      row({ 1: 'Step 1', 2: 'Swimming pool & Filtration Room details', 3: new Date('2026-10-15'), 4: 'User 1' }),
      46,
      c,
    );
    expect(r.cls).toBe('DEPENDENCY');
    expect(r.keptBecause).toContain('description');
  });

  it('keeps a row whose only real content is a remark', () => {
    const r = classifyRow(row({ 1: 'Step 2', 2: 'Task description 2', 4: 'User 2', 5: 'Awaiting AUM' }), 11, c);
    expect(r.cls).toBe('DEPENDENCY');
    expect(r.keptBecause).toEqual(['remarks']);
  });
});

describe('template exclusion', () => {
  const c = columnsFor(HEADER_A);

  it('rejects the plain template row', () => {
    const r = classifyRow(row({ 1: 'Step 1', 2: 'Task description 1', 4: 'User 1' }), 7, c);
    expect(r.cls).toBe('TEMPLATE');
  });

  it('rejects a template row that carries a plausible date', () => {
    // The Imagine and LGCE workbooks ship the template block with real dates
    // already filled in. A date alone must not make a row real.
    const r = classifyRow(
      row({ 1: 'Step 1', 2: 'Task description 1', 3: new Date('2026-10-15'), 4: 'User 1' }),
      7,
      c,
    );
    expect(r.cls).toBe('TEMPLATE');
  });

  it('rejects the case and spacing variants seen in the source', () => {
    expect(classifyRow(row({ 1: 'Step 1', 2: 'Task Description', 4: 'User 1' }), 7, c).cls).toBe('TEMPLATE');
    expect(classifyRow(row({ 1: 'Step 2', 2: 'Task description 2', 4: 'User2' }), 8, c).cls).toBe('TEMPLATE');
    expect(classifyRow(row({ 1: 'Step 2', 2: 'Task description 2' }), 8, c).cls).toBe('TEMPLATE');
  });

  it('treats the 1900-01-13 dummy as no date at all', () => {
    const r = classifyRow(row({ 1: 'Step 1', 3: new Date(Date.UTC(1900, 0, 13)) }), 7, c);
    expect(r.cls).toBe('EMPTY_STEP');
    expect(r.releaseDate).toBeNull();
  });

  it('reports a bare Step marker as an empty step, not a dependency', () => {
    expect(classifyRow(row({ 1: 'Step 2' }), 13, c).cls).toBe('EMPTY_STEP');
  });
});

describe('hierarchy rows', () => {
  const c = columnsFor(HEADER_A);

  it('recognises a discipline banner', () => {
    expect(classifyRow(row({ 1: 'Architecture', 2: 'Complete the project' }), 7, c).cls).toBe('DISCIPLINE');
    expect(classifyRow(row({ 1: 'Master planning', 2: 'Package Release' }), 7, c).cls).toBe('DISCIPLINE');
  });

  it('recognises a banner row by its structural description', () => {
    expect(classifyRow(row({ 1: 'ITQE-Ph1', 2: 'Package Release' }), 6, c).cls).toBe('PROJECT');
    expect(classifyRow(row({ 1: 'ITQE' }), 4, c).cls).toBe('PROJECT');
  });

  it('recognises a package row', () => {
    const r = classifyRow(
      row({ 1: 'ITQE-Ph1', 2: 'DG/ Transformer yard', 3: new Date('2026-11-13'), 4: 'Cijey M', 9: 0.0119, 10: 1 }),
      11,
      c,
    );
    expect(r.cls).toBe('PACKAGE');
    expect(r.planBillingCr).toBeCloseTo(0.0119);
    expect(r.planPkgs).toBe(1);
  });

  it('recognises a split continuation row', () => {
    // Columns B-F empty, billing and team present: the orphaned half of a
    // package row, not a package of its own.
    const r = classifyRow(row({ 9: 0.00371275425, 10: 1, 11: 0 }), 47, c);
    expect(r.cls).toBe('SPLIT_CONTINUATION');
  });

  it('treats a fully empty row as a spacer', () => {
    expect(classifyRow(row({}), 20, c).cls).toBe('SPACER');
  });
});
