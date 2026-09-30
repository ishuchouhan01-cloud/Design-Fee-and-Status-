import { fail, ok, requirePermission, searchParams } from '@/lib/api';
import { buildGantt } from '@/lib/services/gantt';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requirePermission(req, 'project.read');
    const sp = searchParams(req);
    const projectId = sp.get('projectId');
    if (!projectId) throw new Error('projectId is required');
    const include = (sp.get('include') ?? 'PACKAGE,DELIVERABLE')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s): s is 'PACKAGE' | 'DELIVERABLE' | 'DRAWING' =>
        ['PACKAGE', 'DELIVERABLE', 'DRAWING'].includes(s),
      );
    return ok(await buildGantt({ projectId, include, limit: Number(sp.get('limit') ?? 250) }));
  } catch (e) {
    return fail(e);
  }
}
