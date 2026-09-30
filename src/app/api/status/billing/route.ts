import { z } from 'zod';
import { fail, ok } from '@/lib/api';
import { setBilling } from '@/lib/services/status-edit';
import { requireEdit } from '@/lib/status-api';

export const dynamic = 'force-dynamic';

const amount = z.number().finite().min(0).nullable().optional();
const schema = z.object({ packageId: z.string().min(1), group: z.string().min(1).max(20), total: amount, billed: amount }).strict();

/** Total (scope) and Billed of a package × discipline, in ₹ crore. Admin and Super Admin. */
export async function PATCH(req: Request) {
  try {
    const ctx = await requireEdit(req, 'billing.write');
    return ok(await setBilling(schema.parse(await req.json()), ctx.actor));
  } catch (e) {
    return fail(e);
  }
}
