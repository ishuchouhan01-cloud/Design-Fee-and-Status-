/**
 *   npm run backup
 *   npm run backup -- before-q3-reforecast
 */
import 'dotenv/config';

async function main() {
  const { createBackup, listBackups, backupTargetInfo, checkPgTools } = await import(
    '../src/lib/services/backup'
  );
  const label = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const info = backupTargetInfo();
  const tools = await checkPgTools();

  console.log(`Database : ${info.database}`);
  console.log(`Target   : ${info.directory} (keeping the newest ${info.retention})`);
  console.log(`Tool     : ${tools.available ? tools.version : `${tools.command} NOT AVAILABLE — ${tools.hint}`}`);
  if (!tools.available) process.exit(1);

  const file = await createBackup({ id: null, label: 'CLI backup' }, label);
  console.log(`Created  : ${file.path} (${(file.bytes / 1024).toFixed(0)} KB)`);
  console.log('\nAvailable backups:');
  for (const f of listBackups()) {
    console.log(`  ${f.createdAt.toISOString()}  ${(f.bytes / 1024).toFixed(0).padStart(7)} KB  ${f.name}`);
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    // An open pool keeps the process alive.
    const { closeDb } = await import('../src/db');
    await closeDb();
  });
