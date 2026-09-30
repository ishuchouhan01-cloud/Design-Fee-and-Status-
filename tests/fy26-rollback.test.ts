/**
 * A failed FY26 import must not leave a partial dataset behind.
 *
 * A database trigger makes the 200th dependency insert throw — deep inside the
 * transaction, after hundreds of packages and dependencies have already been
 * written. If the import were not transactional, those rows would survive.
 *
 * Runs after `fy26-import.test.ts` (alphabetical order) and restores the module
 * to its fully imported state before finishing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  fy26ImportBatches,
  fy26PackageDependencies,
  fy26Packages,
  fy26Phases,
  fy26Projects,
} from '@/db/schema';
import { EXPECTED_TOTALS, runFy26Import } from '@/lib/import/design-goals-fy26';

const SOURCE_DIR = path.resolve(process.cwd(), process.env.FY26_SOURCE_DIR ?? 'data/fy26');
const available = fs.existsSync(SOURCE_DIR) && fs.readdirSync(SOURCE_DIR).some((f) => f.endsWith('.xlsx'));
const actor = { id: null, label: 'rollback test' };

async function counts() {
  const [p, ph, pk, d] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(fy26Projects),
    db.select({ n: sql<number>`count(*)::int` }).from(fy26Phases),
    db.select({ n: sql<number>`count(*)::int` }).from(fy26Packages),
    db.select({ n: sql<number>`count(*)::int` }).from(fy26PackageDependencies),
  ]);
  return { projects: p[0].n, phases: ph[0].n, packages: pk[0].n, dependencies: d[0].n };
}

async function clearModule() {
  await db.delete(fy26PackageDependencies);
  await db.delete(fy26Packages);
  await db.delete(fy26Phases);
  await db.delete(fy26Projects);
}

async function dropTrigger() {
  await db.execute(sql`drop trigger if exists fy26_rollback_probe on fy26_package_dependencies`);
  await db.execute(sql`drop function if exists fy26_rollback_probe_fn()`);
  await db.execute(sql`drop sequence if exists fy26_rollback_probe_seq`);
}

describe.skipIf(!available)('FY26 import is transactional', () => {
  afterAll(async () => {
    await dropTrigger();
    await clearModule();
    await runFy26Import({ sourceDir: SOURCE_DIR, apply: true, actor });
  }, 300_000);

  it('rolls back every row when the import fails part-way through', async () => {
    await clearModule();
    expect(await counts()).toEqual({ projects: 0, phases: 0, packages: 0, dependencies: 0 });

    await dropTrigger();
    await db.execute(sql`create sequence fy26_rollback_probe_seq`);
    await db.execute(sql.raw(`
      create function fy26_rollback_probe_fn() returns trigger language plpgsql as $$
      begin
        if nextval('fy26_rollback_probe_seq') >= 200 then
          raise exception 'rollback probe: simulated failure on dependency insert 200';
        end if;
        return new;
      end $$;
    `));
    await db.execute(sql.raw(`
      create trigger fy26_rollback_probe before insert on fy26_package_dependencies
      for each row execute function fy26_rollback_probe_fn();
    `));

    await expect(runFy26Import({ sourceDir: SOURCE_DIR, apply: true, actor })).rejects.toThrow(/rollback probe/);

    // Nothing survived — not the projects, phases or packages written before
    // the failure, and not the 199 dependencies that did insert.
    expect(await counts()).toEqual({ projects: 0, phases: 0, packages: 0, dependencies: 0 });

    const [batch] = await db
      .select()
      .from(fy26ImportBatches)
      .orderBy(desc(fy26ImportBatches.startedAt))
      .limit(1);
    expect(batch.status).toBe('FAILED');
    expect(batch.previewJson).toMatch(/rollback probe/);
  }, 300_000);

  it('imports cleanly once the fault is removed', async () => {
    await dropTrigger();
    const result = await runFy26Import({ sourceDir: SOURCE_DIR, apply: true, actor });
    expect(result.valid).toBe(true);
    const c = await counts();
    expect(c.packages).toBe(EXPECTED_TOTALS.packages);
    expect(c.dependencies).toBe(EXPECTED_TOTALS.dependencies);

    const [batch] = await db.select().from(fy26ImportBatches).where(eq(fy26ImportBatches.id, result.batchId)).limit(1);
    expect(batch.status).toBe('APPLIED');
  }, 300_000);
});
