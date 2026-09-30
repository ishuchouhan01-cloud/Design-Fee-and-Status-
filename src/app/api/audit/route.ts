import { fail, ok, requirePermission, searchParams } from '@/lib/api';
import { queryAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requirePermission(req, 'audit.read');
    const sp = searchParams(req);
    return ok(
      await queryAudit({
        entityType: sp.get('entityType') ?? undefined,
        entityId: sp.get('entityId') ?? undefined,
        action: sp.get('action') ?? undefined,
        projectId: sp.get('projectId') ?? undefined,
        search: sp.get('search') ?? undefined,
        page: Number(sp.get('page') ?? 1),
        pageSize: Number(sp.get('pageSize') ?? 50),
      }),
    );
  } catch (e) {
    return fail(e);
  }
}
