import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { drawingDependencies } from '@/db/schema';
import { fail, ok, requireEntity, requirePermission } from '@/lib/api';
import { addDrawingDependency } from '@/lib/services/drawing-control';
import { drawingDependencyCreateSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requirePermission(req, 'drawing.read');
    const { id } = await params;
    await requireEntity(ctx, 'status', 'DRAWING', id);
    return ok(await db.select().from(drawingDependencies).where(eq(drawingDependencies.drawingId, id)));
  } catch (e) {
    return fail(e);
  }
}

/** "Add Dependency" (department / task) — `drawing.write`. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requirePermission(req, 'drawing.write');
    await requireEntity(ctx, 'edit', 'DRAWING', (await params).id);
    const input = drawingDependencyCreateSchema.parse(await req.json());
    const { id } = await params;
    return ok(await addDrawingDependency(id, input, ctx.actor), 201);
  } catch (e) {
    return fail(e);
  }
}
