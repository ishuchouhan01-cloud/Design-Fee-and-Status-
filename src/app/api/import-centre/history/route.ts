import { fail, ok, requirePermission, scopeOf } from '@/lib/api';
import { importHistory } from '@/lib/import/centre';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const ctx = await requirePermission(req, 'import.centre');
    return ok({ runs: await importHistory(50, scopeOf(ctx, 'importExport')) });
  } catch (e) {
    return fail(e);
  }
}
