import { fail, ok, requirePermission, searchParams } from '@/lib/api';
import { buildExecutiveDashboard } from '@/lib/services/dashboard';
import { getSetting } from '@/lib/services/reference';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requirePermission(req, 'project.read');
    const fy = searchParams(req).get('fiscalYear') ?? (await getSetting('app.currentFiscalYear', 'FY26-27'));
    const d = await buildExecutiveDashboard({ fiscalYear: fy });
    return ok({
      fiscalYear: d.fiscalYear,
      goals: d.goalBlock,
      delivery: d.deliveryBlock,
      projects: d.projectCount,
      atRiskProjects: d.atRiskProjects,
      quarters: d.quarters,
      disciplines: d.disciplineRows,
    });
  } catch (e) {
    return fail(e);
  }
}
