import { z } from 'zod';
import { fail, ok, requirePermission } from '@/lib/api';
import { addPackageDependency, listPackageDependencies } from '@/lib/services/status-edit';
import { requireEdit } from '@/lib/status-api';
import { optionalDateString } from '@/lib/validation';

export const dynamic = 'force-dynamic';

const schema = z
  .object({
    department: z.string().trim().min(1).max(120),
    ownerText: z.string().max(200).nullable().optional(),
    description: z.string().trim().min(1).max(2000),
    targetDate: optionalDateString,
    remarks: z.string().max(2000).nullable().optional(),
  })
  .strict();

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requirePermission(req, 'drawing.read');
    const { id } = await params;
    return ok({ rows: await listPackageDependencies(id) });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireEdit(req, 'drawing.write');
    const { id } = await params;
    return ok(await addPackageDependency(id, schema.parse(await req.json()), ctx.actor), 201);
  } catch (e) {
    return fail(e);
  }
}
