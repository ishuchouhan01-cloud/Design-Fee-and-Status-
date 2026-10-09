/**
 * Who may do what, per project — the ONE rule (`can`) used by the middleware,
 * every screen, every API and every service that returns data. Modelled on
 * Autodesk Forma (ACC) Project Admin → Members.
 *
 *   Account Admin  all projects, all modules; manages every member, project,
 *                  company, role and setting (today's Super Admin)
 *   Project Admin  the projects where they hold it: every module of those
 *                  projects; manages their members, up to Project Admin
 *   Member         the projects they belong to: Project Drawing Status of
 *                  those projects; the module switches decide the rest
 *
 * Module switches per project membership: Drawing Status (always on),
 * Billing, Edit Mode, Import / Export, Planning (Dashboard, Goals, Design
 * Goals FY26, Schedule, Drawing Control, Update Centre). A Project Admin has
 * every switch on, locked.
 *
 * A membership on a project covers the projects under it ("Part of"): a
 * member of "After the Rain" sees its phases.
 *
 * The shared role sign-ins (Viewer, Admin, Super Admin) map onto the same
 * rule until they are switched off (LEGACY_ROLE_LOGINS): Super Admin = Account
 * Admin; Admin = every project with Billing, Edit Mode and Import / Export;
 * Viewer = every project, Drawing Status only.
 *
 * Pure: no database, no server imports (the middleware uses it too).
 */
export const ACCESS_LEVELS = ['project_admin', 'member'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export const SWITCHES = ['billing', 'edit', 'importExport', 'planning'] as const;
export type Switch = (typeof SWITCHES)[number];

/** status = Project Drawing Status (always on for a member of the project). */
export type Action = 'status' | Switch | 'members' | 'accountAdmin';

export const SWITCH_LABEL: Record<Switch, string> = { billing: 'Billing', edit: 'Edit Mode', importExport: 'Import / Export', planning: 'Planning' };
export const LEVEL_LABEL: Record<AccessLevel | 'account_admin', string> = { account_admin: 'Account Admin', project_admin: 'Project Admin', member: 'Member' };

export interface Grant {
  projectId: string;
  level: AccessLevel;
  billing: boolean;
  edit: boolean;
  importExport: boolean;
  planning: boolean;
}

export type LegacyRole = 'VIEWER' | 'ADMIN' | 'SUPER_ADMIN';

export interface Principal {
  kind: 'member' | 'legacy';
  memberId: string | null;
  accountAdmin: boolean;
  legacyRole: LegacyRole | null;
  grants: Grant[];
  /** project id → parent project id (the "Part of" hierarchy), for inheritance. */
  parentOf: Map<string, string | null>;
}

const LEGACY_ACTIONS: Record<LegacyRole, Action[]> = {
  SUPER_ADMIN: ['status', 'billing', 'edit', 'importExport', 'planning', 'members', 'accountAdmin'],
  ADMIN: ['status', 'billing', 'edit', 'importExport'],
  VIEWER: ['status'],
};

function grantAllows(g: Grant, action: Action): boolean {
  if (action === 'accountAdmin') return false;
  if (action === 'status') return true;
  if (g.level === 'project_admin') return true;
  if (action === 'members') return false;
  return g[action];
}

/** The project and every project above it ("Part of"), nearest first. */
export function lineage(projectId: string, parentOf: Map<string, string | null>): string[] {
  const out: string[] = [];
  for (let p: string | null | undefined = projectId, g = 0; p && g < 20 && !out.includes(p); p = parentOf.get(p), g++) out.push(p);
  return out;
}

/**
 * May this person do `action` — on `projectId`, or (no project given) on at
 * least one project? A project-specific write or read must pass its project.
 */
export function can(p: Principal, action: Action, projectId?: string | null): boolean {
  if (p.accountAdmin) return true;
  if (p.kind === 'legacy') return p.legacyRole ? LEGACY_ACTIONS[p.legacyRole].includes(action) : false;
  if (action === 'accountAdmin') return false;
  if (!projectId) return p.grants.some((g) => grantAllows(g, action));
  const up = new Set(lineage(projectId, p.parentOf));
  return p.grants.some((g) => up.has(g.projectId) && grantAllows(g, action));
}

/** True when every project the person can see is open to them (Account Admin, the shared sign-ins). */
export function allProjects(p: Principal, action: Action): boolean {
  if (p.accountAdmin) return true;
  return p.kind === 'legacy' && can(p, action);
}

/**
 * The projects where `action` is allowed: null = every project; else the
 * granted projects and every project below them.
 */
export function projectsFor(p: Principal, action: Action): Set<string> | null {
  if (allProjects(p, action)) return null;
  if (p.kind === 'legacy') return new Set();
  const childrenOf = new Map<string, string[]>();
  for (const [id, parent] of p.parentOf) if (parent) childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), id]);
  const out = new Set<string>();
  const add = (id: string) => {
    if (out.has(id)) return;
    out.add(id);
    for (const c of childrenOf.get(id) ?? []) add(c);
  };
  for (const g of p.grants) if (grantAllows(g, action)) add(g.projectId);
  return out;
}

