import { fail, ok, requirePermission } from '@/lib/api';
import { deleteDrawingDependency, updateDrawingDependency } from '@/lib/services/drawing-control';
import { drawingDependencyUpdateSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/** Edit / close a department dependency — `drawing.write`. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requirePermission(req, 'drawing.write');
    const input = drawingDependencyUpdateSchema.parse(await req.json());
    const { id } = await params;
    return ok(await updateDrawingDependency(id, input, ctx.actor));
  } catch (e) {
    return fail(e);
  }
}

/** Delete a manually added dependency — `drawing.write`. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requirePermission(req, 'drawing.write');
    const { id } = await params;
    return ok(await deleteDrawingDependency(id, ctx.actor));
  } catch (e) {
    return fail(e);
  }
}
