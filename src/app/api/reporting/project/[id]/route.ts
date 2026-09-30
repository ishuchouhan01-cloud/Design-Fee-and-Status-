import { fail, ok, requirePermission, searchParams } from '@/lib/api';
import { buildProjectReport } from '@/lib/services/reporting';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requirePermission(req, 'project.read');
    const { id } = await params;
    const fy = searchParams(req).get('fiscalYear') ?? undefined;
    const report = await buildProjectReport(id, fy);
    if (!report) return fail(new Error('Project not found'));
    return ok(report);
  } catch (e) {
    return fail(e);
  }
}
