import { sql } from 'drizzle-orm';
import { db } from '@/db';
import { config } from '@/lib/config';
import { NextResponse } from 'next/server';
import { ok } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // A real round-trip to the database, not just "the process is up".
    const [{ projects, server }] = (
      await db.execute<{ projects: number; server: string }>(
        sql`select (select count(*)::int from projects) as projects, version() as server`,
      )
    ).rows;
    return ok({
      status: 'ok',
      sourceOfTruth: 'DATABASE',
      engine: 'postgresql',
      server: server.split(',')[0],
      database: config.databaseLabel,
      projects: Number(projects),
      time: new Date().toISOString(),
    });
  } catch {
    // For monitors and load balancers: not ready when the database cannot be reached.
    return NextResponse.json({ status: 'error', engine: 'postgresql', message: 'The database cannot be reached.' }, { status: 503 });
  }
}
