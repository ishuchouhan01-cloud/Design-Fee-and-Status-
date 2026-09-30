import { fail, ok, requirePermission } from '@/lib/api';
import { updateRevision } from '@/lib/services/drawing-control';
import { drawingRevisionUpdateSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/** Edit a revision's planned date or remarks — `drawing.write`. The revision
 *  label and its release record cannot be changed. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requirePermission(req, 'drawing.write');
    const input = drawingRevisionUpdateSchema.parse(await req.json());
    const { id } = await params;
    return ok(await updateRevision(id, input, ctx.actor));
  } catch (e) {
    return fail(e);
  }
}
