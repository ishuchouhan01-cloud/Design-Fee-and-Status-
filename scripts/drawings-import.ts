/**
 * Drawing Register importer CLI.
 *
 *   npm run drawings:import                preview — reads everything, writes no drawing data
 *   npm run drawings:import -- --preview   same, stated explicitly
 *   npm run drawings:import -- --apply     import (one transaction; refused unless every
 *                                          validation target matches)
 *   npm run drawings:import -- --manifest data/drawing-sources/<name>.json
 *
 * The manifest comes from --manifest, then DRAWING_MANIFEST, then
 * data/drawing-sources/poarr.json. No path is hard-coded to any machine.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { closeDb } from '../src/db';
import { formatDrawingImportSummary, runDrawingImport } from '../src/lib/import/drawing-register';

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  if (apply && argv.includes('--preview')) {
    console.error('--preview and --apply are mutually exclusive. Run the preview first, then --apply on its own.');
    process.exitCode = 1;
    return;
  }
  const mi = argv.indexOf('--manifest');
  const manifestPath = mi >= 0 ? argv[mi + 1] : undefined;
  const result = await runDrawingImport({ apply, manifestPath, actor: { id: null, label: 'Drawing import (CLI)' } });
  console.log(formatDrawingImportSummary(result));

  const dir = path.resolve(process.cwd(), 'import-reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `drawings-${result.mode.toLowerCase()}-${result.batchId}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(`\nFull report: ${path.relative(process.cwd(), file)}`);
  if (!result.valid) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
