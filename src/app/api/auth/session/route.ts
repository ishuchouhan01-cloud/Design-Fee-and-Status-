import { context, fail, ok } from '@/lib/api';
import { LOGIN_ROLE_LABEL } from '@/lib/access';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const { user } = await context(req);
    return ok({ role: user.loginRole, roleLabel: LOGIN_ROLE_LABEL[user.loginRole], editMode: user.editMode });
  } catch (e) {
    return fail(e);
  }
}
