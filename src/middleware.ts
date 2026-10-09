/**
 * Every request: signed in, and allowed by the one rule (lib/members/gate →
 * policy `can`), read from the session in the database.
 *   No valid session → the sign-in screen (pages) or 401 (API).
 *   Not allowed      → 403 (pages and API).
 * The server checks again (lib/api context(), the layout) and every handler
 * checks the project of the row it touches; this is the first gate.
 *
 * Runs on the Node.js runtime (stable since Next.js 15.5) so it can read the
 * session, the member and their project switches from the database.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { isPublicPath, readCookie, SESSION_COOKIE } from '@/lib/access';

const FORBIDDEN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not available</title><link rel="icon" href="/icon.svg" type="image/svg+xml">
<style>body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#f6f7f9;color:#1f2937;display:grid;place-items:center;min-height:100vh;margin:0}
main{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:28px 32px;max-width:26rem;text-align:center}h1{font-size:16px;margin:0 0 8px}p{font-size:13px;color:#4b5563}a{color:#1d4ed8}</style></head>
<body><main><h1>This screen is not part of your access</h1><p>Your sign-in cannot open this screen.</p><p><a href="/drawings">Project Drawing Status</a> · <a href="/login?switch=1">Switch User</a></p></main></body></html>`;

function unauthenticated(req: NextRequest, api: boolean) {
  const { pathname, search } = req.nextUrl;
  if (api) return NextResponse.json({ error: 'Please sign in to continue.', code: 'UNAUTHENTICATED' }, { status: 401 });
  const to = new URL('/login', req.url);
  if (pathname !== '/') to.searchParams.set('next', `${pathname}${search}`);
  return NextResponse.redirect(to);
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();
  const api = pathname.startsWith('/api/');
  // The signature and expiry first (no database for a forged or expired cookie) …
  const claims = await readCookie(req.cookies.get(SESSION_COOKIE)?.value, process.env.SESSION_SECRET ?? '');
  if (!claims) return unauthenticated(req, api);
  // … then the session, the person and their access, from the database.
  const [{ getCurrentUser, UnauthenticatedError }, { homeOf, routeAllowed }] = await Promise.all([import('@/lib/auth'), import('@/lib/members/gate')]);
  let user;
  try {
    user = await getCurrentUser(req.headers);
  } catch (e) {
    if (e instanceof UnauthenticatedError) return unauthenticated(req, api);
    throw e;
  }
  if (api) {
    if (!routeAllowed(user, 'api', req.method, pathname, search)) {
      return NextResponse.json({ error: 'Your access does not include this.', code: 'FORBIDDEN' }, { status: 403 });
    }
    return NextResponse.next();
  }
  const home = user.member || user.emergency ? homeOf(user.principal) : user.loginRole === 'SUPER_ADMIN' ? '/' : '/drawings';
  if (pathname === '/' && home !== '/') return NextResponse.redirect(new URL(home, req.url));
  if (!routeAllowed(user, 'page', req.method, pathname, search)) {
    return new NextResponse(FORBIDDEN_PAGE, { status: 403, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  // The layout checks the page again against the database session.
  const headers = new Headers(req.headers);
  headers.set('x-pds-path', pathname);
  headers.set('x-pds-search', search);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  runtime: 'nodejs',
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
};
