/**
 * PostgreSQL connection-string helpers.
 *
 * Kept free of other imports so both `src/lib/config.ts` and
 * `vitest.config.ts` can use them.
 */

export interface ParsedDbUrl {
  host: string;
  port: number;
  database: string;
  user: string;
  /** true when the host is not this machine — used to guard destructive commands */
  isRemote: boolean;
  /** connection string with the password replaced, safe to print or log */
  redacted: string;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '', 'host.docker.internal']);

export function isPostgresUrl(url: string | undefined): boolean {
  return Boolean(url && /^postgres(ql)?:\/\//i.test(url));
}

export function parseDbUrl(url: string): ParsedDbUrl {
  const u = new URL(url);
  const database = decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres';
  const redactedUrl = new URL(url);
  if (redactedUrl.password) redactedUrl.password = '***';
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    database,
    user: decodeURIComponent(u.username),
    isRemote: !LOCAL_HOSTS.has(u.hostname.toLowerCase()),
    redacted: redactedUrl.toString(),
  };
}

/** Same server, different database — used for the test database and for CREATE DATABASE. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(database)}`;
  return u.toString();
}

/**
 * The database the test suite runs against. Never the working database: an
 * explicit `TEST_DATABASE_URL`, or `<database>_test` on the same server.
 */
export function deriveTestDatabaseUrl(url: string | undefined, explicit?: string): string | undefined {
  if (explicit) return explicit;
  if (!isPostgresUrl(url)) return undefined;
  const parsed = parseDbUrl(url!);
  return withDatabase(url!, `${parsed.database}_test`);
}

export function redact(url: string | undefined): string {
  if (!url) return '(not set)';
  try {
    return parseDbUrl(url).redacted;
  } catch {
    return url;
  }
}
