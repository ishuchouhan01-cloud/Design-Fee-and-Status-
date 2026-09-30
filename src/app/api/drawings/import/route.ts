import { fail, ok, requirePermission } from '@/lib/api';
import { runDrawingImport } from '@/lib/import/drawing-register';
import { drawingImportSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Drawing Register import — `drawing.admin`. `apply:false` previews (no
 * drawing data written); `apply:true` imports in one transaction and is
 * refused unless every validation target matches.
 */
export async function POST(req: Request) {
  try {
    const ctx = await requirePermission(req, 'drawing.admin');
    const { apply } = drawingImportSchema.parse(await req.json().catch(() => ({})));
    const result = await runDrawingImport({ apply, actor: ctx.actor });
    // The full issue list can be long; the screen reads it by batch.
    return ok({ ...result, issues: result.issues.slice(0, 200) });
  } catch (e) {
    return fail(e);
  }
}
