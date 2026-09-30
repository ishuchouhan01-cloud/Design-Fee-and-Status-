import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { deriveTestDatabaseUrl } from './src/lib/db-url';

loadEnv();

/**
 * The suite NEVER runs against the working database. It uses
 * TEST_DATABASE_URL, or `<database>_test` on the same server, and
 * `tests/global-setup.ts` creates it and resets its schema on every run.
 */
const testDatabaseUrl = deriveTestDatabaseUrl(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
if (!testDatabaseUrl) {
  throw new Error(
    'Cannot work out a test database. Set DATABASE_URL to a PostgreSQL connection string (the suite will use <database>_test), or set TEST_DATABASE_URL explicitly.',
  );
}

/**
 * Test files run one at a time in ALPHABETICAL order. Several files build on
 * the state an earlier one leaves (fy26-import → fy26-rollback, drawings-a →
 * drawings-b → drawings-c); the default sequencer orders by cached duration,
 * which would make that order depend on the previous run.
 */
class AlphabeticalSequencer extends BaseSequencer {
  async sort(files: TestSpecification[]) {
    return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
}

export default defineConfig({
  test: {
    globalSetup: ['./tests/global-setup.ts'],
    setupFiles: ['./tests/setup-auth.ts'],
    fileParallelism: false,
    sequence: { sequencer: AlphabeticalSequencer },
    env: {
      DATABASE_URL: testDatabaseUrl,
      EXCEL_GOALS_WORKBOOK: process.env.EXCEL_GOALS_WORKBOOK ?? './import/Design Goals FY26-27 trial.xlsx',
      EXCEL_PROJECT_PLAN_WORKBOOKS:
        process.env.EXCEL_PROJECT_PLAN_WORKBOOKS ??
        './import/0118_Violet Hill_ 03YPlan_01012026 - Ph 1 trail.xlsx',
      BACKUP_DIR: './data/test-backups',
      PG_BIN_DIR: process.env.PG_BIN_DIR ?? '',
      TZ: 'UTC',
    },
    testTimeout: 180_000,
    hookTimeout: 180_000,
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
});
