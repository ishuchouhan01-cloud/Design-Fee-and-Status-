import { NextResponse } from 'next/server';
import { z } from 'zod';
import { homeFor, LOGIN_ROLES } from '@/lib/access';
import { LoginError, signIn } from '@/lib/login';
import { clientAddress, setSessionCookie } from '@/lib/session-cookie';

export const dynamic = 'force-dynamic';

const schema = z.object({ role: z.enum(LOGIN_ROLES), password: z.string().max(200).optional() });

/** Sign in as Viewer (no password), Admin or Super Admin. The password is checked here, on the server. */
export async function POST(req: Request) {
  try {
    const body = schema.parse(await req.json());
    const s = await signIn(body.role, body.password, clientAddress(req));
    const res = NextResponse.json({ role: s.role, home: homeFor(s.role), expires: s.expires.toISOString() });
    setSessionCookie(res, req, s.cookie, s.expires);
    return res;
  } catch (e) {
    if (e instanceof LoginError) return NextResponse.json({ error: e.message, code: 'LOGIN' }, { status: e.status });
    if (e instanceof z.ZodError) return NextResponse.json({ error: 'Choose Viewer, Admin or Super Admin.', code: 'VALIDATION' }, { status: 422 });
    console.error(e);
    return NextResponse.json({ error: 'Sign-in failed on the server. Please try again.', code: 'ERROR' }, { status: 500 });
  }
}
