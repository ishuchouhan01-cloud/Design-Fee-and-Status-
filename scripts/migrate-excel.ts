/**
 * Excel → database migration CLI.
 *
 *   npm run migrate:excel
 *   npm run migrate:excel -- --goals "path/to/Design Goals FY26-27 trial.xlsx" \
 *                            --plan "path/to/0118 Violet Hill 03YPlan.xlsx"
 *   npm run migrate:excel -- --dir ./import        (all .xlsx in a folder)
 *
 * Paths come from the command line or from .env. Nothing is hard-coded.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/lib/config';

function argValues(flag: string): string[] {
  const out: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flag && argv[i + 1]) out.push(argv[i + 1]);
  }
  return out;
}

function looksLikeGoalsWorkbook(file: string): boolean {
  return /goal/i.test(path.basename(file));
}

async function main() {
  const { runImport, formatSummary } = await import('../src/lib/import');

  let goals = argValues('--goals')[0] ?? config.goalsWorkbook;
  let plans = argValues('--plan');
  const dirs = argValues('--dir');
  const scanDirs = dirs.length ? dirs : plans.length || goals ? [] : [config.importDir];

  for (const dir of scanDirs) {
    if (!fs.existsSync(dir)) {
      console.error(`Import folder not found: ${dir}`);
      continue;
    }
    for (const entry of fs.readdirSync(dir)) {
      if (!/\.xlsx?$/i.test(entry) || entry.startsWith('~$')) continue;
      const full = path.join(dir, entry);
      if (looksLikeGoalsWorkbook(entry)) {
        if (!goals) goals = full;
      } else {
        plans.push(full);
      }
    }
  }
  if (config.projectPlanWorkbooks.length && plans.length === 0) {
    plans = config.projectPlanWorkbooks.filter((p) => fs.existsSync(p));
  }

  const missing = [goals, ...plans].filter((p): p is string => Boolean(p)).filter((p) => !fs.existsSync(p));
  if (missing.length) {
    console.error('These workbook paths do not exist:');
    for (const m of missing) console.error(`  ${m}`);
    process.exit(1);
  }
  if (!goals && plans.length === 0) {
    console.error(
      'Nothing to import. Put the workbooks in ./import, or pass --goals / --plan / --dir, or set EXCEL_GOALS_WORKBOOK.',
    );
    process.exit(1);
  }

  const summary = await runImport({
    goalsWorkbook: goals,
    projectPlanWorkbooks: plans,
    deriveDependencies: process.env.IMPORT_DERIVE_PACKAGE_LINKS !== 'false',
    actor: { id: null, label: 'Excel migration (CLI)' },
  });
  console.log(formatSummary(summary));

  const reportDir = path.resolve(config.root, 'import-reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(reportDir, `import-${stamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2));
  console.log(`\nFull import log written to ${reportPath}`);
  if (summary.errors > 0) process.exitCode = 2;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // An open connection pool would keep the process alive.
    const { closeDb } = await import('../src/db');
    await closeDb();
  });
