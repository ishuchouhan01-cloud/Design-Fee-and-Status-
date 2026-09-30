import { fail, ok, requirePermission } from '@/lib/api';
import { getFy26Package, listDependencies, listRevisions } from '@/lib/services/fy26';
import { updateFy26Package } from '@/lib/services/fy26-updates';
import { fy26PackageUpdateSchema, rejectForbiddenFields } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requirePermission(req, 'fy26.read');
    const { id } = await params;
    const pkg = await getFy26Package(id);
    if (!pkg) return fail(new Error('FY26 package not found'));
    const [dependencies, revisions] = await Promise.all([listDependencies(id), listRevisions(id)]);
    return ok({ package: pkg, dependencies, revisions });
  } catch (e) {
    return fail(e);
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requirePermission(req, 'fy26.write');
    const { id } = await params;
    const body = await req.json();
    // Rejects percentages and baseline dates before Zod even sees them.
    rejectForbiddenFields(body);
    const patch = fy26PackageUpdateSchema.parse(body);
    return ok(await updateFy26Package(id, patch, ctx.actor));
  } catch (e) {
    return fail(e);
  }
}
