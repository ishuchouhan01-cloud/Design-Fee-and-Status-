/**
 * Project List import (full display names and the parent → child hierarchy).
 *
 *   npm run projects:import                 preview data/project-sources/project-list.xlsx
 *   npm run projects:import -- --apply      import it
 *   npm run projects:import -- --file <path.xlsx> [--apply]
 */
import 'dotenv/config';
import path from 'node:path';
import { runCentreImport } from '../src/lib/import/centre';

async function main() {
  const argv = process.argv.slice(2);
  const fi = argv.indexOf('--file');
  const file = path.resolve(fi >= 0 ? argv[fi + 1] : 'data/project-sources/project-list.xlsx');
  const r = await runCentreImport({ file, fileName: path.basename(file), fileType: 'PROJECT_LIST', apply: argv.includes('--apply'), actor: { id: null, label: 'Project List import (CLI)' } });
  console.log(JSON.stringify({ mode: r.mode, batchId: r.batchId, counts: r.counts, issues: r.issues.map((i) => `${i.code}: ${i.message}`), items: r.preview }, null, 2));
  process.exit(0);
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
