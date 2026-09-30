import { z } from 'zod';
import { fail, ok, requirePermission } from '@/lib/api';
import { setUnitApplicability } from '@/lib/services/dfs-admin';

export const dynamic = 'force-dynamic';

const schema = z
  .object({
    packageId: z.string().min(1),
    discipline: z.enum(['AR', 'ST', 'MEP', 'LS']),
    applicability: z.enum(['APPLICABLE', 'NA']),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

/** Mark a package × discipline explicitly NA (or applicable again) — `drawing.admin`. */
export async function POST(req: Request) {
  try {
    const ctx = await requirePermission(req, 'drawing.admin');
    const input = schema.parse(await req.json());
    return ok(await setUnitApplicability(input, ctx.actor));
  } catch (e) {
    return fail(e);
  }
}
