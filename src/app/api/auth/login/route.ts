import { NextResponse } from 'next/server';
import { z } from 'zod';
import { homeFor, LOGIN_ROLES } from '@/lib/access';
import { LoginError, signIn, type SignedIn } from '@/lib/login';
import { emergencySignIn, signInMember } from '@/lib/members/auth';
import { clientAddress, setSessionCookie } from '@/lib/session-cookie';

export const dynamic = 'force-dynamic';

const schema = z.union([
  // Personal sign-in: email + password.
  z.object({ email: z.string().trim().min(3).max(320), password: z.string().max(200) }),
  // The hidden emergency (break-glass) Account Admin sign-in (/login?emergency=1).
  z.object({ emergency: z.literal(true), password: z.string().max(200) }),
  // The shared role sign-ins, while LEGACY_ROLE_LOGINS is on.
  z.object({ role: z.enum(LOGIN_ROLES), password: z.string().max(200).optional() }),
]);

/** Sign in. Every password is checked here, on the server. */
export async function POST(req: Request) {
  try {
    const body = schema.parse(await req.json());
    const ip = clientAddress(req);
    let s: SignedIn;
    let home: string;
    if ('email' in body) {
      s = await signInMember(body.email, body.password, ip);
      // The start screen follows their access (the middleware sends / on to it).
      home = '/';
    } else if ('emergency' in body) {
      s = await emergencySignIn(body.password, ip);
      home = '/settings/members';
    } else {
      s = await signIn(body.role, body.password, ip);
      home = homeFor(s.role);
    }
    const res = NextResponse.json({ role: s.role, home, expires: s.expires.toISOString() });
    setSessionCookie(res, req, s.cookie, s.expires);
    return res;
  } catch (e) {
    if (e instanceof LoginError) return NextResponse.json({ error: e.message, code: 'LOGIN' }, { status: e.status });
    if (e instanceof z.ZodError) return NextResponse.json({ error: 'Give your email and password.', code: 'VALIDATION' }, { status: 422 });
    console.error(e);
    return NextResponse.json({ error: 'Sign-in failed on the server. Please try again.', code: 'ERROR' }, { status: 500 });
  }
}
