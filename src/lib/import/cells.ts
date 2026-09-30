/**
 * Cell values as the workbook shows them, the same on every computer.
 *
 * Dates. SheetJS turns a date serial into a JavaScript Date in the computer's
 * local time zone. East of UTC (India is UTC+5:30) that Date falls on the
 * previous day in UTC — 17-Aug-2026 was read as 16-Aug-2026. So dates are
 * read as their serial number and converted with the time-zone-free
 * `SSF.parse_date_code`, giving the calendar date that was typed in the cell.
 *
 * Formulas. A formula cell gives its cached value. A formula with no cached
 * value — including a formula typed into a cell formatted as Text, which
 * Excel shows as "=CONCATENATE(B26,"-",C26,"-",D26)" — is worked out from the
 * cells it refers to. When that is not possible the value is empty and the
 * cell is reported; text starting with "=" is never passed on as a value.
 */
import * as XLSX from 'xlsx';

export interface RawCell {
  t?: string;
  v?: unknown;
  f?: string;
  z?: string | number;
  w?: string;
}

export interface FormulaIssue {
  sheet: string;
  row: number; // 1-based
  col: number; // 0-based
  formula: string;
  reason: string;
}

export type CellValue = string | number | boolean | Date | null;

/** A date-formatted number → UTC midnight of the calendar date (time kept when there is one). */
export function serialToDate(serial: number): Date | null {
  const p = XLSX.SSF.parse_date_code(serial);
  if (!p || !p.y) return null;
  return new Date(Date.UTC(p.y, p.m - 1, p.d, p.H ?? 0, p.M ?? 0, Math.round(p.S ?? 0)));
}

export function isDateCell(c: RawCell): boolean {
  if (c.t === 'd') return true;
  if (c.t !== 'n' || typeof c.v !== 'number') return false;
  const z = typeof c.z === 'string' ? c.z : typeof c.z === 'number' ? (XLSX.SSF.get_table()[c.z] as string | undefined) : undefined;
  return Boolean(z && XLSX.SSF.is_date(z));
}

// ---------------------------------------------------------------------------
// A small formula evaluator: references, text, numbers, &, CONCATENATE /
// CONCAT, TRIM, UPPER, LOWER, TEXT(x, "000…"). Enough for the number and code
// columns registers build from other columns; anything else is not guessed.
// ---------------------------------------------------------------------------

class FormulaError extends Error {}

type Token = { k: 'str' | 'num' | 'ref' | 'fn' | '(' | ')' | ',' | '&'; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"') {
      let s = '';
      i++;
      for (;;) {
        if (i >= src.length) throw new FormulaError('unterminated text');
        if (src[i] === '"') {
          if (src[i + 1] === '"') {
            s += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += src[i++];
      }
      out.push({ k: 'str', v: s });
      continue;
    }
    if ('(),&'.includes(ch)) {
      out.push({ k: ch as Token['k'], v: ch });
      i++;
      continue;
    }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ k: 'num', v: num[0] });
      i += num[0].length;
      continue;
    }
    const word = /^\$?[A-Za-z]{1,3}\$?\d+|^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i));
    if (word) {
      const w = word[0];
      i += w.length;
      if (/^\$?[A-Za-z]{1,3}\$?\d+$/.test(w) && src[i] !== '(') out.push({ k: 'ref', v: w.replace(/\$/g, '').toUpperCase() });
      else out.push({ k: 'fn', v: w.toUpperCase() });
      continue;
    }
    throw new FormulaError(`cannot read "${src.slice(i, i + 10)}"`);
  }
  return out;
}

type V = string | number;

