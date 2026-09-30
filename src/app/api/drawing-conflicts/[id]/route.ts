import { fail, ok, requirePermission } from '@/lib/api';
import { dismissConflict, resolveConflict } from '@/lib/services/drawing-control';
import { drawingConflictActionSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/** Resolve (choose a candidate) or dismiss an import conflict — `drawing.admin`. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requirePermission(req, 'drawing.admin');
    const input = drawingConflictActionSchema.parse(await req.json());
    const { id } = await params;
    if (input.action === 'RESOLVE') return ok(await resolveConflict(id, input, ctx.actor));
    return ok(await dismissConflict(id, input.note, ctx.actor));
  } catch (e) {
    return fail(e);
  }
}
