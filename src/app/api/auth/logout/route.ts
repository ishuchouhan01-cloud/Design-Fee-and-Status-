import { NextResponse } from 'next/server';
import { cookieFromHeader, SESSION_COOKIE } from '@/lib/access';
import { signOut } from '@/lib/login';
import { clearSessionCookie } from '@/lib/session-cookie';

export const dynamic = 'force-dynamic';

/** Switch User: the session ends (Edit Mode goes off with it) and the cookie is removed. */
export async function POST(req: Request) {
  try {
    await signOut(cookieFromHeader(req.headers.get('cookie'), SESSION_COOKIE));
  } catch {
    /* an unreadable cookie is removed all the same */
  }
  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res, req);
  return res;
}
