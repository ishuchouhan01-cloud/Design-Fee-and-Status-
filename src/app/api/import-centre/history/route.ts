import { fail, ok, requirePermission } from '@/lib/api';
import { importHistory } from '@/lib/import/centre';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requirePermission(req, 'import.centre');
    return ok({ runs: await importHistory() });
  } catch (e) {
    return fail(e);
  }
}
