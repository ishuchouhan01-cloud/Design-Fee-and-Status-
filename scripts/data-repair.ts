/**
 * Controlled data repair — one-time corrections of data an earlier version
 * imported wrongly. Each repair runs once per database (recorded in
 * app_settings), after the launcher has backed the database up, and writes a
 * report to import-reports/.
 *
 *   npm run data:repair              run the repairs this database has not had
 *   npm run data:repair -- --check   say whether any are pending (exit 0; prints PENDING or NONE)
 *   npm run data:repair -- --force   run them again
 *
 * Repair 2026-09-30 (hierarchy, dates, formula text):
 *   1. the bundled Project List (data/project-sources/project-list.xlsx) —
 *      display names and the project → tower hierarchy;
 *   2. every drawing-source manifest (data/drawing-sources/*.json) re-imported
 *      with the corrected readers: dates read without a time-zone shift, the
 *      source date / period stored for "Updated On", formula text worked out.
 * Imports never undo a release, never change a user-edited field and keep
 * every drawing id, revision and history row.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { eq, inArray, sql } from 'drizzle-orm';
import { closeDb, db } from '../src/db';
import { appSettings, drawings, projects } from '../src/db/schema';
import { runCentreImport } from '../src/lib/import/centre';
import { runDrawingImport } from '../src/lib/import/drawing-register';
import { loadManifest, manifestProjectCodes } from '../src/lib/import/drawing-register/manifest';
import { buildDfsModel, modelTotals } from '../src/lib/services/dfs';

const KEY = 'data_repairs';
const REPAIRS = ['2026-09-30-hierarchy-dates-formulas'] as const;
const ACTOR = { id: null, label: 'Data repair' };

async function applied(): Promise<string[]> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, KEY)).limit(1);
  try {
    return row ? (JSON.parse(row.value) as string[]) : [];
  } catch {
    return [];
  }
}

async function markApplied(ids: string[]) {
  const value = JSON.stringify(ids);
  await db
    .insert(appSettings)
    .values({ key: KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
}

/** What the repair is judged by: the DFS header, its top rows, dates and formula text. */
async function snapshot() {
  const model = await buildDfsModel({});
  const totals = modelTotals(model);
  const [d] = await db
    .select({
      total: sql<number>`count(*)::int`,
      withSourceDate: sql<number>`count(${drawings.sourceDate})::int`,
      withPeriod: sql<number>`(count(*) filter (where ${drawings.sourceDate} is null and ${drawings.sourcePeriodLabel} is not null))::int`,
      noDate: sql<number>`(count(*) filter (where ${drawings.editedAt} is null and ${drawings.sourceDate} is null and ${drawings.sourcePeriodLabel} is null))::int`,
      noDateReleased: sql<number>`(count(*) filter (where ${drawings.completionStatus} = 'COMPLETED' and ${drawings.editedAt} is null and ${drawings.sourceDate} is null and ${drawings.sourcePeriodLabel} is null))::int`,
      formulaText: sql<number>`(count(*) filter (where ${drawings.drawingCode} like '=%' or ${drawings.drawingNumber} like '=%' or ${drawings.drawingName} like '=%'))::int`,
    })
    .from(drawings);
  return {
    header: { packagesComplete: totals.packagesComplete, packagesTotal: totals.packagesTotal, drawingsReleased: totals.drawingsReleased, drawingsTotal: totals.drawingsTotal },
    topRows: model.roots.map((k) => {
      const r = model.rows.get(k)!;
      return { name: r.name, packages: `${r.packagesComplete} of ${r.packagesTotal}`, drawings: `${r.drawingsReleased} of ${r.drawingsTotal}` };
    }),
    drawings: d,
  };
}

async function repairHierarchyDatesFormulas() {
  const steps: { step: string; ok: boolean; detail: string }[] = [];
  const list = path.resolve('data/project-sources/project-list.xlsx');
  if (fs.existsSync(list)) {
    try {
      const r = await runCentreImport({ file: list, fileName: path.basename(list), fileType: 'PROJECT_LIST', apply: true, actor: ACTOR });
      steps.push({ step: 'Project List', ok: true, detail: JSON.stringify(r.counts) });
    } catch (e) {
      steps.push({ step: 'Project List', ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  }
  const dir = path.resolve('data/drawing-sources');
  const manifests = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
  for (const f of manifests) {
    const manifestPath = path.join('data/drawing-sources', f);
    try {
      const { manifest } = loadManifest(manifestPath);
      // Only a database that already holds these projects' drawings is repaired;
      // a new database gets them from its first import, with the same code.
      const codes = manifestProjectCodes(manifest);
      const prj = await db.select({ id: projects.id }).from(projects).where(inArray(projects.projectCode, codes));
      const [{ n }] = prj.length
        ? await db.select({ n: sql<number>`count(*)::int` }).from(drawings).where(inArray(drawings.projectId, prj.map((p) => p.id)))
        : [{ n: 0 }];
      if (prj.length < codes.length || n === 0) {
        steps.push({ step: manifest.name, ok: true, detail: 'skipped — not imported in this database yet' });
        continue;
      }
      const r = await runDrawingImport({ apply: true, manifestPath, actor: ACTOR });
      steps.push({ step: manifest.name, ok: true, detail: `batch ${r.batchId}: ${JSON.stringify(r.changes)}` });
    } catch (e) {
      steps.push({ step: f, ok: false, detail: e instanceof Error ? e.message.split('\n')[0] : String(e) });
    }
  }
  return steps;
}

async function main() {
  const argv = process.argv.slice(2);
  const done = await applied();
  const pending = argv.includes('--force') ? [...REPAIRS] : REPAIRS.filter((r) => !done.includes(r));
  if (argv.includes('--check')) {
    console.log(pending.length ? `PENDING ${pending.join(', ')}` : 'NONE');
    return;
  }
  if (!pending.length) {
    console.log('No data repairs pending.');
    return;
  }
  const before = await snapshot();
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), before };
  let allOk = true;
  for (const id of pending) {
    const steps = await repairHierarchyDatesFormulas();
    report[id] = steps;
    for (const s of steps) console.log(`  ${s.ok ? 'done' : 'FAILED'}  ${s.step} — ${s.detail}`);
    if (steps.some((s) => !s.ok)) allOk = false;
  }
  const after = await snapshot();
  report.after = after;
  report.finishedAt = new Date().toISOString();
  const out = path.resolve('import-reports');
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, `data-repair-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  const h = (x: typeof before) => `${x.header.packagesComplete} of ${x.header.packagesTotal} packages complete, ${x.header.drawingsReleased} of ${x.header.drawingsTotal} drawings released`;
  console.log(`  Before: ${h(before)}; top rows: ${before.topRows.map((r) => r.name).join(', ')}`);
  console.log(`  After:  ${h(after)}; top rows: ${after.topRows.map((r) => r.name).join(', ')}`);
  console.log(`  Drawings with no date or period: ${after.drawings.noDate} (released: ${after.drawings.noDateReleased}); formula text: ${after.drawings.formulaText}`);
  console.log(`  Report: ${path.relative(process.cwd(), file)}`);
  if (allOk) await markApplied([...new Set([...done, ...pending])]);
  else process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
