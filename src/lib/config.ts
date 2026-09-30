/**
 * All environment-driven configuration lives here. No user-specific or
 * OS-specific paths appear anywhere else in the codebase.
 */
import path from 'node:path';
import { deriveTestDatabaseUrl, isPostgresUrl, redact } from './db-url';

const root = process.cwd();

function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(root, p);
}

function splitList(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function requiredDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env and set it to your PostgreSQL connection string, e.g. postgresql://postgres:password@localhost:5432/design_control',
    );
  }
  if (!isPostgresUrl(url)) {
    throw new Error(
      `DATABASE_URL must be a PostgreSQL connection string (postgresql://…). Found: ${redact(url)}. This application moved from SQLite to PostgreSQL — see README §4.`,
    );
  }
  return url;
}

export const config = {
  root,
  /** PostgreSQL connection string. Validated on first use, not at import. */
  get databaseUrl(): string {
    return requiredDatabaseUrl();
  },
  /** Safe to print in logs and on screen — the password is masked. */
  get databaseLabel(): string {
    return redact(process.env.DATABASE_URL);
  },
  /** The separate database the test suite uses. Never the working database. */
  get testDatabaseUrl(): string | undefined {
    return deriveTestDatabaseUrl(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
  },
  dbPoolMax: Number(process.env.DB_POOL_MAX ?? 10),
  dbSsl: (process.env.DB_SSL ?? 'false').toLowerCase() === 'true',
  /** Folder holding the PostgreSQL client binaries, when they are not on PATH. */
  pgBinDir: process.env.PG_BIN_DIR?.trim() || undefined,
  backupDir: resolveFromRoot(process.env.BACKUP_DIR ?? './backups'),
  backupRetention: Number(process.env.BACKUP_RETENTION ?? 20),
  importDir: resolveFromRoot(process.env.IMPORT_DIR ?? './import'),
  goalsWorkbook: process.env.EXCEL_GOALS_WORKBOOK
    ? resolveFromRoot(process.env.EXCEL_GOALS_WORKBOOK)
    : undefined,
  projectPlanWorkbooks: splitList(process.env.EXCEL_PROJECT_PLAN_WORKBOOKS).map(resolveFromRoot),
  /** Sign-in: the Project Drawing Status login screen (Viewer, Admin, Super Admin). */
  authProvider: 'session',
  devUserEmail: process.env.DEV_USER_EMAIL ?? 'admin@company.local',
  appBaseUrl: process.env.APP_BASE_URL ?? 'http://localhost:3000',
  /** Fiscal year starts in April (Indian FY). Configurable for other regions. */
  fiscalYearStartMonth: Number(process.env.FISCAL_YEAR_START_MONTH ?? 4),
  /** "Due soon" horizon for schedule status, in days. */
  dueSoonDays: Number(process.env.DUE_SOON_DAYS ?? 14),
} as const;

export function resolvePath(p: string): string {
  return resolveFromRoot(p);
}
