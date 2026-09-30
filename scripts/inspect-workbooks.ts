/**
 * Workbook inspector. Prints the full structure of one or more workbooks
 * without importing anything, so a new or changed workbook can be reviewed
 * before it is mapped.
 *
 *   npm run inspect:excel                              (everything in ./import)
 *   npm run inspect:excel -- "C:\path\to\book.xlsx"
 *   npm run inspect:excel -- --rows 60 "C:\path\book.xlsx"
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/lib/config';
import { readWorkbook, type Cell } from '../src/lib/import/workbook';
import { classifySheet } from '../src/lib/import/goals-workbook';

/** Plan-workbook sheets have their own mapper, so classify those first. */
const PLAN_SHEETS: { match: RegExp; label: string }[] = [
  { match: /^Design Fee$/i, label: 'MASTER (packages + fee weighting)' },
  { match: /^Packages deliverables$/i, label: 'MASTER (durations + deliverables)' },
  { match: /^Drawing list/i, label: 'MASTER (drawing register)' },
  { match: /^(Assumption Cost|BOQ cost)$/i, label: 'MASTER (commercial assumptions → settings)' },
];

function classify(name: string): string {
  const plan = PLAN_SHEETS.find((p) => p.match.test(name));
  if (plan) return plan.label;
  return classifySheet(name);
}

function cellText(v: Cell): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).replace(/\s+/g, ' ');
}

function main() {
  const argv = process.argv.slice(2);
  const rowsFlagIndex = argv.indexOf('--rows');
  const maxRows = rowsFlagIndex >= 0 ? Number(argv[rowsFlagIndex + 1] ?? 12) : 12;
  const explicit = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--rows');

  let files = explicit;
  if (files.length === 0) {
    if (!fs.existsSync(config.importDir)) {
      console.error(`No files given and ${config.importDir} does not exist.`);
      process.exit(1);
    }
    files = fs
      .readdirSync(config.importDir)
      .filter((f) => /\.xlsx?$/i.test(f) && !f.startsWith('~$'))
      .map((f) => path.join(config.importDir, f));
  }
  if (files.length === 0) {
    console.error('No .xlsx files to inspect.');
    process.exit(1);
  }

  for (const file of files) {
    const wb = readWorkbook(path.resolve(file));
    console.log('='.repeat(100));
    console.log(`WORKBOOK  ${wb.fileName}`);
    console.log(`SHEETS    ${wb.sheets.length} (${wb.sheets.filter((s) => s.hidden).length} hidden)`);
    console.log('='.repeat(100));

    for (const sheet of wb.sheets) {
      const nonEmpty = sheet.rows.filter((r) => r.some((c) => c != null && String(c).trim() !== ''));
      const widest = nonEmpty.reduce((m, r) => Math.max(m, r.length), 0);
      console.log('');
      console.log(
        `--- ${sheet.name}${sheet.hidden ? '  [HIDDEN]' : ''}  |  ${nonEmpty.length} non-empty rows  |  ${widest} columns  |  ${sheet.merges.length} merged ranges  |  classified: ${classify(sheet.name)}`,
      );
      if (sheet.merges.length) console.log(`    merges: ${sheet.merges.slice(0, 20).join(', ')}${sheet.merges.length > 20 ? ' …' : ''}`);
      nonEmpty.slice(0, maxRows).forEach((row, i) => {
        const cells = row
          .map((c, j) => {
            const t = cellText(c);
            if (!t) return null;
            const col = String.fromCharCode(65 + (j % 26));
            const prefix = j >= 26 ? `${String.fromCharCode(64 + Math.floor(j / 26))}${col}` : col;
            return `${prefix}:${t.slice(0, 34)}`;
          })
          .filter(Boolean);
        if (cells.length) console.log(`    R${i + 1} | ${cells.join(' ~ ')}`);
      });
      if (nonEmpty.length > maxRows) console.log(`    … ${nonEmpty.length - maxRows} more rows`);
    }
  }
  console.log('');
  console.log('Classification legend: MASTER = imported, DERIVED = recomputed by the app,');
  console.log('LEADER_VIEW = per-design-lead copy (reproduced as a filter), UNKNOWN = review before relying on it.');
}

main();
