import { z } from 'zod';
import { fail, ok } from '@/lib/api';
import { updatePackageDependency } from '@/lib/services/status-edit';
import { requireEdit } from '@/lib/status-api';
import { optionalDateString } from '@/lib/validation';

export const dynamic = 'force-dynamic';

const schema = z
  .object({
    department: z.string().trim().min(1).max(120).optional(),
    ownerText: z.string().max(200).nullable().optional(),
    description: z.string().trim().min(1).max(2000).optional(),
    targetDate: optionalDateString,
    closureDate: optionalDateString,
    status: z.enum(['OPEN', 'CLOSED']).optional(),
    remarks: z.string().max(2000).nullable().optional(),
  })
  .strict();

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireEdit(req, 'drawing.write');
    const { id } = await params;
    return ok(await updatePackageDependency(id, schema.parse(await req.json()), ctx.actor));
  } catch (e) {
    return fail(e);
  }
}
