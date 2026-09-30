import { z } from 'zod';
import { fail, ok } from '@/lib/api';
import { updatePackage } from '@/lib/services/status-edit';
import { requireEdit } from '@/lib/status-api';

export const dynamic = 'force-dynamic';

const schema = z.object({ packageName: z.string().max(200).optional(), packageCode: z.string().max(40).optional() }).strict();

/** Package name and code. The expected date moves through the reschedule engine (/api/reschedule). */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireEdit(req, 'drawing.write');
    const { id } = await params;
    return ok(await updatePackage(id, schema.parse(await req.json()), ctx.actor));
  } catch (e) {
    return fail(e);
  }
}
