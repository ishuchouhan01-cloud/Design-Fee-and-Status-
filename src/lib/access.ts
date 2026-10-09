/**
 * Who may open which screen and call which API, by sign-in role.
 *
 *   Viewer       Project Drawing Status (read only) and Switch User.
 *   Admin        + Billing, Import, Export and Edit Mode.
 *   Super Admin  everything.
 *
 * These are the shared role sign-ins. A personal sign-in (role MEMBER,
 * lib/members) is decided per project by `can()` (lib/members/policy, gate);
 * the matrix below refuses MEMBER on its own.
 *
 * This file has no server imports: the middleware (edge) and the API layer
 * (Node) use the same rules. The API layer also checks the existing
 * permissions (lib/rbac) — this is an extra gate, never a replacement.
 */
export const LOGIN_ROLES = ['VIEWER', 'ADMIN', 'SUPER_ADMIN'] as const;
export type LoginRole = (typeof LOGIN_ROLES)[number];

export const LOGIN_ROLE_LABEL: Record<LoginRole, string> = { VIEWER: 'Viewer', ADMIN: 'Admin', SUPER_ADMIN: 'Super Admin' };

/** Every role a session cookie can carry: the shared sign-ins and MEMBER (personal email sign-in). */
export const SESSION_ROLES = [...LOGIN_ROLES, 'MEMBER'] as const;
export type SessionRole = (typeof SESSION_ROLES)[number];
export const SESSION_ROLE_LABEL: Record<SessionRole, string> = { ...LOGIN_ROLE_LABEL, MEMBER: 'Member' };

export function isSessionRole(v: unknown): v is SessionRole {
  return typeof v === 'string' && (SESSION_ROLES as readonly string[]).includes(v);
}

export const SESSION_COOKIE = 'pds_session';

export function isLoginRole(v: unknown): v is LoginRole {
  return typeof v === 'string' && (LOGIN_ROLES as readonly string[]).includes(v);
}

/** Paths open without signing in. */
export function isPublicPath(pathname: string): boolean {
  return (
    pathname === '/login' ||
    pathname === '/api/auth/login' ||
    pathname === '/api/auth/logout' ||
    pathname === '/api/auth/invite' ||
    pathname.startsWith('/invite/') ||
    pathname === '/api/health' ||
    pathname.startsWith('/_next/') ||
    pathname === '/icon.svg' ||
    pathname === '/favicon.ico'
  );
}

/** The screen each role starts on. */
export function homeFor(role: SessionRole): string {
  return role === 'SUPER_ADMIN' ? '/' : '/drawings';
}

const under = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

/** Screens (page routes). */
export function pageAllowed(role: SessionRole, pathname: string, search = ''): boolean {
  if (role === 'MEMBER') return false;
  if (role === 'SUPER_ADMIN') return true;
  if (pathname === '/login' || under(pathname, '/settings')) return true;
  if (pathname === '/drawings') {
    // The DFS Summary, Year / Quarter and Drawing list tabs are Super Admin screens.
    const view = new URLSearchParams(search).get('view');
    return !view || view === 'tree';
  }
  if (role === 'ADMIN') return pathname === '/billing' || under(pathname, '/import-centre');
  return false;
}

/** API routes. */
export function apiAllowed(role: SessionRole, method: string, pathname: string, search = ''): boolean {
  if (role === 'MEMBER') return false;
  const m = method.toUpperCase();
  const read = m === 'GET' || m === 'HEAD';
  if (under(pathname, '/api/auth')) return true;
  if (pathname === '/api/health') return true;
  if (role === 'SUPER_ADMIN') return true;
  const sp = new URLSearchParams(search);

  // Every signed-in role: the status tree and a discipline's drawings.
  if (read && pathname === '/api/dfs') {
    const view = sp.get('view');
    if (!view || view === 'rows') return true;
  }
  if (read && pathname === '/api/dfs/unit-drawings') return true;
  if (role === 'VIEWER') return false;

  // Admin
  if (read && pathname === '/api/dfs/export') return true;
  if (read && pathname === '/api/export') return sp.get('kind') === 'drawings';
  if (under(pathname, '/api/import-centre')) return true;
  if (under(pathname, '/api/status')) return m !== 'DELETE';
  if (pathname === '/api/reschedule' && m === 'POST') return true;
  if (pathname === '/api/dfs/applicability' && m === 'POST') return true;
  if (pathname === '/api/drawings') return read || m === 'POST';
  if (/^\/api\/drawings\/[^/]+$/.test(pathname)) return read || m === 'PATCH';
  if (/^\/api\/drawings\/[^/]+\/(release|unrelease|revisions|dependencies)$/.test(pathname)) return m !== 'DELETE';
  if (/^\/api\/drawing-dependencies\/[^/]+$/.test(pathname)) return m === 'PATCH';
  return false;
}

// ---------------------------------------------------------------------------
// The session cookie: `<token>.<role>.<expires ms>.<signature>`. The signature
// (HMAC-SHA-256 with SESSION_SECRET) lets the middleware check the role and
// expiry without the database; the server also checks the session row.
// ---------------------------------------------------------------------------

export interface CookieClaims {
  token: string;
  role: SessionRole;
  expires: number;
}

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export async function signCookie(c: CookieClaims, secret: string): Promise<string> {
  const body = `${c.token}.${c.role}.${c.expires}`;
  return `${body}.${await hmac(secret, body)}`;
}

/** The claims of a well-signed, unexpired cookie; null otherwise. */
export async function readCookie(value: string | undefined | null, secret: string, now = Date.now()): Promise<CookieClaims | null> {
  if (!value || !secret) return null;
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const [token, role, exp, sig] = parts;
  if (!isSessionRole(role) || !/^\d+$/.test(exp) || !/^[A-Za-z0-9_-]{20,}$/.test(token)) return null;
  const want = await hmac(secret, `${token}.${role}.${exp}`);
  if (want.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  const expires = Number(exp);
  if (expires <= now) return null;
  return { token, role, expires };
}

export function cookieFromHeader(header: string | null | undefined, name = SESSION_COOKIE): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
