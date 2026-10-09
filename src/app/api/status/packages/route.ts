import { z } from 'zod';
import { fail, ok, requireEntity } from '@/lib/api';
import { createPackage } from '@/lib/services/status-edit';
import { requireEdit } from '@/lib/status-api';
import { optionalDateString } from '@/lib/validation';

export const dynamic = 'force-dynamic';

const schema = z
  .object({
    projectId: z.string().min(1),
    wbsNodeId: z.string().nullable().optional(),
    packageCode: z.string().trim().min(1).max(40),
    packageName: z.string().trim().min(1).max(200),
    expectedReleaseDate: optionalDateString,
    responsible: z.string().max(200).nullable().optional(),
  })
  .strict();

/** Add a package under a project, tower / product or heading. */
export async function POST(req: Request) {
  try {
    const ctx = await requireEdit(req, 'drawing.write');
    const b = schema.parse(await req.json());
    await requireEntity(ctx, 'edit', 'PROJECT', b.projectId);
    return ok(await createPackage(b, ctx.actor), 201);
  } catch (e) {
    return fail(e);
  }
}
