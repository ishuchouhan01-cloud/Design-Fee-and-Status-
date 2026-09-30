/**
 * Thin, tolerant reading layer over SheetJS. Everything the importers need to
 * know about "what shape is this sheet" lives here, so the mappers stay
 * readable.
 */
import fs from 'node:fs';
import * as XLSX from 'xlsx';
import { resolveSheet, type FormulaIssue, type RawCell } from './cells';

export type Cell = string | number | boolean | Date | null;
export type Row = Cell[];

export interface SheetData {
  name: string;
  hidden: boolean;
  rows: Row[]; // 0-based array; rows[0] is spreadsheet row 1
  merges: string[];
  /** Formula cells whose value could not be worked out (left empty). */
  formulaIssues?: FormulaIssue[];
}

export interface WorkbookData {
  file: string;
  fileName: string;
  sheets: SheetData[];
  byName: Map<string, SheetData>;
}

export function readWorkbook(file: string): WorkbookData {
  // Read the bytes with Node's own fs and parse the buffer. `XLSX.readFile`
  // relies on SheetJS finding `fs` itself, which it cannot do inside the
  // bundled Next.js server — there it fails with "Cannot access file" even
  // though the same call works from the command line.
  // Dates and formulas are resolved time-zone free and never passed on as
  // formula text (./cells.ts).
  const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer', cellDates: false, cellNF: true, cellFormula: true });
  const meta = wb.Workbook?.Sheets ?? [];
  const sheets: SheetData[] = wb.SheetNames.map((name, i) => {
    const ws = wb.Sheets[name];
    const addrs = Object.keys(ws).filter((k) => !k.startsWith('!'));
    const cells = addrs.map((a) => ({ ...XLSX.utils.decode_cell(a), cell: ws[a] as RawCell }));
    const { values, issues } = resolveSheet(name, cells, (r, c) => ws[XLSX.utils.encode_cell({ r, c })] as RawCell | undefined);
    for (const { r, c, cell } of cells) {
      const v = values.get(`${r}:${c}`) ?? null;
      const x = cell as { t?: string; v?: unknown; f?: string; w?: string };
      delete x.f;
      delete x.w;
      if (v === null) {
        x.t = 'z';
        delete x.v;
      } else if (v instanceof Date) {
        x.t = 'd';
        x.v = v;
      } else if (typeof v === 'number') {
        x.t = 'n';
        x.v = v;
      } else if (typeof v === 'boolean') {
        x.t = 'b';
        x.v = v;
      } else {
        x.t = 's';
        x.v = v;
      }
    }
    const rows = XLSX.utils.sheet_to_json<Row>(ws, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: true,
    });
    return {
      name,
      hidden: Boolean(meta[i]?.Hidden),
      rows: rows.map((r) => (Array.isArray(r) ? r : [])),
      merges: (ws['!merges'] ?? []).map((m) => XLSX.utils.encode_range(m)),
      formulaIssues: issues,
    };
  });
  return {
    file,
    fileName: file.split(/[\\/]/).pop() ?? file,
    sheets,
    byName: new Map(sheets.map((s) => [s.name, s])),
  };
}

export function col(letter: string): number {
  return XLSX.utils.decode_col(letter);
}

export function cellAt(row: Row | undefined, index: number): Cell {
  if (!row) return null;
  const v = row[index];
  return v === undefined ? null : v;
}

export function str(v: Cell): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).replace(/ /g, ' ').trim();
  return s.length === 0 || s === '-' || s === '–' ? null : s;
}

export function text(v: Cell): string | null {
  const s = str(v);
  return s ? s.replace(/\s+/g, ' ') : null;
}

export function num(v: Cell): number | null {
  if (v == null || v === '' || v === '-') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return null;
  const cleaned = String(v).replace(/[, ₹]/g, '').replace(/[()]/g, '').trim();
  if (cleaned === '' || cleaned === '-') return null;
  const pctMatch = /^(-?[\d.]+)%$/.exec(cleaned);
  if (pctMatch) return Number(pctMatch[1]) / 100;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function int(v: Cell): number | null {
  const n = num(v);
  return n == null ? null : Math.round(n);
}

/**
 * Excel serial dates arrive as Date objects because of `cellDates: true`, but
 * some cells hold text dates. Both are accepted; anything else is rejected so
 * the caller can log a data-quality issue rather than store garbage.
 */
export function date(v: Cell): Date | null {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()));
  }
  if (typeof v === 'number') {
    // Excel serial (1900 system)
    if (v < 1 || v > 80000) return null;
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }
  const s = String(v).trim();
  const dmy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/.exec(s);
  if (dmy) {
    // Source files use US m/d/yy formatting (verified against the cell number
    // formats in both workbooks).
    const [, a, b, y] = dmy;
    let year = Number(y);
    if (year < 100) year += year < 70 ? 2000 : 1900;
    return new Date(Date.UTC(year, Number(a) - 1, Number(b)));
  }
  const iso = new Date(s);
  if (!Number.isNaN(iso.getTime())) {
    return new Date(Date.UTC(iso.getUTCFullYear(), iso.getUTCMonth(), iso.getUTCDate()));
  }
  return null;
}

export function isBlankRow(row: Row | undefined): boolean {
  if (!row) return true;
  return row.every((c) => c == null || String(c).trim() === '');
}

/** Find the 0-based index of the header row by matching required labels. */
export function findHeaderRow(
  rows: Row[],
  required: { column: number; label: string }[],
  searchLimit = 12,
): number {
  for (let i = 0; i < Math.min(rows.length, searchLimit); i += 1) {
    const ok = required.every(({ column, label }) => {
      const v = text(cellAt(rows[i], column));
      return v != null && v.toLowerCase() === label.toLowerCase();
    });
    if (ok) return i;
  }
  return -1;
}

/** Locate a column by its header label anywhere in the first few rows. */
export function findColumn(rows: Row[], label: string, searchLimit = 6): number {
  const target = label.toLowerCase();
  for (let i = 0; i < Math.min(rows.length, searchLimit); i += 1) {
    const row = rows[i] ?? [];
    for (let c = 0; c < row.length; c += 1) {
      const v = text(row[c]);
      if (v && v.toLowerCase() === target) return c;
    }
  }
  return -1;
}
