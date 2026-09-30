import { fail, ok, requirePermission } from '@/lib/api';
import { fy26Reference, fy26Tree } from '@/lib/services/fy26';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requirePermission(req, 'fy26.read');
    const [reference, tree] = await Promise.all([fy26Reference(), fy26Tree()]);
    return ok({ ...reference, tree });
  } catch (e) {
    return fail(e);
  }
}
