/** The session cookie's attributes: httpOnly, SameSite, an expiry, Secure over HTTPS. */
import type { NextResponse } from 'next/server';
import { SESSION_COOKIE } from './access';

export function isHttps(req: Request): boolean {
  return new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';
}

export function setSessionCookie(res: NextResponse, req: Request, value: string, expires: Date) {
  res.cookies.set(SESSION_COOKIE, value, { httpOnly: true, sameSite: 'lax', secure: isHttps(req), path: '/', expires });
}

export function clearSessionCookie(res: NextResponse, req: Request) {
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'lax', secure: isHttps(req), path: '/', expires: new Date(0) });
}

export function clientAddress(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'local';
}
