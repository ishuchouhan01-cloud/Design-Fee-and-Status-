import { z } from 'zod';
import { fail, ok, requireEntity } from '@/lib/api';
import { createTower } from '@/lib/services/status-edit';
import { requireEdit } from '@/lib/status-api';

export const dynamic = 'force-dynamic';

const schema = z.object({ parentProjectId: z.string().min(1), name: z.string().trim().min(1).max(120) }).strict();

/** Add a tower / product under a project. */
export async function POST(req: Request) {
  try {
    const ctx = await requireEdit(req, 'project.write');
    const b = schema.parse(await req.json());
    await requireEntity(ctx, 'edit', 'PROJECT', b.parentProjectId);
    return ok(await createTower(b, ctx.actor), 201);
  } catch (e) {
    return fail(e);
  }
}
