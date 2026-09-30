/**
 * Weekly report feed for the PowerPoint automation. One HTTP call returns
 * everything the deck needs; the deck no longer reads Excel.
 */
import { fail, ok, requirePermission, searchParams } from '@/lib/api';
import { buildWeeklyReport } from '@/lib/services/reporting';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requirePermission(req, 'project.read');
    const fy = searchParams(req).get('fiscalYear') ?? undefined;
    return ok(await buildWeeklyReport({ fiscalYear: fy }));
  } catch (e) {
    return fail(e);
  }
}
