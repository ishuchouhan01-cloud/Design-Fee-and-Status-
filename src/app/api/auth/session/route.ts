import { context, fail, ok } from '@/lib/api';
import { SESSION_ROLE_LABEL } from '@/lib/access';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const { user } = await context(req);
    return ok({ role: user.loginRole, roleLabel: SESSION_ROLE_LABEL[user.loginRole], editMode: user.editMode, ...(user.member ? { name: user.member.name, email: user.member.email } : {}) });
  } catch (e) {
    return fail(e);
  }
}
