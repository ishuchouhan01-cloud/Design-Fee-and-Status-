import { fail, ok, requirePermission, searchParams } from '@/lib/api';
import { fy26Kpis, listFy26Packages } from '@/lib/services/fy26';
import { fy26ListFiltersSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

function parse(req: Request) {
  const sp = searchParams(req);
  const raw: Record<string, string> = {};
  for (const [k, v] of sp.entries()) if (v !== '') raw[k] = v;
  return fy26ListFiltersSchema.parse(raw);
}

export async function GET(req: Request) {
  try {
    await requirePermission(req, 'fy26.read');
    const filters = parse(req);
    const [page, kpis] = await Promise.all([listFy26Packages(filters), fy26Kpis(filters)]);
    return ok({ ...page, kpis });
  } catch (e) {
    return fail(e);
  }
}
