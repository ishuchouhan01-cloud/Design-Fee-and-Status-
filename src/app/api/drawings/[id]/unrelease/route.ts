import { fail, ok, requireEntity, requirePermission } from '@/lib/api';
import { unreleaseDrawing } from '@/lib/services/drawing-control';
import { drawingUnreleaseSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/** Withdraw a release — `drawing.admin`, reason required. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requirePermission(req, 'drawing.admin');
    const { reason } = drawingUnreleaseSchema.parse(await req.json());
    const { id } = await params;
    await requireEntity(ctx, 'edit', 'DRAWING', id);
    return ok(await unreleaseDrawing(id, reason, ctx.actor));
  } catch (e) {
    return fail(e);
  }
}
