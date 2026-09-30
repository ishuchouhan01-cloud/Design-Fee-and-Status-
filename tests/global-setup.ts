/**
 * Builds a throwaway PostgreSQL database from the real workbooks once, then
 * every test file runs against it. This makes the migration itself part of the
 * test suite rather than a step nobody checks.
 *
 * The target is always a SEPARATE database (`<database>_test` unless
 * TEST_DATABASE_URL says otherwise) whose schema is dropped and recreated on
 * every run, so the suite can never touch working data.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { deriveTestDatabaseUrl, parseDbUrl } from '../src/lib/db-url';
import { ensureDatabaseExists, resetSchema } from '../src/lib/db-admin';

export default async function setup() {
  loadEnv();

  const testUrl = deriveTestDatabaseUrl(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
  if (!testUrl) throw new Error('No PostgreSQL DATABASE_URL / TEST_DATABASE_URL for the test suite.');

  const working = process.env.DATABASE_URL;
  if (working && parseDbUrl(working).database === parseDbUrl(testUrl).database) {
    throw new Error(
      'The test database is the same as the working database. Set TEST_DATABASE_URL to something else — the suite drops its schema.',
    );
  }

  // Workers read this from vitest.config.ts `env`; set it here too so anything
  // imported in this process talks to the same database.
  process.env.DATABASE_URL = testUrl;
  process.env.BACKUP_DIR = './data/test-backups';
  process.env.EXCEL_GOALS_WORKBOOK ??= './import/Design Goals FY26-27 trial.xlsx';
  process.env.EXCEL_PROJECT_PLAN_WORKBOOKS ??=
    './import/0118_Violet Hill_ 03YPlan_01012026 - Ph 1 trail.xlsx';

  const ensured = await ensureDatabaseExists(testUrl);
  if (ensured.created) console.log(`[tests] created database "${ensured.database}"`);
  await resetSchema(testUrl);

  fs.mkdirSync(path.resolve(process.cwd(), 'data'), { recursive: true });
  fs.rmSync(path.resolve(process.cwd(), 'data/test-backups'), { recursive: true, force: true });

  const { db, closeDb } = await import('../src/db');
  try {
    await migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
    const { seedReferenceData } = await import('../src/lib/seed');
    await seedReferenceData();

    const { runImport } = await import('../src/lib/import');
    const summary = await runImport({
      goalsWorkbook: path.resolve(process.cwd(), process.env.EXCEL_GOALS_WORKBOOK!),
      projectPlanWorkbooks: [path.resolve(process.cwd(), process.env.EXCEL_PROJECT_PLAN_WORKBOOKS!)],
      deriveDependencies: true,
      actor: { id: null, label: 'test setup' },
    });
    if (summary.errors > 0) {
      throw new Error(
        `Test fixture import produced ${summary.errors} error(s): ${JSON.stringify(
          summary.issues.filter((i) => i.severity === 'ERROR'),
        )}`,
      );
    }
    // Stashed for assertions in the migration test.
    fs.writeFileSync(
      path.resolve(process.cwd(), 'data/test-import-summary.json'),
      JSON.stringify(summary, null, 2),
    );
  } finally {
    // The setup process must not leave a pool open.
    await closeDb();
  }
}
