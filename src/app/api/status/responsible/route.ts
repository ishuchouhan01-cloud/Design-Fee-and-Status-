import { z } from 'zod';
import { fail, ok, requireEntity } from '@/lib/api';
import { setResponsible } from '@/lib/services/status-edit';
import { requireEdit } from '@/lib/status-api';

export const dynamic = 'force-dynamic';

const schema = z.object({ kind: z.enum(['PACKAGE', 'DRAWING']), id: z.string().min(1), name: z.string().max(200).nullable() }).strict();

/** Responsible Person of a package or drawing. */
export async function PATCH(req: Request) {
  try {
    const ctx = await requireEdit(req, 'drawing.write');
    const b = schema.parse(await req.json());
    await requireEntity(ctx, 'edit', b.kind, b.id);
    return ok(await setResponsible(b.kind, b.id, b.name, ctx.actor));
  } catch (e) {
    return fail(e);
  }
}
