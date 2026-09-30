import { fail, ok, requirePermission, searchParams } from '@/lib/api';
import { createDrawing } from '@/lib/services/drawing-control';
import { drawingKpis, listDrawings, parseDrawingFilters } from '@/lib/services/drawing-register';
import { drawingCreateSchema, rejectForbiddenFields } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/** DFS drawing list — read-only, `drawing.read`. */
export async function GET(req: Request) {
  try {
    await requirePermission(req, 'drawing.read');
    const f = parseDrawingFilters(searchParams(req));
    const [list, kpis] = await Promise.all([listDrawings(f), drawingKpis(f)]);
    return ok({ ...list, kpis });
  } catch (e) {
    return fail(e);
  }
}

/** "+ Add Drawing" — `drawing.write`. */
export async function POST(req: Request) {
  try {
    const ctx = await requirePermission(req, 'drawing.write');
    const body = await req.json();
    rejectForbiddenFields(body);
    const input = drawingCreateSchema.parse(body);
    return ok(await createDrawing(input, ctx.actor), 201);
  } catch (e) {
    return fail(e);
  }
}
