import { z } from 'zod';
import { fail, ok, requireEntity } from '@/lib/api';
import { addDiscipline } from '@/lib/services/status-edit';
import { requireEdit } from '@/lib/status-api';

export const dynamic = 'force-dynamic';

const schema = z.object({ packageId: z.string().min(1), disciplineId: z.string().min(1) }).strict();

/** Add a discipline to a package. */
export async function POST(req: Request) {
  try {
    const ctx = await requireEdit(req, 'drawing.write');
    const b = schema.parse(await req.json());
    await requireEntity(ctx, 'edit', 'PACKAGE', b.packageId);
    return ok(await addDiscipline(b.packageId, b.disciplineId, ctx.actor), 201);
  } catch (e) {
    return fail(e);
  }
}
