/**
 * Every request: signed in, and allowed for the sign-in role (lib/access).
 *   No valid session → the sign-in screen (pages) or 401 (API).
 *   Not allowed      → 403 (pages and API).
 * The server checks the session in the database again (lib/auth, lib/api);
 * this is the first gate, not the only one.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { apiAllowed, homeFor, isPublicPath, pageAllowed, readCookie, SESSION_COOKIE } from '@/lib/access';

const FORBIDDEN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not available</title><link rel="icon" href="/icon.svg" type="image/svg+xml">
<style>body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#f6f7f9;color:#1f2937;display:grid;place-items:center;min-height:100vh;margin:0}
main{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:28px 32px;max-width:26rem;text-align:center}h1{font-size:16px;margin:0 0 8px}p{font-size:13px;color:#4b5563}a{color:#1d4ed8}</style></head>
<body><main><h1>This screen is not part of your sign-in</h1><p>Your role cannot open this screen.</p><p><a href="/drawings">Project Drawing Status</a> · <a href="/login?switch=1">Switch User</a></p></main></body></html>`;

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();
  const api = pathname.startsWith('/api/');
  const claims = await readCookie(req.cookies.get(SESSION_COOKIE)?.value, process.env.SESSION_SECRET ?? '');
  if (!claims) {
    if (api) return NextResponse.json({ error: 'Please sign in to continue.', code: 'UNAUTHENTICATED' }, { status: 401 });
    const to = new URL('/login', req.url);
    if (pathname !== '/') to.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(to);
  }
  if (api) {
    if (!apiAllowed(claims.role, req.method, pathname, search)) {
      return NextResponse.json({ error: 'Your sign-in does not include this. Switch User to sign in with another role.', code: 'FORBIDDEN' }, { status: 403 });
    }
    return NextResponse.next();
  }
  if (pathname === '/' && claims.role !== 'SUPER_ADMIN') return NextResponse.redirect(new URL(homeFor(claims.role), req.url));
  if (!pageAllowed(claims.role, pathname, search)) {
    return new NextResponse(FORBIDDEN_PAGE, { status: 403, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  // The layout checks the page again against the database session.
  const headers = new Headers(req.headers);
  headers.set('x-pds-path', pathname);
  headers.set('x-pds-search', search);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
};
