import { fail, ok, requirePermission, searchParams } from '@/lib/api';
import { clearRagOverride, setRagOverride } from '@/lib/services/updates';
import { ragOverrideSchema } from '@/lib/validation';
import { buildProjectDashboard } from '@/lib/services/dashboard';
import { getSetting } from '@/lib/services/reference';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const ctx = await requirePermission(req, 'rag.override');
    const input = ragOverrideSchema.parse(await req.json());
    let calculated = 'GREY';
    if (input.entityType === 'PROJECT') {
      const fy = await getSetting('app.currentFiscalYear', 'FY26-27');
      const d = await buildProjectDashboard(input.entityId, fy);
      calculated = d?.rag.calculated ?? 'GREY';
    }
    await setRagOverride({ ...input, calculatedRag: calculated }, ctx.actor);
    return ok({ overridden: true, calculatedRag: calculated });
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(req: Request) {
  try {
    const ctx = await requirePermission(req, 'rag.override');
    const id = searchParams(req).get('entityId');
    if (!id) throw new Error('entityId is required');
    await clearRagOverride(id, ctx.actor);
    return ok({ cleared: id });
  } catch (e) {
    return fail(e);
  }
}
