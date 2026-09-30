import { context, fail, ok } from '@/lib/api';
import { listProjects } from '@/lib/services/reference';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await context(req);
    return ok(await listProjects());
  } catch (e) {
    return fail(e);
  }
}