/** The effective level and switches on one project (inherited from above), for display. */
export function effectiveGrant(p: Principal, projectId: string): (Grant & { accountAdmin: boolean }) | null {
  if (p.accountAdmin) return { projectId, level: 'project_admin', billing: true, edit: true, importExport: true, planning: true, accountAdmin: true };
  if (p.kind === 'legacy') return null;
  const up = new Set(lineage(projectId, p.parentOf));
  const hits = p.grants.filter((g) => up.has(g.projectId));
  if (!hits.length) return null;
  const admin = hits.some((g) => g.level === 'project_admin');
  return {
    projectId,
    level: admin ? 'project_admin' : 'member',
    billing: admin || hits.some((g) => g.billing),
    edit: admin || hits.some((g) => g.edit),
    importExport: admin || hits.some((g) => g.importExport),
    planning: admin || hits.some((g) => g.planning),
    accountAdmin: false,
  };
}

// ---------------------------------------------------------------------------
// Routes → the action they need (the project, where there is one, is checked
// by the handler against the row it touches)
// ---------------------------------------------------------------------------

/**
 * 'planningAll': the planning screens that list every project at once (Dashboard,
 * Goals, FY26, Schedule, Drawing Control, Update Centre). They are not yet cut
 * down per project, so they need Planning on every project; Planning on some
 * projects opens the per-project planning views (DFS Summary, Year / Quarter,
 * drawing changes), which are.
 */
export type RouteNeed = Action | 'planningAll' | 'public' | 'signedIn';

/** Planning on every top-level project (Account Admin, or a member granted it on each). */
export function planningEverywhere(p: Principal): boolean {
  if (allProjects(p, 'planning')) return true;
  if (p.kind === 'legacy') return false;
  const roots = [...p.parentOf].filter(([, parent]) => !parent).map(([id]) => id);
  return roots.length > 0 && roots.every((id) => can(p, 'planning', id));
}

const under = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

const PLANNING_PAGES = ['/projects', '/goals', '/deliverables', '/fy26', '/drawing-control', '/update-centre', '/schedule', '/dfs'];

export function pageNeed(pathname: string, search = ''): RouteNeed {
  if (pathname === '/login' || under(pathname, '/invite')) return 'public';
  if (under(pathname, '/settings/members') || under(pathname, '/settings/companies') || under(pathname, '/settings/roles')) return 'members';
  if (under(pathname, '/settings')) return 'signedIn';
  if (pathname === '/drawings') {
    // The DFS Summary, Year / Quarter and Drawing list tabs belong to Planning.
    const view = new URLSearchParams(search).get('view');
    return !view || view === 'tree' ? 'status' : 'planning';
  }
  if (under(pathname, '/drawings')) return 'planningAll';
  if (pathname === '/billing') return 'billing';
  if (under(pathname, '/import-centre')) return 'importExport';
  if (under(pathname, '/audit')) return 'accountAdmin';
  if (pathname === '/') return 'planningAll';
  if (PLANNING_PAGES.some((p) => under(pathname, p))) return 'planningAll';
  return 'accountAdmin';
}

