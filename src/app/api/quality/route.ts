import { fail, ok, requirePermission } from '@/lib/api';
import { runDataQualityChecks } from '@/lib/import/quality';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requirePermission(req, 'audit.read');
    return ok(await runDataQualityChecks());
  } catch (e) {
    return fail(e);
  }
}
