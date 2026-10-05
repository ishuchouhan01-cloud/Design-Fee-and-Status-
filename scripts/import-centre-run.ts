/**
 * Run Import Centre imports from the command line — the same service as the
 * Import Centre screen (upload checks, manifest, dry run, import, history,
 * undo), for a list of workbooks:
 *
 *   npm run import:centre -- data/drawing-sources/dfs-2026-import.json            dry run of every entry
 *   npm run import:centre -- data/drawing-sources/dfs-2026-import.json --apply    dry run, then import
 *   npm run import:centre -- … --only SFTW                                        one entry
 *   npm run import:centre -- … --list-only --apply                                only the Project List
 *
 * The list:
 *   { "folder": "import/dfs-2026",
 *     "imports": [ { "file": "…xlsx", "project": "SFTW" },                         an existing project (code)
 *                  { "file": "…xlsx", "newProject": { "fullName": "Phase 2c", "shortCode": "ATR-PH2C", "parent": "ATR" } },
 *                  … ],
 *     "projectList": "…xlsx" (optional, imported first) }
 *
 * Back up the database first (npm run backup). Nothing project-specific is in
 * this script; the list is data.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';

interface Entry {
  file: string;
  project?: string;
  newProject?: { fullName: string; shortCode?: string; parent?: string };
  feeSheet?: string;
  feeLayout?: 'AUTO' | 'PACKAGE_TOTAL' | 'DISCIPLINE_BLOCKS';
}

async function main() {
  const args = process.argv.slice(2);
  const listPath = args.find((a) => !a.startsWith('--'));
  if (!listPath) throw new Error('Give the import list (JSON).');
  const apply = args.includes('--apply');
  const onlyAt = args.indexOf('--only');
  const only = onlyAt >= 0 ? args[onlyAt + 1] : null;
  const listOnly = args.includes('--list-only');
  const list = JSON.parse(fs.readFileSync(listPath, 'utf8')) as { folder: string; projectList?: string; imports: Entry[] };
  const { db, closeDb } = await import('../src/db');
  const { projects } = await import('../src/db/schema');
  const { runCentreImport, storeUpload, uploadPath, validateUpload } = await import('../src/lib/import/centre');
  const actor = { id: null, label: 'Import Centre (command line)' };
  const summary: string[] = [];
  const stage = (file: string) => {
    const buf = fs.readFileSync(path.join(list.folder, file));
    const name = path.basename(file);
    validateUpload(name, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buf.length, buf);
    const up = uploadPath(storeUpload(name, buf).uploadId);
    return up;
  };
  try {
    if (list.projectList && !only) {
      const up = stage(list.projectList);
      const r = await runCentreImport({ file: up.file, fileName: up.fileName, fileType: 'PROJECT_LIST', apply: false, actor });
      console.log(`\n== Project List ${list.projectList}: create ${r.counts.create}, update ${r.counts.update}, unchanged ${r.counts.unchanged}`);
      for (const i of r.issues.filter((x) => x.code !== 'PROJECT_FULL_NAME_MISSING')) console.log(`   ${i.severity} ${i.code}: ${i.message}`);
      if (apply) {
        const a = await runCentreImport({ file: up.file, fileName: up.fileName, fileType: 'PROJECT_LIST', apply: true, actor });
        console.log(`   imported (run ${a.batchId})`);
      }
    }
    for (const e of listOnly ? [] : list.imports) {
      const key = e.project ?? e.newProject?.shortCode ?? e.file;
      if (only && key !== only) continue;
      const up = stage(e.file);
      const byCode = async (code: string) => (await db.select().from(projects).where(eq(projects.projectCode, code)).limit(1))[0] ?? null;
      let projectId: string | null = null;
      let newProject = null as null | { fullName: string; shortCode: string | null; parentProjectId: string | null };
      const existing = e.project ? await byCode(e.project) : e.newProject?.shortCode ? await byCode(e.newProject.shortCode.toUpperCase()) : null;
      if (existing) projectId = existing.id;
      else if (e.project) throw new Error(`Project ${e.project} not found.`);
      else if (e.newProject) {
        const parent = e.newProject.parent ? await byCode(e.newProject.parent) : null;
        if (e.newProject.parent && !parent) throw new Error(`Parent ${e.newProject.parent} not found.`);
        newProject = { fullName: e.newProject.fullName, shortCode: e.newProject.shortCode ?? null, parentProjectId: parent?.id ?? null };
      }
      const mapping = { feeSheet: e.feeSheet ?? null, feeLayout: e.feeLayout ?? null };
      const input = { file: up.file, fileName: up.fileName, fileType: 'PLAN' as const, projectId, newProject, mapping, actor };
      const dry = await runCentreImport({ ...input, apply: false });
      const pv = dry.preview as { drawings?: number; released?: number; packages?: number; headings?: number; linked?: number; sheets?: { sheet: string; rows: number; layout?: string }[] };
      const fee = pv.sheets?.find((s) => s.layout);
      console.log(`\n== ${e.file} → ${dry.project?.name}`);
      console.log(`   dry run: drawings ${pv.drawings ?? '?'} (released ${pv.released ?? '?'}), packages ${pv.packages ?? '?'}, headings ${pv.headings ?? '?'}, linked ${pv.linked ?? '?'}; Design Fee sheet ${fee ? `"${fee.sheet}" (${fee.layout})` : '—'}`);
      console.log(`   create ${dry.counts.create}, update ${dry.counts.update}, unchanged ${dry.counts.unchanged}, conflicts ${dry.counts.conflicts}, ambiguous ${dry.counts.ambiguous}, skipped ${dry.counts.skipped}`);
      const tally = new Map<string, number>();
      for (const i of dry.issues) tally.set(`${i.severity} ${i.code}`, (tally.get(`${i.severity} ${i.code}`) ?? 0) + 1);
      console.log(`   issues: ${[...tally].map(([k, v]) => `${k} ×${v}`).join(', ') || 'none'}`);
      for (const i of dry.issues.filter((x) => /WITHOUT_FEE_PACKAGE|LAYOUT_NOT_READ|AMBIGUOUS|DUPLICATE_PACKAGE/.test(x.code))) console.log(`     - ${i.code}: ${i.message}`);
      let line = `${e.file}: dry run ${pv.drawings} drawings / ${pv.packages} packages / ${pv.linked} linked`;
      if (apply) {
        const r = await runCentreImport({ ...input, apply: true });
        const ap = r.preview as { drawings?: number; packages?: number; linked?: number };
        console.log(`   IMPORTED run ${r.batchId}: created ${r.counts.create}, updated ${r.counts.update}; drawings ${ap.drawings}, packages ${ap.packages}, linked ${ap.linked}`);
        line += ` → imported (run ${r.batchId}, project ${r.project?.name})`;
      }
      summary.push(line);
    }
    console.log(`\n${summary.join('\n')}`);
  } finally {
    await closeDb();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