export function apiNeed(method: string, pathname: string, search = ''): RouteNeed {
  const m = method.toUpperCase();
  const read = m === 'GET' || m === 'HEAD';
  const sp = new URLSearchParams(search);
  if (pathname === '/api/health') return 'public';
  if (['/api/auth/login', '/api/auth/logout', '/api/auth/invite'].includes(pathname)) return 'public';
  if (under(pathname, '/api/auth')) return 'signedIn';
  if (under(pathname, '/api/members') || under(pathname, '/api/companies') || under(pathname, '/api/job-roles')) return 'members';
  if (pathname === '/api/dfs') {
    if (!read) return 'accountAdmin';
    const view = sp.get('view');
    return !view || view === 'rows' ? 'status' : 'planning';
  }
  if (pathname === '/api/dfs/unit-drawings') return read ? 'status' : 'accountAdmin';
  if (pathname === '/api/dfs/export') return 'importExport';
  if (pathname === '/api/dfs/applicability') return 'edit';
  if (pathname === '/api/export') return sp.get('kind') === 'drawings' ? 'importExport' : 'planningAll';
  if (under(pathname, '/api/import-centre')) return 'importExport';
  if (pathname === '/api/status/reference' || pathname === '/api/status/people') return read ? 'status' : 'edit';
  if (under(pathname, '/api/status')) return m === 'DELETE' ? 'accountAdmin' : 'edit';
  if (pathname === '/api/reschedule') return read ? 'planning' : 'edit';
  if (pathname === '/api/drawings') return read ? 'planningAll' : 'edit';
  if (/^\/api\/drawings\/[^/]+$/.test(pathname)) return read ? 'status' : m === 'DELETE' ? 'planning' : 'edit';
  if (/^\/api\/drawings\/[^/]+\/(release|unrelease|revisions|dependencies)$/.test(pathname)) return read ? 'status' : 'edit';
  if (/^\/api\/drawing-dependencies\/[^/]+$/.test(pathname)) return 'edit';
  if (pathname === '/api/audit' || under(pathname, '/api/backup')) return 'accountAdmin';
  return 'planningAll';
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

export const PASSWORD_MIN = 12;

/** A short list of passwords people choose; a password on it (in any case) is refused. */
const COMMON = [
  'password', 'password1', 'password12', 'password123', 'password1234', 'passw0rd', 'p@ssw0rd', 'p@ssword123', 'qwerty', 'qwertyuiop', 'qwerty123', 'qwerty123456',
  '123456', '12345678', '123456789', '1234567890', '123456789012', '111111111111', '000000000000', 'abc123', 'abcd1234', 'abcdefghijkl', 'iloveyou', 'welcome',
  'welcome123', 'welcome@123', 'admin', 'admin123', 'admin@123', 'administrator', 'letmein', 'changeme', 'changeme123', 'monkey', 'dragon', 'football',
  'baseball', 'sunshine', 'princess', 'trustno1', 'superman', 'india@123', 'india12345', 'company123', 'qazwsxedcrfv', '1q2w3e4r5t6y', 'zaq12wsxcde3',
];

/** Why a password is refused; null when it is acceptable. */
export function passwordProblem(password: string, email: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > 200) return 'Use at most 200 characters.';
  const p = password.trim().toLowerCase();
  const e = email.trim().toLowerCase();
  if (p === e || p === e.split('@')[0]) return 'Do not use your email address as the password.';
  const bare = p.replace(/[^a-z0-9@]/g, '');
  if (COMMON.includes(p) || COMMON.includes(bare) || /^(.)\1+$/.test(p)) return 'This password is too common. Choose another.';
  return null;
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : (parts[0]?.[1] ?? ''))).toUpperCase();
}
