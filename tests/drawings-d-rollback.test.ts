/**
 * A failed drawing import leaves nothing behind: a trigger makes the 5,000th
 * snapshot insert throw — after every drawing, revision and history row of the
 * batch has been written — and the whole transaction must roll back.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { desc, sql } from 'drizzle-orm';
import { db } from '@/db';
import { drawingImportBatches } from '@/db/schema';
import { runDrawingImport } from '@/lib/import/drawing-register';

const MANIFEST = path.resolve(process.cwd(), 'data/drawing-sources/poarr.json');
const available = fs.existsSync(MANIFEST);
const actor = { id: null, label: 'drawing rollback test' };

async function snapshotOfCounts() {
  const r = await db.execute(sql`select
      (select count(*)::int from drawings) as drawings,
      (select count(*)::int from drawing_revisions) as revisions,
      (select count(*)::int from drawing_snapshots) as snapshots,
      (select count(*)::int from reschedule_history) as history,
      (select count(*)::int from drawing_conflicts) as conflicts,
      (select string_agg(id || ':' || coalesce(import_batch_id,''), ',' order by id) from drawings) as stamps`);
  return r.rows[0];
}

async function dropTrigger() {
  await db.execute(sql`drop trigger if exists drawing_rollback_probe on drawing_snapshots`);
  await db.execute(sql`drop function if exists drawing_rollback_probe_fn()`);
  await db.execute(sql`drop sequence if exists drawing_rollback_probe_seq`);
}

describe.skipIf(!available)('drawing import is transactional', () => {
  afterAll(dropTrigger);

  it('rolls back every write when the import fails part-way through', async () => {
    const before = await snapshotOfCounts();
    await dropTrigger();
    await db.execute(sql`create sequence drawing_rollback_probe_seq`);
    await db.execute(sql.raw(`
      create function drawing_rollback_probe_fn() returns trigger language plpgsql as $$
      begin
        if nextval('drawing_rollback_probe_seq') >= 5000 then
          raise exception 'drawing rollback probe: simulated failure on snapshot insert 5000';
        end if;
        return new;
      end $$;`));
    await db.execute(sql.raw(`create trigger drawing_rollback_probe before insert on drawing_snapshots for each row execute function drawing_rollback_probe_fn();`));

    await expect(runDrawingImport({ manifestPath: MANIFEST, apply: true, actor })).rejects.toThrow(/rollback probe/);
    expect(await snapshotOfCounts()).toEqual(before);
    const [batch] = await db.select().from(drawingImportBatches).orderBy(desc(drawingImportBatches.startedAt)).limit(1);
    expect(batch.status).toBe('FAILED');
    expect(batch.summaryJson).toMatch(/rollback probe/);
  }, 300_000);
});
