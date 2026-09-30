import { asc } from 'drizzle-orm';
import { db } from '@/db';
import { disciplines } from '@/db/schema';
import { fail, ok, requirePermission } from '@/lib/api';
import { peopleSuggestions } from '@/lib/services/status-edit';

export const dynamic = 'force-dynamic';

/** Disciplines and people for the Edit Mode forms. */
export async function GET(req: Request) {
  try {
    await requirePermission(req, 'drawing.write');
    const [ds, names] = await Promise.all([
      db.select({ id: disciplines.id, code: disciplines.code, name: disciplines.name, group: disciplines.dfsGroup }).from(disciplines).orderBy(asc(disciplines.sortOrder)),
      peopleSuggestions(),
    ]);
    return ok({ disciplines: ds, people: names });
  } catch (e) {
    return fail(e);
  }
}
