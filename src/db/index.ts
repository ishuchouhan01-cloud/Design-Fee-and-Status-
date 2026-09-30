/**
 * Database client — PostgreSQL via node-postgres.
 *
 * This file and `schema.ts` are the only places that know which database
 * engine is in use. Everything else talks to the Drizzle query builder.
 *
 * The pool is held on `globalThis` so Next.js dev-server hot reloads reuse one
 * pool instead of opening a new one per reload.
 */
import { Pool, type PoolConfig } from 'pg';
import { drizzle, type NodePgDatabase, type NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import { config } from '@/lib/config';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;

/** The object handed to a `db.transaction(async (tx) => …)` callback. */
export type DbTx = PgTransaction<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/**
 * Anything that can run a query: the pool-backed client, or a transaction.
 * Write helpers take this so the same function works inside and outside a
 * transaction.
 */
export type DbLike = Db | DbTx;

function poolConfig(): PoolConfig {
  return {
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Managed PostgreSQL services usually require TLS; a local server does not.
    ssl: config.dbSsl ? { rejectUnauthorized: false } : undefined,
    application_name: 'design-control',
  };
}

const globalForDb = globalThis as unknown as {
  __designControlPool?: Pool;
  __designControlDb?: Db;
};

export function getPool(): Pool {
  if (globalForDb.__designControlPool) return globalForDb.__designControlPool;
  const pool = new Pool(poolConfig());
  // A pool error with no listener would take the process down.
  pool.on('error', (err) => {
    console.error('[db] idle client error:', err.message);
  });
  globalForDb.__designControlPool = pool;
  return pool;
}

export const db: Db =
  globalForDb.__designControlDb ?? drizzle(getPool(), { schema, casing: 'snake_case' });

globalForDb.__designControlDb = db;

/**
 * Close the pool. Required at the end of every CLI script and test run —
 * unlike the old embedded driver, an open pool keeps the process alive.
 */
export async function closeDb(): Promise<void> {
  const pool = globalForDb.__designControlPool;
  if (!pool) return;
  globalForDb.__designControlPool = undefined;
  globalForDb.__designControlDb = undefined;
  await pool.end();
}

export { schema };
