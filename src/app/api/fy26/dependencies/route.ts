import { fail, ok, requirePermission, searchParams } from '@/lib/api';
import { listDependencies } from '@/lib/services/fy26';
import { createFy26Dependency } from '@/lib/services/fy26-updates';
import { fy26DependencyCreateSchema, rejectForbiddenFields } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requirePermission(req, 'fy26.read');
    const packageId = searchParams(req).get('packageId');
    if (!packageId) return fail(new Error('packageId is required'));
    return ok(await listDependencies(packageId));
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await requirePermission(req, 'fy26.write');
    const body = await req.json();
    rejectForbiddenFields(body);
    const input = fy26DependencyCreateSchema.parse(body);
    return ok(await createFy26Dependency(input, ctx.actor), 201);
  } catch (e) {
    return fail(e);
  }
}
