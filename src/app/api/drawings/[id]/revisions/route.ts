import { fail, ok, requireEntity, requirePermission } from '@/lib/api';
import { addRevision } from '@/lib/services/drawing-control';
import { drawingRevisionCreateSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/** "Add Revision" — `drawing.write`. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requirePermission(req, 'drawing.write');
    const input = drawingRevisionCreateSchema.parse(await req.json());
    const { id } = await params;
    await requireEntity(ctx, 'edit', 'DRAWING', id);
    return ok(await addRevision(id, input, ctx.actor), 201);
  } catch (e) {
    return fail(e);
  }
}
