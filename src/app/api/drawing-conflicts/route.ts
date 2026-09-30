import { fail, ok, requirePermission, searchParams } from '@/lib/api';
import { listConflicts } from '@/lib/services/drawing-register';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requirePermission(req, 'drawing.admin');
    const sp = searchParams(req);
    return ok(await listConflicts(sp.get('status') ?? undefined, sp.get('projectId') ?? undefined));
  } catch (e) {
    return fail(e);
  }
}
