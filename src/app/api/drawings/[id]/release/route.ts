import { fail, ok, requireEntity, requirePermission } from '@/lib/api';
import { releaseDrawing } from '@/lib/services/drawing-control';
import { drawingReleaseSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/** "Mark as Released" — `drawing.complete`. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requirePermission(req, 'drawing.complete');
    const input = drawingReleaseSchema.parse(await req.json());
    const { id } = await params;
    await requireEntity(ctx, 'edit', 'DRAWING', id);
    return ok(await releaseDrawing(id, input, ctx.actor));
  } catch (e) {
    return fail(e);
  }
}