function evaluate(tokens: Token[], ref: (a1: string) => V | null): V {
  let p = 0;
  const peek = () => tokens[p];
  const expect = (k: Token['k']) => {
    if (tokens[p]?.k !== k) throw new FormulaError(`expected ${k}`);
    p++;
  };
  const asText = (v: V) => (typeof v === 'number' ? String(v) : v);
  const primary = (): V => {
    const t = tokens[p++];
    if (!t) throw new FormulaError('unexpected end');
    if (t.k === 'str') return t.v;
    if (t.k === 'num') return Number(t.v);
    if (t.k === 'ref') {
      const v = ref(t.v);
      return v == null ? '' : v;
    }
    if (t.k === '(') {
      const v = concat();
      expect(')');
      return v;
    }
    if (t.k === 'fn') {
      expect('(');
      const args: V[] = [];
      if (peek()?.k !== ')') {
        args.push(concat());
        while (peek()?.k === ',') {
          p++;
          args.push(concat());
        }
      }
      expect(')');
      switch (t.v) {
        case 'CONCATENATE':
        case 'CONCAT':
          return args.map(asText).join('');
        case 'TRIM':
          return asText(args[0] ?? '').trim().replace(/\s+/g, ' ');
        case 'UPPER':
          return asText(args[0] ?? '').toUpperCase();
        case 'LOWER':
          return asText(args[0] ?? '').toLowerCase();
        case 'TEXT': {
          const fmt = asText(args[1] ?? '');
          if (!/^0+$/.test(fmt)) throw new FormulaError(`TEXT format "${fmt}" is not supported`);
          const n = Number(args[0]);
          if (!Number.isFinite(n)) return asText(args[0] ?? '');
          return String(Math.round(n)).padStart(fmt.length, '0');
        }
        default:
          throw new FormulaError(`function ${t.v} is not supported`);
      }
    }
    throw new FormulaError(`unexpected ${t.v}`);
  };
  const concat = (): V => {
    let v = primary();
    while (peek()?.k === '&') {
      p++;
      v = asText(v) + asText(primary());
    }
    return v;
  };
  const v = concat();
  if (p !== tokens.length) throw new FormulaError('unexpected text after the formula');
  return v;
}

/**
 * Work out a formula from the values of the cells it refers to. `ref`
 * returns a referenced cell's value (already resolved). Throws with a reason
 * when the formula cannot be worked out.
 */
export function evaluateFormula(formula: string, ref: (a1: string) => V | null): V {
  const src = formula.replace(/^=/, '');
  if (/!/.test(src)) throw new FormulaError('refers to another sheet');
  return evaluate(tokenize(src), ref);
}

/**
 * Resolve every cell of a sheet in place: dates to UTC calendar dates,
 * formulas to their value (cached, or worked out), formula text that cannot
 * be worked out to empty. Returns the cells that could not be worked out.
 *
 * `get(r, c)` / `set(r, c, value)` address the sheet (0-based), so this works
 * for SheetJS dense and sparse sheets alike.
 */
export function resolveSheet(
  sheet: string,
  cells: { r: number; c: number; cell: RawCell }[],
  get: (r: number, c: number) => RawCell | undefined,
): { values: Map<string, CellValue>; issues: FormulaIssue[] } {
  const values = new Map<string, CellValue>();
  const issues: FormulaIssue[] = [];
  const key = (r: number, c: number) => `${r}:${c}`;
  const busy = new Set<string>();

  const valueOf = (r: number, c: number): CellValue => {
    const k = key(r, c);
    if (values.has(k)) return values.get(k)!;
    const cell = get(r, c);
    if (!cell) return null;
    if (cell.t === 'e') {
      values.set(k, null);
      return null;
    }
    let v: CellValue;
    const formulaText = typeof cell.v === 'string' && /^=[A-Za-z(]/.test(cell.v.trim()) ? cell.v.trim() : null;
    if (cell.f && cell.v !== undefined && cell.v !== null && !formulaText) {
      v = isDateCell(cell) ? serialToDate(Number(cell.v)) : (cell.v as CellValue);
    } else if (cell.f || formulaText) {
      const formula = cell.f ? `=${cell.f}` : formulaText!;
      if (busy.has(k)) {
        issues.push({ sheet, row: r + 1, col: c, formula, reason: 'refers to itself' });
        return null;
      }
      busy.add(k);
      try {
        const out = evaluateFormula(formula, (a1) => {
          const { r: rr, c: cc } = XLSX.utils.decode_cell(a1);
          const x = valueOf(rr, cc);
          if (x instanceof Date) return x.toISOString().slice(0, 10);
          if (typeof x === 'boolean') return x ? 'TRUE' : 'FALSE';
          return x;
        });
        v = out;
      } catch (e) {
        issues.push({ sheet, row: r + 1, col: c, formula, reason: e instanceof Error ? e.message : String(e) });
        v = null;
      } finally {
        busy.delete(k);
      }
    } else if (isDateCell(cell)) {
      v = cell.v instanceof Date ? cell.v : serialToDate(Number(cell.v));
    } else {
      v = cell.v === undefined ? null : (cell.v as CellValue);
    }
    values.set(k, v);
    return v;
  };

  for (const { r, c } of cells) valueOf(r, c);
  return { values, issues };
}
