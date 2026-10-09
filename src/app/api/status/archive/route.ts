import { z } from 'zod';
import { fail, ok, requireEntity } from '@/lib/api';
import { archiveRow } from '@/lib/services/status-edit';
import { requireEdit } from '@/lib/status-api';

export const dynamic = 'force-dynamic';

const schema = z.object({ kind: z.enum(['DRAWING', 'PACKAGE', 'PROJECT']), id: z.string().min(1), reason: z.string().trim().min(3).max(500) }).strict();

/** Archive a drawing, package (with its drawings) or tower / product. Nothing is deleted. */
export async function POST(req: Request) {
  try {
    const b = schema.parse(await req.json());
    const ctx = await requireEdit(req, b.kind === 'PROJECT' ? 'project.write' : 'drawing.write');
    // Only rows of a project where Edit is on.
    await requireEntity(ctx, 'edit', b.kind, b.id);
    return ok(await archiveRow(b.kind, b.id, b.reason, ctx.actor));
  } catch (e) {
    return fail(e);
  }
}
