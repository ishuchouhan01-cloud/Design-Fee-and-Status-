/**
 * Restore a dump over the current database. This REPLACES the data.
 *
 *   npm run restore -- --latest
 *   npm run restore -- design-control-2026-09-11T10-00-00-000Z.dump
 *
 * A fresh backup of the current state is taken first, so a mistaken restore is
 * recoverable. Restoring into a non-local database additionally requires
 * --force, so a production database cannot be overwritten by a typo.
 */
import 'dotenv/config';
import { config } from '../src/lib/config';
import { parseDbUrl } from '../src/lib/db-url';

async function main() {
  const { listBackups, restoreBackup, createBackup, checkPgTools } = await import(
    '../src/lib/services/backup'
  );
  const args = process.argv.slice(2);
  const wantLatest = args.includes('--latest');
  const force = args.includes('--force');
  const named = args.find((a) => !a.startsWith('--'));

  const tools = await checkPgTools();
  if (!tools.available) {
    console.error(`${tools.command} could not be run. ${tools.hint}`);
    process.exit(1);
  }

  const backups = listBackups();
  if (backups.length === 0) {
    console.error(`No backups found in ${config.backupDir}`);
    process.exit(1);
  }
  const chosen = wantLatest ? backups[0] : backups.find((b) => b.name === named);
  if (!chosen) {
    console.error('Specify a backup file name, or --latest. Available:');
    for (const b of backups) console.error(`  ${b.name}`);
    process.exit(1);
  }

  const target = parseDbUrl(config.databaseUrl);
  if (target.isRemote && !force) {
    console.error(
      `Refusing to restore into a non-local database (${target.host}/${target.database}) without --force.`,
    );
    process.exit(1);
  }

  console.log(`Restoring ${chosen.name} into ${config.databaseLabel}`);
  console.log('Taking a safety backup of the current state first…');
  const safety = await createBackup({ id: null, label: 'CLI restore' }, 'before-restore');
  console.log(`  saved ${safety.name}`);

  const { warnings } = await restoreBackup(chosen.path);
  if (warnings) console.log(`pg_restore notes:\n${warnings}`);
  console.log(`Restored ${chosen.name}`);
  console.log('Restart the application so it reconnects.');
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { closeDb } = await import('../src/db');
    await closeDb();
  });
