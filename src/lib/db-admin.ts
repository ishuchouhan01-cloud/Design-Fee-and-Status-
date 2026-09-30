/**
 * Database administration helpers used by `scripts/db-setup.ts` and the test
 * bootstrap: create the database if it does not exist, and reset the schema.
 *
 * These connect with a short-lived `pg.Client` rather than the application
 * pool, because CREATE DATABASE cannot run inside a transaction or against the
 * database being created.
 */
import { Client } from 'pg';
import { parseDbUrl, withDatabase } from './db-url';

export interface EnsureResult {
  database: string;
  created: boolean;
}

/**
 * Create the target database if it is missing. Connects to the `postgres`
 * maintenance database on the same server to do it.
 */
export async function ensureDatabaseExists(url: string): Promise<EnsureResult> {
  const target = parseDbUrl(url);
  const admin = new Client({ connectionString: withDatabase(url, 'postgres') });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `Could not connect to PostgreSQL at ${target.host}:${target.port} as "${target.user}". ` +
        `Check that the server is running and that DATABASE_URL is correct. ` +
        `Original error: ${(err as Error).message}`,
    );
  }
  try {
    const existing = await admin.query('select 1 from pg_database where datname = $1', [target.database]);
    if (existing.rowCount && existing.rowCount > 0) {
      return { database: target.database, created: false };
    }
    // Identifiers cannot be parameterised; the name comes from our own URL and
    // is quoted, so a database name with a hyphen or a keyword still works.
    await admin.query(`create database "${target.database.replace(/"/g, '""')}"`);
    return { database: target.database, created: true };
  } finally {
    await admin.end();
  }
}

/**
 * Drop and recreate the schema — the PostgreSQL equivalent of deleting the old
 * SQLite file. Destructive, so the caller must be explicit.
 *
 * Drizzle records applied migrations in a table in its own `drizzle` schema.
 * That has to go too: dropping only `public` leaves the bookkeeping claiming
 * migration 0000 is already applied, so the next `db:setup` silently skips it
 * and leaves you with an empty database.
 */
export async function resetSchema(url: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('drop schema if exists public cascade');
    await client.query('drop schema if exists drizzle cascade');
    await client.query('create schema public');
    // Keep the default grants a fresh database would have had.
    await client.query('grant all on schema public to public');
  } finally {
    await client.end();
  }
}

export async function listTables(url: string): Promise<string[]> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const res = await client.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
        order by table_name`,
    );
    return res.rows.map((r) => r.table_name);
  } finally {
    await client.end();
  }
}
