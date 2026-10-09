import { NextResponse } from 'next/server';
import { z } from 'zod';
import { LoginError } from '@/lib/login';
import { acceptInvite } from '@/lib/members/auth';
import { clientAddress, setSessionCookie } from '@/lib/session-cookie';

export const dynamic = 'force-dynamic';

const schema = z.object({ token: z.string().min(20).max(100), password: z.string().max(200), confirm: z.string().max(200) });

/** Set the password from a one-time invite link; the member is then signed in. */
export async function POST(req: Request) {
  try {
    const b = schema.parse(await req.json());
    const s = await acceptInvite(b.token, b.password, b.confirm, clientAddress(req));
    const res = NextResponse.json({ home: '/', expires: s.expires.toISOString() });
    setSessionCookie(res, req, s.cookie, s.expires);
    return res;
  } catch (e) {
    if (e instanceof LoginError) return NextResponse.json({ error: e.message, code: 'INVITE' }, { status: e.status });
    if (e instanceof z.ZodError) return NextResponse.json({ error: 'Fill in both password fields.', code: 'VALIDATION' }, { status: 422 });
    console.error(e);
    return NextResponse.json({ error: 'The password could not be set. Please try again.', code: 'ERROR' }, { status: 500 });
  }
}
