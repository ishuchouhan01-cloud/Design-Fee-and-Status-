/**
 * Database backup and restore — PostgreSQL.
 *
 * Uses `pg_dump` in PostgreSQL's custom format (`-Fc`), which is consistent
 * (it runs in a single transaction snapshot), compressed, and restorable with
 * `pg_restore` selectively. The backup directory is configurable and must not
 * be a synchronised cloud folder — see README → Backup.
 *
 * This replaces the SQLite online-backup API used during the pilot. The public
 * shape of this module is unchanged, so nothing that calls it had to move.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '@/lib/config';
import { parseDbUrl } from '@/lib/db-url';
import { recordAudit, type Actor } from '@/lib/audit';

const run = promisify(execFile);

/** PostgreSQL's own extension for custom-format dumps. */
const EXT = '.dump';

export interface BackupFile {
  name: string;
  path: string;
  bytes: number;
  createdAt: Date;
}

/**
 * Locate a PostgreSQL client binary. On Windows these are not on PATH by
 * default, so `PG_BIN_DIR` points at e.g.
 * C:\Program Files\PostgreSQL\17\bin
 */
export function pgTool(name: 'pg_dump' | 'pg_restore' | 'psql'): string {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  return config.pgBinDir ? path.join(config.pgBinDir, exe) : exe;
}

export interface PgToolStatus {
  available: boolean;
  version?: string;
  command: string;
  hint?: string;
}

/**
 * Checked up front so the Settings screen can say "pg_dump is not on PATH"
 * instead of failing when someone presses the button.
 */
export async function checkPgTools(): Promise<PgToolStatus> {
  const command = pgTool('pg_dump');
  try {
    const { stdout } = await run(command, ['--version']);
    return { available: true, version: stdout.trim(), command };
  } catch {
    return {
      available: false,
      command,
      hint:
        process.platform === 'win32'
          ? 'Set PG_BIN_DIR in .env to your PostgreSQL bin folder, e.g. C:\\Program Files\\PostgreSQL\\17\\bin'
          : 'Install the postgresql-client package, or set PG_BIN_DIR in .env.',
    };
  }
}

export function listBackups(): BackupFile[] {
  if (!fs.existsSync(config.backupDir)) return [];
  return fs
    .readdirSync(config.backupDir)
    .filter((f) => f.endsWith(EXT))
    .map((name) => {
      const full = path.join(config.backupDir, name);
      const st = fs.statSync(full);
      return { name, path: full, bytes: st.size, createdAt: st.mtime };
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export async function createBackup(actor: Actor, label?: string): Promise<BackupFile> {
  const tools = await checkPgTools();
  if (!tools.available) {
    throw new Error(`${tools.command} could not be run. ${tools.hint}`);
  }
  fs.mkdirSync(config.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = label ? `-${label.replace(/[^a-z0-9-]/gi, '')}` : '';
  const name = `design-control-${stamp}${suffix}${EXT}`;
  const target = path.join(config.backupDir, name);

  // The connection URI is the last positional argument, so the password never
  // appears in an environment variable or a separate flag.
  await run(pgTool('pg_dump'), [
    '--format=custom',
    '--no-owner',
    '--no-privileges',
    '--file',
    target,
    config.databaseUrl,
  ]);

  if (!fs.existsSync(target) || fs.statSync(target).size === 0) {
    throw new Error('pg_dump produced no output — the backup was not created.');
  }
  pruneBackups();
  const st = fs.statSync(target);
  await recordAudit({
    actor,
    entityType: 'DATABASE',
    entityId: name,
    action: 'BACKUP',
    newValue: `${st.size} bytes`,
    reason: label ?? 'Manual backup',
  });
  return { name, path: target, bytes: st.size, createdAt: st.mtime };
}

/**
 * Restore a dump over the current database.
 *
 * `--clean --if-exists` drops the existing objects first, so this REPLACES the
 * data. The caller is responsible for warning the user; `scripts/restore.ts`
 * takes a fresh backup first.
 */
export async function restoreBackup(file: string): Promise<{ warnings: string }> {
  const tools = await checkPgTools();
  if (!tools.available) throw new Error(`${tools.command} could not be run. ${tools.hint}`);
  if (!fs.existsSync(file)) throw new Error(`Backup file not found: ${file}`);
  try {
    const { stderr } = await run(pgTool('pg_restore'), [
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
      '--single-transaction',
      '--dbname',
      config.databaseUrl,
      file,
    ]);
    return { warnings: stderr.trim() };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(`pg_restore failed: ${(e.stderr ?? e.message ?? '').trim()}`);
  }
}

/** List what is inside a dump, without restoring it. Used to verify a backup. */
export async function inspectBackup(file: string): Promise<string[]> {
  const { stdout } = await run(pgTool('pg_restore'), ['--list', file]);
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith(';'));
}

function pruneBackups() {
  const keep = config.backupRetention;
  if (!keep || keep <= 0) return;
  for (const f of listBackups().slice(keep)) fs.rmSync(f.path);
}

export function backupTargetInfo() {
  const parsed = (() => {
    try {
      return parseDbUrl(config.databaseUrl);
    } catch {
      return null;
    }
  })();
  return {
    directory: config.backupDir,
    retention: config.backupRetention,
    database: config.databaseLabel,
    databaseName: parsed?.database ?? 'unknown',
    host: parsed ? `${parsed.host}:${parsed.port}` : 'unknown',
    isRemote: parsed?.isRemote ?? false,
    exists: fs.existsSync(config.backupDir),
    format: 'PostgreSQL custom format (pg_dump -Fc)',
  };
}
