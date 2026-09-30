import { fail, ok, requirePermission } from '@/lib/api';
import { peopleSuggestions } from '@/lib/services/status-edit';

export const dynamic = 'force-dynamic';

/** Names to suggest for Responsible Person. */
export async function GET(req: Request) {
  try {
    await requirePermission(req, 'drawing.write');
    return ok({ names: await peopleSuggestions() });
  } catch (e) {
    return fail(e);
  }
}
