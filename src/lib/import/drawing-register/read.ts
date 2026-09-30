/**
 * Fast, clamped workbook reading for the drawing registers.
 *
 * Several of the 03YPlan sheets declare their range out to column XFD (16,384
 * columns). Materialising that with `sheet_to_json` takes close to a minute per
 * workbook. Reading in SheetJS dense mode and keeping only the cells that hold
 * a value takes about a second.
 */
import fs from 'node:fs';
import * as XLSX from 'xlsx';
import { resolveSheet, type FormulaIssue, type RawCell } from '../cells';

/** A cell value normalised to text: dates as YYYY-MM-DD, whitespace collapsed,
 *  blanks and the placeholder "@" as null. */
export type TextCell = string | null;
export type TextRow = TextCell[];

export interface TextSheet {
  name: string;
  hidden: boolean;
  /** rows[0] is spreadsheet row 1. */
  rows: TextRow[];
  /** Formula cells whose value could not be worked out (left empty). */
  formulaIssues?: FormulaIssue[];
}

function pad(n: number) {
  return String(n).padStart(2, '0');
}

export function normaliseCell(v: unknown): TextCell {
  if (v == null) return null;
  if (v instanceof Date) {
    // Dates are read time-zone free (../cells.ts): UTC midnight of the date typed in the cell.
    if (Number.isNaN(v.getTime())) return null;
    return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  }
  if (typeof v === 'string' && /^=[A-Za-z(]/.test(v.trim())) return null; // formula text is never a value
  const s = String(v).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  return s === '' || s === '@' ? null : s;
}

export function readTextWorkbook(file: string): TextSheet[] {
  const wb = XLSX.read(fs.readFileSync(file), {
    type: 'buffer',
    dense: true,
    cellDates: false,
    cellFormula: true,
    cellHTML: false,
    cellNF: true,
    cellText: false,
    cellStyles: false,
  });
  const meta = wb.Workbook?.Sheets ?? [];
  return wb.SheetNames.map((name, i) => {
    const ws = wb.Sheets[name] as unknown as RawCell[][];
    const dense = Array.isArray(ws) ? ws : [];
    const cells: { r: number; c: number; cell: RawCell }[] = [];
    for (let r = 0; r < dense.length; r++) {
      const src = dense[r];
      if (!src) continue;
      for (let c = 0; c < src.length; c++) if (src[c]) cells.push({ r, c, cell: src[c] });
    }
    const { values, issues } = resolveSheet(name, cells, (r, c) => dense[r]?.[c]);
    const rows: TextRow[] = [];
    let lastRow = -1;
    for (let r = 0; r < dense.length; r++) {
      const src = dense[r];
      const out: TextRow = [];
      if (src) {
        let last = -1;
        for (let c = 0; c < src.length; c++) {
          const v = src[c] ? normaliseCell(values.get(`${r}:${c}`)) : null;
          if (v != null) {
            out[c] = v;
            last = c;
          }
        }
        out.length = last + 1;
        for (let c = 0; c <= last; c++) if (out[c] === undefined) out[c] = null;
        if (last >= 0) lastRow = r;
      }
      rows.push(out);
    }
    rows.length = lastRow + 1;
    return { name, hidden: Boolean(meta[i]?.Hidden), rows, formulaIssues: issues };
  });
}

export function colIndex(letter: string): number {
  return XLSX.utils.decode_col(letter);
}

export function colLetter(index: number): string {
  return XLSX.utils.encode_col(index);
}

export function at(row: TextRow | undefined, c: number): TextCell {
  if (!row || c < 0) return null;
  return row[c] ?? null;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** "Mar 13, 2023" or "2023-03-13" → UTC midnight. Anything else → null. */
export function parseCalendarDate(s: TextCell): Date | null {
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})$/.exec(s);
  if (m && MONTHS[m[1].toLowerCase()] != null) return new Date(Date.UTC(+m[3], MONTHS[m[1].toLowerCase()], +m[2]));
  return null;
}

/** "Mar 3, 2025 10:19 AM" → timestamp (read as UTC; it is kept for
 *  traceability only and never used as a release date). */
export function parseTimestamp(s: TextCell): Date | null {
  if (!s) return null;
  const m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})(?: (\d{1,2}):(\d{2})\s*([AP]M))?$/i.exec(s);
  if (!m || MONTHS[m[1].toLowerCase()] == null) return parseCalendarDate(s);
  let h = m[4] ? +m[4] % 12 : 0;
  if (m[6] && m[6].toUpperCase() === 'PM') h += 12;
  return new Date(Date.UTC(+m[3], MONTHS[m[1].toLowerCase()], +m[2], h, m[5] ? +m[5] : 0));
}
