/**
 * Creates (or upgrades) the PostgreSQL database from the generated SQL
 * migrations, then seeds reference data. Safe to re-run: migrations are
 * tracked in `drizzle.__drizzle_migrations`, seeding is idempotent.
 *
 *   npm run db:setup             create / upgrade in place
 *   npm run db:reset             drop the schema first, then do the above
 *   npm run db:reset -- --force  same, against a non-local database
 */
import 'dotenv/config';
import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { config } from '../src/lib/config';
import { parseDbUrl } from '../src/lib/db-url';
import { ensureDatabaseExists, listTables, resetSchema } from '../src/lib/db-admin';

async function main() {
  const reset = process.argv.includes('--reset');
  const force = process.argv.includes('--force');
  const url = config.databaseUrl;
  const target = parseDbUrl(url);

  console.log(`Database : ${config.databaseLabel}`);

  const ensured = await ensureDatabaseExists(url);
  console.log(
    ensured.created
      ? `Created  : database "${ensured.database}" did not exist and was created`
      : `Found    : database "${ensured.database}"`,
  );

  if (reset) {
    if (target.isRemote && !force) {
      console.error(
        `\nRefusing to drop the schema on a non-local database (${target.host}/${target.database}).\n` +
          `Re-run with --force if that is genuinely what you want.`,
      );
      process.exit(1);
    }
    await resetSchema(url);
    console.log(`Reset    : schema "public" dropped and recreated`);
  }

  const { db } = await import('../src/db');
  await migrate(db, { migrationsFolder: path.resolve(config.root, 'drizzle') });
  const tables = await listTables(url);
  console.log(`Schema   : applied — ${tables.length} tables`);

  const { seedReferenceData } = await import('../src/lib/seed');
  const summary = await seedReferenceData();
  console.log(
    `Seeded   : ${summary.disciplines} disciplines, ${summary.users} users, ${summary.settings} settings`,
  );
  // Sign-in passwords (Admin, Super Admin) from .env, stored as bcrypt hashes.
  const { ensureLoginAccounts } = await import('../src/lib/login');
  const set = await ensureLoginAccounts();
  if (set.length) console.log(`Sign-in  : password set for ${set.join(', ')} (stored as a hash; the plain text can now be removed from .env)`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { closeDb } = await import('../src/db');
    await closeDb();
  });
