import { fail, ok, requirePermission } from '@/lib/api';
import { getDependency } from '@/lib/services/fy26';
import { deleteFy26Dependency, updateFy26Dependency } from '@/lib/services/fy26-updates';
import { fy26DependencyUpdateSchema, rejectForbiddenFields } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requirePermission(req, 'fy26.read');
    const { id } = await params;
    const row = await getDependency(id);
    if (!row) return fail(new Error('FY26 dependency not found'));
    return ok(row);
  } catch (e) {
    return fail(e);
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requirePermission(req, 'fy26.write');
    const { id } = await params;
    const body = await req.json();
    rejectForbiddenFields(body);
    const patch = fy26DependencyUpdateSchema.parse(body);
    return ok(await updateFy26Dependency(id, patch, ctx.actor));
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requirePermission(req, 'fy26.write');
    const { id } = await params;
    const reason = new URL(req.url).searchParams.get('reason') ?? undefined;
    await deleteFy26Dependency(id, ctx.actor, reason);
    return ok({ deleted: id });
  } catch (e) {
    return fail(e);
  }
}
