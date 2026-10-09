import { z } from 'zod';
import { fail, ok, requireEntity, requirePermission } from '@/lib/api';
import { undoImport } from '@/lib/import/centre';

export const dynamic = 'force-dynamic';

const schema = z.object({ batchId: z.string().min(1) }).strict();

/** Undo the latest import (Administrator, Manager). */
export async function POST(req: Request) {
  try {
    const ctx = await requirePermission(req, 'import.centre');
    const { batchId } = schema.parse(await req.json());
    // Only a run of the person's own projects (a run without a project: Account Admin).
    if (ctx.user.principal.kind === 'member' && !ctx.user.principal.accountAdmin) await requireEntity(ctx, 'importExport', 'IMPORT_RUN', batchId);
    return ok(await undoImport(batchId, ctx.actor));
  } catch (e) {
    return fail(e);
  }
}
