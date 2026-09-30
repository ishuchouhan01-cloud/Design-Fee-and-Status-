import { fail, ok, requirePermission, searchParams } from '@/lib/api';
import { parseFilters } from '@/lib/services/filters';
import { queryDeliverables } from '@/lib/services/queries';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requirePermission(req, 'deliverable.read');
    return ok(await queryDeliverables(parseFilters(searchParams(req))));
  } catch (e) {
    return fail(e);
  }
}
