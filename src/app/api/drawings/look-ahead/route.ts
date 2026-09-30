import { fail, ok, requirePermission, searchParams } from '@/lib/api';
import { drawingLookAhead, parseDrawingFilters } from '@/lib/services/drawing-register';

export const dynamic = 'force-dynamic';

/** Two-week look-ahead (OVERDUE / THIS WEEK / NEXT WEEK), NOT RELEASED only. */
export async function GET(req: Request) {
  try {
    await requirePermission(req, 'drawing.read');
    return ok(await drawingLookAhead(parseDrawingFilters(searchParams(req))));
  } catch (e) {
    return fail(e);
  }
}
