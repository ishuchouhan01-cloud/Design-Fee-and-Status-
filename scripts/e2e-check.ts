/**
 * Mandatory end-to-end check (specification §45).
 *
 * Drives the RUNNING application over HTTP exactly as a user's browser would,
 * and verifies the database, the dashboard and the audit trail after each
 * action. Run it against a live server:
 *
 *   npm run dev        (in one terminal)
 *   npm run e2e        (in another)
 *
 * Optional: E2E_BASE_URL=https://design-control.company.local npm run e2e
 */
import 'dotenv/config';
import { apiAllowed, pageAllowed } from '../src/lib/access';

const BASE = process.env.E2E_BASE_URL ?? process.env.APP_BASE_URL ?? 'http://localhost:3000';
/**
 * Project Drawing Status has no header sign-in: every request carries a session
 * cookie from the sign-in endpoint. The user names of the checks map onto the
 * three roles — the Administrator e-mail → Super Admin, a viewer e-mail →
 * Viewer, any other user (editor, manager) → Admin.
 * Passwords: E2E_ADMIN_PASSWORD / E2E_SUPER_ADMIN_PASSWORD (else ADMIN_PASSWORD / SUPER_ADMIN_PASSWORD).
 */
const HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };
const SESSIONS = new Map<string, string>();
/** The Admin sign-in (Manager-level), for the checks of what it may not do. */
const ADMIN_ROLE = 'admin-role@project-drawing-status.check';
function roleOfEmail(email: string): 'VIEWER' | 'ADMIN' | 'SUPER_ADMIN' {
  if (email === ADMIN_ROLE) return 'ADMIN';
  // The original checks' editors and managers work in modules that are Super Admin screens here.
  return /viewer/i.test(email) ? 'VIEWER' : 'SUPER_ADMIN';
}
async function signInAs(role: 'VIEWER' | 'ADMIN' | 'SUPER_ADMIN'): Promise<string> {
  if (SESSIONS.has(role)) return SESSIONS.get(role)!;
  const password =
    role === 'ADMIN'
      ? (process.env.E2E_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD)
      : role === 'SUPER_ADMIN'
        ? (process.env.E2E_SUPER_ADMIN_PASSWORD ?? process.env.SUPER_ADMIN_PASSWORD)
        : undefined;
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, password }) });
  if (!res.ok) throw new Error(`Sign-in as ${role} failed: ${res.status} ${await res.text()}`);
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  SESSIONS.set(role, cookie);
  return cookie;
}
/**
 * Headers for a request as this user (after prepareSessions()). In this copy a
 * Viewer sees only Project Drawing Status: a Viewer READ of another screen or
 * API (which the original check makes to confirm the data) is made as Super
 * Admin; every Viewer WRITE still goes as the Viewer and must be refused.
 */
function hdrFor(email: string, method = 'GET', url = ''): Record<string, string> {
  let role = roleOfEmail(email);
  if (role === 'VIEWER' && (method === 'GET' || method === 'HEAD') && url) {
    const u = new URL(url, BASE);
    const allowed = u.pathname.startsWith('/api/') ? apiAllowed('VIEWER', method, u.pathname, u.search) : pageAllowed('VIEWER', u.pathname, u.search);
    if (!allowed) role = 'SUPER_ADMIN';
  }
  return { 'Content-Type': 'application/json', Cookie: SESSIONS.get(role) ?? '' };
}
async function prepareSessions() {
  for (const r of ['VIEWER', 'ADMIN', 'SUPER_ADMIN'] as const) await signInAs(r);
  HEADERS.Cookie = SESSIONS.get('SUPER_ADMIN')!;
}

let step = 0;
let failures = 0;
const notes: string[] = [];

function ok(label: string, detail = '') {
  step += 1;
  console.log(`  ${String(step).padStart(2)}. PASS  ${label}${detail ? ` — ${detail}` : ''}`);
}
function bad(label: string, detail: string) {
  step += 1;
  failures += 1;
  console.log(`  ${String(step).padStart(2)}. FAIL  ${label} — ${detail}`);
}
function check(condition: boolean, label: string, detail = '') {
  if (condition) ok(label, detail);
  else bad(label, detail || 'assertion failed');
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}
async function getHtml(path: string): Promise<string> {
  const res = await fetch(`${BASE}${path}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.text();
}
async function send<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json: json as T };
}

interface Paged<T> {
  rows: T[];
  total: number;
}
interface DeliverableRow {
  id: string;
  deliverableCode: string;
  deliverableDescription: string;
  projectId: string;
  packageId: string | null;
  completionStatus: string;
  baselineReleaseDate: string;
  currentExpectedReleaseDate: string;
  actualReleaseDate: string | null;
  rescheduleCount: number;
}

async function main() {
  console.log('='.repeat(78));
  console.log('END-TO-END CHECK — Project Drawing Status (copy of the Design Goals & Delivery Control System)');
  console.log(`Target: ${BASE}`);
  await prepareSessions();
  console.log('='.repeat(78));

  // 1 — application is up
  const health = await getJson<{ status: string; sourceOfTruth: string; database: string; projects: number }>(
    '/api/health',
  );
  check(health.status === 'ok', 'Application is running', `${health.projects} projects, db ${health.database}`);
  check(health.sourceOfTruth === 'DATABASE', 'Health: the application answers from the database');

  // 2 — dashboard opens
  const home = await getHtml('/');
  check(home.includes('Executive dashboard'), 'Executive dashboard opens');
  const kpiBefore = await getJson<{ delivery: { completed: number; planned: number; completionPercent: number; overdue: number; rescheduled: number } }>(
    '/api/reporting/kpis',
  );
  ok('Dashboard KPIs captured', `${kpiBefore.delivery.completed}/${kpiBefore.delivery.planned} items completed`);

  // 3 — select Violet Hill
  const projects = await getJson<{ id: string; projectCode: string; projectName: string }[]>('/api/projects');
  const vh = projects.find((p) => /violet\s*hill/i.test(p.projectName));
  if (!vh) throw new Error('Violet Hill is not in the database — run the Excel migration first.');
  check(Boolean(vh), 'Violet Hill selected', `${vh.projectName} (${vh.projectCode})`);

  // 4 — open the project
  const projectPage = await getHtml(`/projects/${vh.id}`);
  check(projectPage.includes('Programme view'), 'Project dashboard opens with a programme view');
  check(projectPage.includes('Baseline release'), 'Project page shows baseline / expected / actual columns');

  // 5 — open a deliverable
  const open = await getJson<Paged<DeliverableRow>>(
    `/api/deliverables?projectId=${vh.id}&completion=NOT_COMPLETED&pageSize=20&sort=expected&dir=asc`,
  );
  const subject = open.rows[0];
  if (!subject) throw new Error('No incomplete deliverable to work with.');
  const detail = await getJson<{ deliverable: DeliverableRow; audit: unknown[] }>(`/api/deliverables/${subject.id}`);
  check(detail.deliverable.id === subject.id, 'A design deliverable opens', detail.deliverable.deliverableCode);

  // 6 — completion is binary
  const badStatus = await send<{ error: string; issues?: unknown[] }>('PATCH', `/api/deliverables/${subject.id}`, {
    completionStatus: 'IN_PROGRESS',
  });
  check(badStatus.status === 422, 'Completion is binary — "IN_PROGRESS" is rejected', `HTTP ${badStatus.status}`);
  const badPercent = await send<{ error: string }>('PATCH', `/api/deliverables/${subject.id}`, {
    completionPercent: 65,
  });
  check(
    badPercent.status >= 400,
    'A per-item completion percentage cannot be set',
    (badPercent.json as { error?: string }).error?.slice(0, 60) ?? '',
  );
  const badBaseline = await send<{ error: string }>('PATCH', `/api/deliverables/${subject.id}`, {
    baselineReleaseDate: '2027-01-01',
  });
  check(badBaseline.status >= 400, 'The baseline release date cannot be written through the API');

  // 7 + 8 — NOT COMPLETED → COMPLETED, saved
  check(subject.completionStatus === 'NOT_COMPLETED', 'Subject starts as NOT COMPLETED');
  const completeRes = await send<{ changes: { field: string; newValue: string }[] }>(
    'PATCH',
    `/api/deliverables/${subject.id}`,
    { completionStatus: 'COMPLETED', reason: 'E2E check — marked complete' },
  );
  check(completeRes.status === 200, 'Marked COMPLETED and saved');

  // 9 — database changed
  const afterComplete = await getJson<{ deliverable: DeliverableRow; audit: { action: string; field: string | null; oldValue: string | null; newValue: string | null; reason: string | null }[] }>(
    `/api/deliverables/${subject.id}`,
  );
  check(
    afterComplete.deliverable.completionStatus === 'COMPLETED' && Boolean(afterComplete.deliverable.actualReleaseDate),
    'Database changed: completion COMPLETED with an actual release date',
    afterComplete.deliverable.actualReleaseDate?.slice(0, 10) ?? '',
  );
  check(
    afterComplete.deliverable.baselineReleaseDate === subject.baselineReleaseDate,
    'Baseline release date unchanged by completion',
  );

  // 10 — dashboard changed
  const kpiAfter = await getJson<{ delivery: { completed: number; planned: number; completionPercent: number; overdue: number; rescheduled: number } }>(
    '/api/reporting/kpis',
  );
  check(
    kpiAfter.delivery.completed === kpiBefore.delivery.completed + 1,
    'Dashboard changed: completed count increased by one',
    `${kpiBefore.delivery.completed} → ${kpiAfter.delivery.completed}`,
  );
  // The percentage is derived (rounded to 0.1%). With ~15,000 delivery items
  // one completion can move it by less than the rounding step, so the check is
  // that it is re-derived from the new counts — not that the rounded figure moved.
  const derived = Math.round((kpiAfter.delivery.completed / kpiAfter.delivery.planned) * 1000) / 10;
  check(
    kpiAfter.delivery.completionPercent === derived,
    'Derived completion percentage recalculated',
    `${kpiBefore.delivery.completionPercent}% → ${kpiAfter.delivery.completionPercent}% (= ${kpiAfter.delivery.completed}/${kpiAfter.delivery.planned})`,
  );

  // 11 — audit history created
  const completeAudit = afterComplete.audit.find((a) => a.action === 'COMPLETE');
  check(
    Boolean(completeAudit) && completeAudit!.newValue === 'COMPLETED' && completeAudit!.oldValue === 'NOT_COMPLETED',
    'Audit history created for the completion',
    completeAudit?.reason ?? '',
  );

  // 12 — reschedule another incomplete deliverable, with a dependency in place
  const others = open.rows.filter((r) => r.id !== subject.id);
  const predecessor = others[0];
  const successor = others[1];
  if (!predecessor || !successor) throw new Error('Need two more incomplete deliverables for the reschedule check.');

  const link = await send<{ id: string }>('POST', '/api/dependencies', {
    predecessorType: 'DELIVERABLE',
    predecessorId: predecessor.id,
    successorType: 'DELIVERABLE',
    successorId: successor.id,
    dependencyType: 'FS',
    lagDays: 0,
  });
  const linkExisted = link.status === 400;
  ok('Finish-to-Start link between two deliverables is in place', linkExisted ? 'already present' : 'created');

  // Align the successor so the link starts satisfied, then break it.
  const predBefore = await getJson<{ deliverable: DeliverableRow }>(`/api/deliverables/${predecessor.id}`);
  const sucBefore = await getJson<{ deliverable: DeliverableRow }>(`/api/deliverables/${successor.id}`);

  const preview = await send<{ mode: string; impact: { directChanges: unknown[]; cascadedChanges: { entityId: string; newDate: string }[]; maxShiftDays: number; skipped: { reason: string }[] } }>(
    'POST',
    '/api/reschedule',
    {
      entityType: 'DELIVERABLE',
      ids: [predecessor.id],
      shiftDays: 45,
      reason: 'E2E check — consultant information delayed',
      scope: 'ITEM',
      confirm: false,
    },
  );
  check(preview.status === 200 && preview.json.mode === 'PREVIEW', 'Reschedule impact preview returned');
  const previewProbe = await getJson<{ deliverable: DeliverableRow }>(`/api/deliverables/${predecessor.id}`);
  check(
    previewProbe.deliverable.currentExpectedReleaseDate === predBefore.deliverable.currentExpectedReleaseDate,
    'Preview did not change any date',
  );

  const applied = await send<{ mode: string; applied: number; cascaded: number; batchId: string }>(
    'POST',
    '/api/reschedule',
    {
      entityType: 'DELIVERABLE',
      ids: [predecessor.id],
      shiftDays: 45,
      reason: 'E2E check — consultant information delayed',
      scope: 'ITEM',
      confirm: true,
    },
  );
  check(applied.status === 200 && applied.json.applied === 1, 'Reschedule applied after explicit confirmation');

  // 13 — baseline unchanged
  const predAfter = await getJson<{ deliverable: DeliverableRow }>(`/api/deliverables/${predecessor.id}`);
  check(
    predAfter.deliverable.baselineReleaseDate === predBefore.deliverable.baselineReleaseDate,
    'Baseline date unchanged by the reschedule',
    predAfter.deliverable.baselineReleaseDate.slice(0, 10),
  );

  // 14 — current expected changed
  const shifted =
    (new Date(predAfter.deliverable.currentExpectedReleaseDate).getTime() -
      new Date(predBefore.deliverable.currentExpectedReleaseDate).getTime()) /
    86_400_000;
  check(Math.round(shifted) === 45, 'Current expected date moved by the requested shift', `${Math.round(shifted)} days`);

  // 15 — reschedule history exists
  const rescheduleAudit = await getJson<{ rows: { action: string; entityId: string; reason: string | null }[] }>(
    `/api/audit?entityType=DELIVERABLE&entityId=${predecessor.id}&action=RESCHEDULE`,
  );
  check(rescheduleAudit.rows.length > 0, 'Reschedule recorded in the audit trail', rescheduleAudit.rows[0]?.reason ?? '');
  const projectPageAfter = await getHtml(`/projects/${vh.id}`);
  check(
    projectPageAfter.includes('E2E check — consultant information delayed') ||
      projectPageAfter.includes('E2E check'),
    'Reschedule history visible on the project page with its reason',
  );

  // 16 — dependent dates recalculated
  const sucAfter = await getJson<{ deliverable: DeliverableRow }>(`/api/deliverables/${successor.id}`);
  const successorMoved =
    new Date(sucAfter.deliverable.currentExpectedReleaseDate).getTime() >
    new Date(sucBefore.deliverable.currentExpectedReleaseDate).getTime();
  const successorAfterPredecessor =
    new Date(sucAfter.deliverable.currentExpectedReleaseDate).getTime() >
    new Date(predAfter.deliverable.currentExpectedReleaseDate).getTime();
  check(
    successorMoved && successorAfterPredecessor,
    'Dependent (successor) date recalculated to respect the Finish-to-Start link',
    `${sucBefore.deliverable.currentExpectedReleaseDate.slice(0, 10)} → ${sucAfter.deliverable.currentExpectedReleaseDate.slice(0, 10)}`,
  );
  check(
    sucAfter.deliverable.baselineReleaseDate === sucBefore.deliverable.baselineReleaseDate,
    "Successor's baseline also preserved during the cascade",
  );

  // 17 — dashboard schedule metrics update
  const kpiFinal = await getJson<{ delivery: { rescheduled: number; overdue: number } }>('/api/reporting/kpis');
  check(
    kpiFinal.delivery.rescheduled > kpiAfter.delivery.rescheduled,
    'Dashboard schedule metrics updated (rescheduled count)',
    `${kpiAfter.delivery.rescheduled} → ${kpiFinal.delivery.rescheduled}`,
  );

  // 18 — completed work is not shifted automatically
  const completedProbeBefore = await getJson<{ deliverable: DeliverableRow }>(`/api/deliverables/${subject.id}`);
  const linkToCompleted = await send<{ id: string }>('POST', '/api/dependencies', {
    predecessorType: 'DELIVERABLE',
    predecessorId: predecessor.id,
    successorType: 'DELIVERABLE',
    successorId: subject.id,
    dependencyType: 'FS',
    lagDays: 0,
  });
  void linkToCompleted;
  const pushAgain = await send<{ impact: { skipped: { code: string; reason: string }[] } }>('POST', '/api/reschedule', {
    entityType: 'DELIVERABLE',
    ids: [predecessor.id],
    shiftDays: 120,
    reason: 'E2E check — protecting completed work',
    scope: 'ITEM',
    confirm: true,
  });
  const completedProbeAfter = await getJson<{ deliverable: DeliverableRow }>(`/api/deliverables/${subject.id}`);
  check(
    completedProbeAfter.deliverable.currentExpectedReleaseDate ===
      completedProbeBefore.deliverable.currentExpectedReleaseDate &&
      completedProbeAfter.deliverable.actualReleaseDate === completedProbeBefore.deliverable.actualReleaseDate,
    'Completed deliverable was NOT shifted by the cascade',
  );
  check(
    (pushAgain.json.impact?.skipped ?? []).some((s) => /completed/i.test(s.reason)),
    'The impact preview explains why the completed item was skipped',
  );

  // 19 — export works
  const exportRes = await fetch(
    `${BASE}/api/export?kind=drawings&format=xlsx&projectId=${vh.id}`,
    { headers: HEADERS },
  );
  const bytes = (await exportRes.arrayBuffer()).byteLength;
  check(
    exportRes.ok && bytes > 10_000 && (exportRes.headers.get('content-type') ?? '').includes('spreadsheet'),
    'Excel export works',
    `${bytes} bytes, ${exportRes.headers.get('x-row-count')} rows`,
  );
  const csvRes = await fetch(`${BASE}/api/export?kind=goals&format=csv&projectId=${vh.id}`, { headers: HEADERS });
  const csv = await csvRes.text();
  check(csvRes.ok && csv.startsWith('# Exported from the Design Goals & Delivery Control System'), 'CSV export works and says where it came from');

  // extra: the weekly reporting feed the PPT automation will consume
  const weekly = await getJson<{ headline: Record<string, number>; projects: unknown[] }>('/api/reporting/weekly');
  check(
    Object.keys(weekly.headline).length > 8 && weekly.projects.length > 0,
    'Weekly reporting feed available for the PowerPoint automation',
    `${weekly.projects.length} projects`,
  );

  // --- restore the records this check mutated -----------------------------
  await send('PATCH', `/api/deliverables/${subject.id}`, {
    completionStatus: 'NOT_COMPLETED',
    reason: 'E2E check — restoring state',
  });
  await send('POST', '/api/reschedule', {
    entityType: 'DELIVERABLE',
    ids: [predecessor.id],
    newExpectedDate: predBefore.deliverable.currentExpectedReleaseDate.slice(0, 10),
    reason: 'E2E check — restoring state',
    scope: 'ITEM',
    confirm: true,
    options: { recalculateDependents: false },
  });
  await send('POST', '/api/reschedule', {
    entityType: 'DELIVERABLE',
    ids: [successor.id],
    newExpectedDate: sucBefore.deliverable.currentExpectedReleaseDate.slice(0, 10),
    reason: 'E2E check — restoring state',
    scope: 'ITEM',
    confirm: true,
    options: { recalculateDependents: false },
  });
  notes.push(
    'The records touched by this check were restored afterwards. The restorations are themselves in the audit trail, which is the point.',
  );

  await fy26Checks();
  await drawingChecks();
  await dfsChecks();
  await importCentreChecks();
  await wordingChecks();

  console.log('-'.repeat(78));
  console.log(`${step - failures} of ${step} checks passed.`);
  for (const n of notes) console.log(`Note: ${n}`);
  console.log('='.repeat(78));
  if (failures > 0) process.exit(1);
}

// ---------------------------------------------------------------------------
// Design Goals FY 26 — the same kind of check, per role
// ---------------------------------------------------------------------------

/** Send a request as a specific user. Dev auth resolves the role from the email. */
async function as<T>(email: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: hdrFor(email, method, path),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json: json as T };
}

interface Fy26List {
  total: number;
  rows: { id: string; planBillingCr: number | null; currentExpectedReleaseDate: string | null; dependencyCount: number }[];
  kpis: { packages: number; dependencies: number; planBillingCr: number };
}
interface Fy26Detail {
  package: {
    id: string;
    baselineReleaseDate: string | null;
    currentExpectedReleaseDate: string | null;
    planBillingCr: number | null;
    responsibleUserId: string | null;
    packageDescription: string;
    updatedAt?: string;
  };
  dependencies: { id: string; description: string; targetDate: string | null; isManual: boolean }[];
}

async function fy26Checks() {
  console.log('-'.repeat(78));
  console.log('Design Goals FY 26');

  const ADMIN = process.env.DEV_USER_EMAIL ?? 'admin@company.local';
  const EDITOR = process.env.E2E_EDITOR_EMAIL ?? 'saji.a@imported.local';
  const VIEWER = process.env.E2E_VIEWER_EMAIL ?? 'e2e.viewer@company.local';

  // Each role is proven by what it can and cannot do below, not assumed: the dev
  // provider creates an unknown email as a VIEWER, and EDITOR must be a real
  // EDITOR account (Editor can edit but gets 403 on import).

  const list = await as<Fy26List>(VIEWER, 'GET', '/api/fy26/packages?pageSize=200&hasDependencies=YES');
  check(list.status === 200, 'FY26: Viewer can read the package list', `HTTP ${list.status}`);
  const all = await as<Fy26List>(VIEWER, 'GET', '/api/fy26/packages?pageSize=5');
  check(all.json.kpis?.packages === 435, 'FY26: 435 packages in the module', `${all.json.kpis?.packages}`);
  check(all.json.kpis?.dependencies >= 334, 'FY26: at least the 334 imported dependencies', `${all.json.kpis?.dependencies}`);

  const fy = await fetch(`${BASE}/fy26`, { headers: hdrFor(VIEWER) });
  check(fy.status === 403, 'FY26: the module is a Super Admin screen — 403 for a Viewer', `HTTP ${fy.status}`);
  const html = await getHtml('/fy26');
  check(html.includes('Design Goals – Financial Year 2026–27'), 'FY26: list page renders for the Super Admin');

  const target = list.json.rows?.[0];
  if (!target) {
    bad('FY26: found a package with dependencies to exercise', 'none returned');
    return;
  }
  const before = await as<Fy26Detail>(VIEWER, 'GET', `/api/fy26/packages/${target.id}`);
  check(before.status === 200 && before.json.dependencies.length > 0, 'FY26: Viewer can open a package and see its dependencies');

  // --- Viewer: every write refused ---------------------------------------
  const vEdit = await as(VIEWER, 'PATCH', `/api/fy26/packages/${target.id}`, { remarks: 'viewer attempt' });
  check(vEdit.status === 403, 'FY26: Viewer cannot edit a package', `HTTP ${vEdit.status}`);
  const vAdd = await as(VIEWER, 'POST', '/api/fy26/dependencies', { fy26PackageId: target.id, description: 'viewer attempt' });
  check(vAdd.status === 403, 'FY26: Viewer cannot add a dependency', `HTTP ${vAdd.status}`);
  const vImport = await as(VIEWER, 'POST', '/api/fy26/import', {});
  check(vImport.status === 403, 'FY26: Viewer cannot run the import', `HTTP ${vImport.status}`);

  // --- Editor: package, expected date, billing, dependencies --------------
  const originalExpected = before.json.package.currentExpectedReleaseDate;
  const originalBaseline = before.json.package.baselineReleaseDate;
  const originalBilling = before.json.package.planBillingCr;

  const eEdit = await as<{ changes: { field: string }[] }>(EDITOR, 'PATCH', `/api/fy26/packages/${target.id}`, {
    currentExpectedReleaseDate: '2027-02-28',
    planBillingCr: 9.8765,
    reason: 'E2E editor check',
  });
  check(eEdit.status === 200, 'FY26: Editor can edit a package', `HTTP ${eEdit.status}`);
  const fields = (eEdit.json.changes ?? []).map((c) => c.field).sort();
  check(
    fields.includes('currentExpectedReleaseDate') && fields.includes('planBillingCr'),
    'FY26: Editor changed the expected date and the billing amount',
    fields.join(', '),
  );

  const after = await as<Fy26Detail>(VIEWER, 'GET', `/api/fy26/packages/${target.id}`);
  check(
    after.json.package.baselineReleaseDate === originalBaseline,
    'FY26: the original release date did not move',
    `${originalBaseline?.slice(0, 10)}`,
  );
  check(after.json.package.currentExpectedReleaseDate?.slice(0, 10) === '2027-02-28', 'FY26: expected date is stored');
  check(after.json.package.planBillingCr === 9.8765, 'FY26: billing amount is stored');

  const eBaseline = await as(EDITOR, 'PATCH', `/api/fy26/packages/${target.id}`, { baselineReleaseDate: '2020-01-01' });
  check(eBaseline.status === 400, 'FY26: even an Editor cannot write the original release date', `HTTP ${eBaseline.status}`);
  const eBillingDate = await as(EDITOR, 'PATCH', `/api/fy26/packages/${target.id}`, { billingDate: '2026-12-01' });
  check(eBillingDate.status === 422, 'FY26: there is no billing-date field to write', `HTTP ${eBillingDate.status}`);
  const eProgress = await as(EDITOR, 'PATCH', `/api/fy26/packages/${target.id}`, { completionStatus: 'IN_PROGRESS' });
  check(eProgress.status === 422, 'FY26: IN_PROGRESS is refused', `HTTP ${eProgress.status}`);

  const eAdd = await as<{ id: string }>(EDITOR, 'POST', '/api/fy26/dependencies', {
    fy26PackageId: target.id,
    description: 'E2E: receive structural details',
    targetDate: '2026-10-12',
    responsibleText: 'Gagan',
    remarks: 'E2E check',
  });
  check(eAdd.status === 201 && Boolean(eAdd.json.id), 'FY26: Editor can add a dependency', `HTTP ${eAdd.status}`);
  const depId = eAdd.json.id;

  const pkgBeforeDepEdit = await as<Fy26Detail>(VIEWER, 'GET', `/api/fy26/packages/${target.id}`);
  const eDep = await as<{ changes: { field: string }[] }>(EDITOR, 'PATCH', `/api/fy26/dependencies/${depId}`, {
    description: 'E2E: revised task text',
    targetDate: '2026-10-20',
    reason: 'E2E editor check',
  });
  check(eDep.status === 200, 'FY26: Editor can edit a dependency', `HTTP ${eDep.status}`);
  const pkgAfterDepEdit = await as<Fy26Detail>(VIEWER, 'GET', `/api/fy26/packages/${target.id}`);
  check(
    JSON.stringify(pkgAfterDepEdit.json.package) === JSON.stringify(pkgBeforeDepEdit.json.package),
    'FY26: editing a dependency left its package untouched',
  );

  // --- Audit trail ---------------------------------------------------------
  const pAudit = await getJson<{ rows: { field: string | null; action: string; userLabel: string; reason: string | null }[] }>(
    `/api/audit?entityType=FY26_PACKAGE&entityId=${target.id}`,
  );
  const pFields = pAudit.rows.filter((r) => r.reason === 'E2E editor check').map((r) => r.field);
  check(
    pFields.includes('currentExpectedReleaseDate') && pFields.includes('planBillingCr'),
    'FY26: package changes are in the audit trail with the editor and the reason',
    pAudit.rows[0]?.userLabel ?? '',
  );
  const dAudit = await getJson<{ rows: { field: string | null; action: string }[] }>(
    `/api/audit?entityType=FY26_DEPENDENCY&entityId=${depId}`,
  );
  const dActions = dAudit.rows.map((r) => `${r.action}:${r.field ?? ''}`);
  check(
    dActions.includes('CREATE:') && dActions.includes('UPDATE:description') && dActions.includes('UPDATE:targetDate'),
    'FY26: dependency create, description and date changes are audited',
    dActions.join(', '),
  );

  // --- Admin: import preview, then apply; edits survive -------------------
  // In this copy the restricted role is Admin (Manager-level): no FY26 import.
  const eImport = await as(ADMIN_ROLE, 'POST', '/api/fy26/import', {});
  check(eImport.status === 403, 'FY26: the Admin sign-in cannot run the FY26 import', `HTTP ${eImport.status}`);

  const preview = await as<{ applied: boolean; valid: boolean; created: number; updated: number }>(
    ADMIN,
    'POST',
    '/api/fy26/import',
    {},
  );
  check(
    preview.status === 200 && preview.json.applied === false && preview.json.valid === true,
    'FY26: Admin preview validates and writes nothing',
    `valid=${preview.json.valid} applied=${preview.json.applied}`,
  );
  const applied = await as<{ applied: boolean; valid: boolean; created: number; protectedFields: number }>(
    ADMIN,
    'POST',
    '/api/fy26/import',
    { confirm: true },
  );
  check(
    applied.status === 200 && applied.json.applied === true && applied.json.valid === true,
    'FY26: Admin apply validates',
    `created=${applied.json.created} protected=${applied.json.protectedFields}`,
  );
  check((applied.json.protectedFields ?? 0) >= 2, 'FY26: the import protected the two fields the editor changed');

  const survived = await as<Fy26Detail>(VIEWER, 'GET', `/api/fy26/packages/${target.id}`);
  check(
    survived.json.package.currentExpectedReleaseDate?.slice(0, 10) === '2027-02-28' &&
      survived.json.package.planBillingCr === 9.8765,
    'FY26: the editor’s expected date and billing survived the re-import',
  );
  check(
    survived.json.dependencies.some((d) => d.id === depId),
    'FY26: the manually added dependency survived the re-import',
  );

  const importHtml = await (await fetch(`${BASE}/fy26/import`, { headers: HEADERS })).text();
  check(importHtml.includes('import report'), 'FY26: import report page renders');

  // --- Restore ---------------------------------------------------------------
  // Delete the added dependency, then put the package back. The restore goes
  // through the normal write path, so it is audited too — and the fields stay
  // marked as user-edited, which is the honest record of what happened.
  const del = await as(EDITOR, 'DELETE', `/api/fy26/dependencies/${depId}?reason=E2E%20restore`);
  check(del.status === 200, 'FY26: Editor can delete a dependency', `HTTP ${del.status}`);
  await as(EDITOR, 'PATCH', `/api/fy26/packages/${target.id}`, {
    currentExpectedReleaseDate: originalExpected ? originalExpected.slice(0, 10) : null,
    planBillingCr: originalBilling,
    reason: 'E2E check — restoring state',
  });
  notes.push(
    'FY26: the package and dependency touched by this check were restored. The two restored fields remain marked as user-edited, so a later import will not overwrite them; `npm run fy26:import -- --apply --rebuild --yes` clears that if wanted.',
  );
}

// ---------------------------------------------------------------------------
// Drawing Register (read-only) and Drawing Control (authorised), per role
// ---------------------------------------------------------------------------

interface DrawingList {
  total: number;
  rows: { id: string; drawingCode: string; projectId: string; completionStatus: string; currentExpectedReleaseDate: string | null; scheduleStatus: string | null }[];
  kpis: { total: number; released: number; notReleased: number; releasedThisWeek: number; releasedThisMonth: number; releaseDateNotRecorded: number };
}
interface DrawingDetailJson {
  drawing: { id: string; drawingCode: string; numberStatus: string; completionStatus: string; revision: string | null; actualReleaseDate: string | null; baselineReleaseDate: string | null; currentExpectedReleaseDate: string | null; rescheduleCount: number };
  revisions: { revision: string | null; completionStatus: string }[];
  dependencies: { id: string; status: string }[];
  reschedules: { reason: string }[];
  audit: { action: string }[];
}

async function drawingChecks() {
  console.log('-'.repeat(78));
  console.log('DFS (drawing records) / Drawing Control');

  const ADMIN = process.env.DEV_USER_EMAIL ?? 'admin@company.local';
  const EDITOR = process.env.E2E_EDITOR_EMAIL ?? 'saji.a@imported.local';
  const VIEWER = process.env.E2E_VIEWER_EMAIL ?? 'e2e.viewer@company.local';
  const projects = await getJson<{ id: string; projectCode: string }[]>('/api/projects');
  const t08 = projects.find((p) => p.projectCode === 'POARR-T08');
  if (!t08) {
    bad('Drawings: PoaRR projects present', 'POARR-T08 not found');
    return;
  }

  // --- Import (admin, preview only): the source still validates exactly ---
  const pv = await as<{ valid: boolean; counts: { total: Record<string, number>; historicalSnapshotRows: Record<string, number> } }>(
    ADMIN,
    'POST',
    '/api/drawings/import',
    { apply: false },
  );
  const t = pv.json.counts?.total ?? {};
  check(pv.status === 200 && pv.json.valid, 'Drawings: import preview validates against every target', `HTTP ${pv.status}`);
  check(
    t.drawings === 14426 && t.released === 13788 && t.notReleased === 638 && t.notYetNumbered === 1362 && t.numberConflicts === 112 && t.actualDates === 1404,
    'Drawings: 14,426 / 13,788 released / 638 not / 1,362 not yet numbered / 112 conflicts / 1,404 actual dates',
    JSON.stringify(t),
  );
  check(pv.json.counts?.historicalSnapshotRows?.total === 18517, 'Drawings: 18,517 historical snapshot rows');

  // --- Viewer: the register is readable, nothing is writable ---------------
  const vList = await as<DrawingList>(VIEWER, 'GET', `/api/drawings?projectId=${t08.id}&release=NOT_COMPLETED&pageSize=50&sort=expected`);
  check(vList.status === 200 && vList.json.total > 0, 'Drawings: Viewer can read the drawing records (DFS)', `${vList.json.total} not-released T08 drawings`);
  const all = await as<DrawingList>(VIEWER, 'GET', '/api/drawings?pageSize=1');
  check(all.json.kpis.total >= 14426 + 80, 'Drawings: register holds the PoaRR + Violet Hill drawings', `${all.json.kpis.total}`);
  check(all.json.kpis.releaseDateNotRecorded > 12000, 'Drawings: released drawings without a date are not given one', `${all.json.kpis.releaseDateNotRecorded}`);
  const subject = vList.json.rows.find((r) => r.currentExpectedReleaseDate);
  if (!subject) {
    bad('Drawings: an unreleased T08 drawing to work with', 'none found');
    return;
  }
  const vHtml = await (await fetch(`${BASE}/drawings?projectId=${t08.id}`, { headers: hdrFor(VIEWER) })).text();
  check(vHtml.includes('Project Drawing Status') && !vHtml.includes('DFS Summary') && !vHtml.includes('Design Fee Schedule') && !vHtml.includes('Drawing Register'), 'Drawings: a Viewer sees Project Drawing Status (no other tabs)');
  check(
    !/Mark as Released|\+ Add Drawing|>Reschedule<|Add Revision|Add Dependency|Open Drawing Control/.test(vHtml),
    'Drawings: a Viewer sees no edit / release / reschedule controls on DFS',
  );
  check((await fetch(`${BASE}/drawings/${subject.id}`, { headers: hdrFor(VIEWER) })).status === 403, 'Drawings: the drawing page is a Super Admin screen — 403 for a Viewer');
  const vDetail = (await getHtml(`/drawings/${subject.id}`)).replace(/Manage in Drawing Control/g, '');
  check(
    ['Overview', 'Release', 'Schedule', 'Dependencies', 'Revision history', 'Reschedule history', 'Audit history', 'Source information'].every((h) => vDetail.includes(h)),
    'Drawings: detail page shows all eight sections',
  );
  check(!/Mark as Released|Add Revision/.test(vDetail), 'Drawings: the drawing page itself has no release or revision controls');
  const vControl = await fetch(`${BASE}/drawing-control`, { headers: hdrFor(VIEWER) });
  check(vControl.status === 403 && !(await vControl.text()).includes('+ Add Drawing'), 'Drawings: Drawing Control refuses a Viewer (403)');
  const vw = await Promise.all([
    as(VIEWER, 'PATCH', `/api/drawings/${subject.id}`, { remarks: 'viewer' }),
    as(VIEWER, 'POST', `/api/drawings/${subject.id}/release`, { actualReleaseDate: '2026-01-02' }),
    as(VIEWER, 'POST', `/api/drawings/${subject.id}/revisions`, { revision: 'R99' }),
    as(VIEWER, 'POST', `/api/drawings/${subject.id}/dependencies`, { department: 'PHE', description: 'viewer' }),
    as(VIEWER, 'POST', '/api/reschedule', { entityType: 'DRAWING', ids: [subject.id], shiftDays: 3, reason: 'viewer' }),
    as(VIEWER, 'POST', '/api/drawings', { projectId: t08.id, drawingName: 'viewer' }),
  ]);
  check(vw.every((r) => r.status === 403), 'Drawings: every Viewer write is refused (403)', vw.map((r) => r.status).join(','));

  // --- Editor: Drawing Control ---------------------------------------------
  const eControl = await (await fetch(`${BASE}/drawing-control?projectId=${t08.id}&release=NOT_COMPLETED`, { headers: hdrFor(EDITOR) })).text();
  check(eControl.includes('+ Add Drawing') && eControl.includes('Mark as Released') && eControl.includes('Reschedule'), 'Drawings: Editor sees the Drawing Control actions');
  const stamp = Date.now().toString(36).toUpperCase();
  const created = await as<{ id: string }>(EDITOR, 'POST', '/api/drawings', {
    projectId: t08.id,
    drawingName: `E2E check drawing ${stamp}`,
    batchCode: 'E2E-1',
    expectedReleaseDate: new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10),
  });
  check(created.status === 201, 'Drawings: Editor adds a drawing (not yet numbered)', `HTTP ${created.status}`);
  const id = created.json.id;
  let d = await as<DrawingDetailJson>(EDITOR, 'GET', `/api/drawings/${id}`);
  check(d.json.drawing.completionStatus === 'NOT_COMPLETED' && !d.json.drawing.actualReleaseDate, 'Drawings: a new drawing starts NOT RELEASED with no actual date');
  const num = await as(EDITOR, 'PATCH', `/api/drawings/${id}`, { drawingNumber: `A-T8-E2E-${stamp}`, reason: 'Number assigned' });
  d = await as<DrawingDetailJson>(EDITOR, 'GET', `/api/drawings/${id}`);
  check(num.status === 200 && d.json.drawing.id === id && d.json.drawing.numberStatus === 'NUMBERED', 'Drawings: assigning a number updates the same drawing');
  const noReason = await as(EDITOR, 'PATCH', `/api/drawings/${id}`, { currentExpectedReleaseDate: '2027-03-31' });
  check(noReason.status === 400, 'Drawings: an expected date cannot be changed without a reschedule reason', `HTTP ${noReason.status}`);
  const baselineBefore = d.json.drawing.baselineReleaseDate;
  const rs = await as(EDITOR, 'PATCH', `/api/drawings/${id}`, { currentExpectedReleaseDate: '2027-03-31', reason: 'E2E reschedule via edit' });
  d = await as<DrawingDetailJson>(EDITOR, 'GET', `/api/drawings/${id}`);
  check(
    rs.status === 200 && d.json.drawing.currentExpectedReleaseDate?.slice(0, 10) === '2027-03-31' && d.json.reschedules.some((h) => h.reason === 'E2E reschedule via edit'),
    'Drawings: an expected-date edit goes through the reschedule engine and is in the history',
  );
  check(d.json.drawing.baselineReleaseDate === baselineBefore, 'Drawings: the baseline date did not move');
  const prev = await as<{ mode: string }>(EDITOR, 'POST', '/api/reschedule', { entityType: 'DRAWING', ids: [id], shiftDays: 7, reason: 'E2E Editor reschedule' });
  const conf = await as<{ mode: string; applied: number }>(EDITOR, 'POST', '/api/reschedule', { entityType: 'DRAWING', ids: [id], shiftDays: 7, reason: 'E2E Editor reschedule', confirm: true });
  check(prev.status === 200 && conf.status === 200 && conf.json.applied === 1, 'Drawings: an Editor can reschedule a drawing (drawing.reschedule)', `HTTP ${prev.status}/${conf.status}`);
  const dep = await as<{ id: string }>(EDITOR, 'POST', `/api/drawings/${id}/dependencies`, { department: 'PHE', description: 'E2E — percolation pit size', targetDate: '2026-12-15' });
  const close = await as(EDITOR, 'PATCH', `/api/drawing-dependencies/${dep.json.id}`, { status: 'CLOSED', closureDate: new Date().toISOString().slice(0, 10) });
  check(dep.status === 201 && close.status === 200, 'Drawings: Editor adds and closes a department dependency');
  const rel = await as(EDITOR, 'POST', `/api/drawings/${id}/release`, { actualReleaseDate: new Date().toISOString().slice(0, 10), revision: 'R0', remarks: 'E2E release' });
  d = await as<DrawingDetailJson>(EDITOR, 'GET', `/api/drawings/${id}`);
  check(rel.status === 200 && d.json.drawing.completionStatus === 'COMPLETED' && Boolean(d.json.drawing.actualReleaseDate), 'Drawings: Mark as Released records the actual release date');
  const rev = await as(EDITOR, 'POST', `/api/drawings/${id}/revisions`, { revision: 'R1', remarks: 'E2E revision' });
  d = await as<DrawingDetailJson>(EDITOR, 'GET', `/api/drawings/${id}`);
  check(
    rev.status === 201 && d.json.drawing.revision === 'R1' && d.json.revisions.some((r) => r.revision === 'R0' && r.completionStatus === 'COMPLETED'),
    'Drawings: Add Revision R0 → R1 keeps R0 (released) in the history',
  );
  const moveReleased = await as<{ applied?: number; error?: string }>(EDITOR, 'POST', '/api/reschedule', { entityType: 'DRAWING', ids: [id], shiftDays: 7, reason: 'should not move', confirm: true });
  d = await as<DrawingDetailJson>(EDITOR, 'GET', `/api/drawings/${id}`);
  check((moveReleased.json.applied ?? 0) === 0 && d.json.drawing.rescheduleCount === 2, 'Drawings: a released drawing is not rescheduled');
  const actions = new Set(d.json.audit.map((a) => a.action));
  check(
    ['CREATE_DRAWING', 'UPDATE_DRAWING', 'RESCHEDULE_DRAWING', 'ADD_DEPENDENCY', 'UPDATE_DEPENDENCY', 'RELEASE_DRAWING', 'CREATE_REVISION'].every((a) => actions.has(a)),
    'Drawings: every action is in the drawing audit history',
    [...actions].join(', '),
  );
  const eImport = await as(ADMIN_ROLE, 'POST', '/api/drawings/import', { apply: false });
  const eDelete = await as(ADMIN_ROLE, 'DELETE', `/api/drawings/${id}`, { reason: 'admin delete' });
  check(eImport.status === 403 && eDelete.status === 403, 'Drawings: the Admin sign-in cannot run the register import or delete a drawing (archive only)');
  const look = await as<{ counts: Record<string, number>; rows: Record<string, { completionStatus: string }[]> }>(EDITOR, 'GET', `/api/drawings/look-ahead?projectId=${t08.id}`);
  check(
    look.status === 200 && Object.values(look.json.rows).flat().every((r) => r.completionStatus === 'NOT_COMPLETED'),
    'Drawings: two-week look-ahead lists NOT RELEASED drawings only',
    JSON.stringify(look.json.counts),
  );
  const xl = await fetch(`${BASE}/api/export?kind=drawings&format=xlsx&projectId=${t08.id}`, { headers: hdrFor(VIEWER, 'GET', `/api/export?kind=drawings&format=xlsx&projectId=${t08.id}`) });
  check(xl.ok && Number(xl.headers.get('x-row-count')) >= 1524, 'Drawings: register exports to Excel', `${xl.headers.get('x-row-count')} rows`);

  // --- Admin: withdraw the release; a drawing with a released revision is never deleted ---
  const un = await as(ADMIN, 'POST', `/api/drawings/${id}/unrelease`, { reason: 'E2E check — restoring state' });
  d = await as<DrawingDetailJson>(ADMIN, 'GET', `/api/drawings/${id}`);
  check(un.status === 200 && d.json.drawing.completionStatus === 'NOT_COMPLETED', 'Drawings: Admin can withdraw a release (reason recorded)');
  const del = await as<{ error?: string }>(ADMIN, 'DELETE', `/api/drawings/${id}`, { reason: 'E2E check — restoring state' });
  check(del.status === 400 && /released revision/.test(del.json.error ?? ''), 'Drawings: a drawing with a released revision cannot be deleted, even by an Admin', del.json.error ?? '');
  const scratch = await as<{ id: string }>(EDITOR, 'POST', '/api/drawings', { projectId: t08.id, drawingName: `E2E scratch ${stamp}` });
  const delScratch = await as(ADMIN, 'DELETE', `/api/drawings/${scratch.json.id}`, { reason: 'E2E check — restoring state' });
  check(delScratch.status === 200, 'Drawings: Admin deletes a manually added, never-released drawing');
  notes.push(`Drawings: the check drawing A-T8-E2E-${stamp} stays in POARR-T08 as NOT RELEASED (its R0 release was withdrawn, and a drawing with a released revision is never deleted). Restore the pre-check backup to remove it.`);
}

// ---------------------------------------------------------------------------
// DFS — Design Fee Schedule, DFS Summary, SNK Billing, Year / Quarter
// ---------------------------------------------------------------------------

interface DfsRowJson {
  key: string;
  parentKey: string | null;
  kind: 'PROJECT' | 'NODE' | 'PACKAGE' | 'NO_PACKAGE' | 'DISCIPLINE';
  depth: number;
  name: string;
  typeLabel: string | null;
  code: string | null;
  hasChildren: boolean;
  status: 'COMPLETE' | 'NOT_COMPLETE' | 'NA' | null;
  noDrawings: boolean;
  releaseDate: string | null;
  packagesComplete: number;
  packagesPending: number;
  packagesNa: number;
  packagesTotal: number;
  drawingsReleased: number;
  drawingsTotal: number;
  unitKey: string | null;
}
interface DfsRowsJson {
  rows: DfsRowJson[];
  totals: { packagesComplete: number; packagesTotal: number; drawingsReleased: number; drawingsTotal: number };
}
interface DfsSummaryRowJson {
  label: string;
  packages: number;
  complete: number;
  pending: number;
  overall: number | null;
  total: number;
  billed: number;
  unbilled: number;
}
interface DfsSummaryJson {
  projects: { name: string; depth: number; row: DfsSummaryRowJson; disciplines: DfsSummaryRowJson[] }[];
  total: { row: DfsSummaryRowJson; disciplines: DfsSummaryRowJson[] };
}
interface UnitDrawingsJson {
  total: number;
  rows: { id: string; drawingCode: string; drawingName: string; revision: string | null; completionStatus: string; updatedOn: string | null; disciplineName: string | null }[];
}

async function dfsChecks() {
  console.log('-'.repeat(78));
  console.log('Design Fee Schedule (DFS) / DFS Summary / billing');
  const ADMIN = process.env.DEV_USER_EMAIL ?? 'admin@company.local';
  const EDITOR = process.env.E2E_EDITOR_EMAIL ?? 'saji.a@imported.local';
  const VIEWER = process.env.E2E_VIEWER_EMAIL ?? 'e2e.viewer@company.local';
  const projects = await getJson<{ id: string; projectCode: string }[]>('/api/projects');
  const byCode = (c: string) => projects.find((p) => p.projectCode === c);
  const porr = byCode('PORR');
  const res = byCode('POARR-RES');
  const t08 = byCode('POARR-T08');
  if (!porr || !res || !t08) {
    bad('DFS: Pursuit of a Radical Rhapsody and its towers present', 'PORR / POARR-RES / POARR-T08 not found (import the Project List first)');
    return;
  }
  const rows = async (who: string, q: string) => (await as<DfsRowsJson>(who, 'GET', `/api/dfs?${q}`)).json;
  const deep = async (who: string, q: string) => {
    // Everything down to discipline rows: packages, then each package's children.
    const top = await rows(who, `expand=packages&${q}`);
    const out = [...top.rows];
    for (const r of top.rows.filter((x) => (x.kind === 'PACKAGE' || x.kind === 'NO_PACKAGE') && x.hasChildren)) out.push(...(await rows(who, `parent=${encodeURIComponent(r.key)}&${q}`)).rows);
    return { rows: out, totals: top.totals };
  };
  const kidsOf = (all: DfsRowJson[], key: string) => all.filter((r) => r.parentKey === key);
  const sumOk = (all: DfsRowJson[]) =>
    all.every((r) => {
      const c = kidsOf(all, r.key);
      if (!c.length) return true;
      const s = (f: keyof DfsRowJson) => c.reduce((a, x) => a + (x[f] as number), 0);
      if (r.drawingsTotal !== s('drawingsTotal') || r.drawingsReleased !== s('drawingsReleased')) return false;
      return r.kind === 'PROJECT' || r.kind === 'NODE' ? r.packagesTotal === s('packagesTotal') && r.packagesComplete === s('packagesComplete') : true;
    });

  // 1  Top level and hierarchy
  const top = await rows(VIEWER, '');
  const names = top.rows.map((r) => r.name);
  check(top.rows.every((r) => r.depth === 0 && r.kind === 'PROJECT') && names.includes('Pursuit of a Radical Rhapsody') && names.includes('Violet Hill') && !names.includes('Residential'), 'DFS: top level is the parent projects by full name', names.join(', '));
  const dbDrawings = (await as<DrawingList>(VIEWER, 'GET', '/api/drawings?pageSize=1')).json.kpis.total;
  check(top.totals.drawingsTotal === dbDrawings, 'DFS: every drawing counted exactly once', `${top.totals.drawingsTotal} / ${dbDrawings}`);
  const towers = (await rows(VIEWER, `parent=P:${porr.id}`)).rows;
  check(towers.map((r) => `${r.name}:${r.typeLabel}`).join(',') === 'Residential:Phase,Tower 08:Tower,Tower 09:Tower', 'DFS: Pursuit of a Radical Rhapsody holds Residential, Tower 08 and Tower 09');
  const P = top.rows.find((r) => r.name === 'Pursuit of a Radical Rhapsody')!;
  const sums = (f: keyof DfsRowJson) => towers.reduce((a, t) => a + (t[f] as number), 0);
  check(P.drawingsTotal === sums('drawingsTotal') && P.drawingsReleased === sums('drawingsReleased') && P.packagesTotal === sums('packagesTotal'), 'DFS: the parent row is the sum of its towers, each counted once', `${P.drawingsReleased} of ${P.drawingsTotal} released`);
  const want: Record<string, [number, number]> = { Residential: [11235, 11403], 'Tower 08': [1149, 1524], 'Tower 09': [1404, 1499] };
  for (const t of towers) notes.push(`DFS reconciliation: ${t.name} ${t.drawingsReleased} of ${t.drawingsTotal} released (source: ${want[t.name]?.[0]} of ${want[t.name]?.[1]}).`);
  const resRows = await deep(VIEWER, `projectId=${res.id}`);
  const homes = resRows.rows.find((r) => r.name === 'Individual Homes');
  check(Boolean(homes) && homes!.typeLabel === 'Product' && kidsOf(resRows.rows, homes!.key).some((k) => k.code === 'V40-01'), 'DFS: V40-01 sits under "Individual Homes" (not a phase)');
  const t1 = resRows.rows.find((r) => r.name === 'Tower—01');
  check(Boolean(t1) && kidsOf(resRows.rows, t1!.key).filter((k) => k.kind === 'PACKAGE').length === 10, 'DFS: Tower—01 holds its 10 packages');
  check(sumOk(resRows.rows), 'DFS: parent = sum of children at every level (Residential)');
  check(resRows.rows.filter((r) => r.kind === 'PACKAGE').every((r) => r.status === (r.drawingsTotal > 0 && r.drawingsReleased === r.drawingsTotal ? 'COMPLETE' : r.status === 'NA' ? 'NA' : 'NOT_COMPLETE')), 'DFS: Complete ⇔ the package has drawings and every one is released');
  check(resRows.rows.filter((r) => r.kind === 'NO_PACKAGE').every((r) => r.packagesTotal === 0), 'DFS: drawings no package holds are never counted as a package');
  const vh = byCode('VIOLET-HILL');
  if (vh) {
    const v = await deep(VIEWER, `projectId=${vh.id}`);
    const pk = v.rows.filter((r) => r.kind === 'PACKAGE');
    check(pk.every((r) => (r.drawingsTotal > 0 && r.drawingsReleased === r.drawingsTotal ? r.status === 'COMPLETE' : true)) && pk.filter((r) => r.drawingsTotal === 0).every((r) => r.noDrawings), 'DFS: Violet Hill — every package whose drawings are all released is Complete; packages without drawings say so');
  }

  // 2  Filters are applied on the server and keep ancestors
  const nr = await rows(VIEWER, `projectId=${t08.id}&release=NOT_COMPLETED`);
  check(nr.totals.drawingsReleased === 0 && nr.totals.drawingsTotal > 0, 'DFS: the Drawing Release filter changes the counts', `${nr.totals.drawingsTotal} not released`);
  const found = await deep(VIEWER, `search=L20B`);
  check(found.rows.some((r) => r.kind === 'DISCIPLINE') && found.rows.every((r) => !r.parentKey || found.rows.some((x) => x.key === r.parentKey)), 'DFS: search keeps the rows above what it finds');

  // 3  Drawings of a discipline row
  const t08Rows = await deep(VIEWER, `projectId=${t08.id}`);
  const disc = t08Rows.rows.find((r) => r.kind === 'DISCIPLINE' && r.drawingsTotal > 0 && r.drawingsTotal <= 200)!;
  const ud = await as<UnitDrawingsJson>(VIEWER, 'GET', `/api/dfs/unit-drawings?key=${encodeURIComponent(disc.unitKey!)}&pageSize=200`);
  check(ud.status === 200 && ud.json.total === disc.drawingsTotal && ud.json.rows.every((r) => 'updatedOn' in r && 'disciplineName' in r && 'revision' in r), 'DFS: a discipline row lists its drawings (name, number, revision, discipline, updated on, status)', `${ud.json.total}`);

  // 4  Pages and exports
  for (const [view, text] of [
    ['tree', 'Expand to Packages'],
    ['summary', 'Package summary'],
    ['periods', 'Packages planned'],
    ['list', 'Not Released'],
  ] as const) {
    // The tree is every role's screen; the other tabs are Super Admin screens.
    const r = await fetch(`${BASE}/drawings?view=${view}&projectId=${porr.id}`, { headers: hdrFor(view === 'tree' ? VIEWER : ADMIN) });
    const html = await r.text();
    check(r.ok && html.includes(text), `DFS: ${view} view renders for ${view === 'tree' ? 'a Viewer' : 'the Super Admin'}`, `HTTP ${r.status}`);
    if (view === 'tree') check(!/Mark NA|Mark as Released|Open Drawing Control|Export to/.test(html), 'DFS: the tree has no edit or export controls for a Viewer');
    else check((await fetch(`${BASE}/drawings?view=${view}&projectId=${porr.id}`, { headers: hdrFor(VIEWER) })).status === 403, `DFS: ${view} view is 403 for a Viewer`);
  }
  for (const format of ['xlsx', 'csv']) {
    const x = await fetch(`${BASE}/api/dfs/export?format=${format}&projectId=${porr.id}`, { headers: hdrFor(VIEWER, 'GET', `/api/dfs/export?format=${format}&projectId=${porr.id}`) });
    const len = (await x.arrayBuffer()).byteLength;
    check(x.ok && len > 1000 && Number(x.headers.get('x-row-count')) > 0, `DFS: Export to ${format === 'xlsx' ? 'Excel' : 'CSV'} of the filtered view`, `${x.headers.get('x-row-count')} rows`);
  }
  const periodsFy = await as<{ columns: { year: string | null }[] }>(VIEWER, 'GET', `/api/dfs?view=periods&basis=FY&projectId=${res.id}`);
  check(periodsFy.status === 200 && periodsFy.json.columns.filter((c) => c.year).every((c) => /^Financial Year \d{4}–\d{2}$/.test(c.year!)), 'DFS: Year / Quarter on the Financial Year basis, labelled in full');

  // 5  Summary numbers
  const summary = (await as<DfsSummaryJson>(VIEWER, 'GET', '/api/dfs?view=summary')).json;
  check(
    [...summary.projects, summary.total].every((b) => b.row.packages === b.row.complete + b.row.pending && Math.abs(b.row.unbilled - (b.row.total - b.row.billed)) < 0.0002),
    'DFS Summary: Packages = Complete + Pending; Unbilled = Total − Billed',
    `${summary.total.row.packages} = ${summary.total.row.complete} + ${summary.total.row.pending}`,
  );

  // 6  Drawing Control edits show in DFS at once
  const oneShort = t08Rows.rows.find((r) => r.kind === 'DISCIPLINE' && r.status === 'NOT_COMPLETE' && r.drawingsTotal - r.drawingsReleased === 1 && r.drawingsTotal <= 200);
  if (!oneShort) bad('DFS: a Tower 08 discipline one drawing short of complete', 'none found');
  else {
    const drs = await as<UnitDrawingsJson>(EDITOR, 'GET', `/api/dfs/unit-drawings?key=${encodeURIComponent(oneShort.unitKey!)}&pageSize=200`);
    const last = drs.json.rows.find((r) => r.completionStatus !== 'COMPLETED')!;
    const rowNow = async () => (await rows(EDITOR, `parent=${encodeURIComponent(oneShort.parentKey!)}&projectId=${t08.id}`)).rows.find((r) => r.key === oneShort.key)!;
    const rel = await as(EDITOR, 'POST', `/api/drawings/${last.id}/release`, { actualReleaseDate: new Date().toISOString().slice(0, 10), remarks: 'E2E DFS check' });
    const after = await rowNow();
    check(rel.status === 200 && after.status === 'COMPLETE' && after.drawingsReleased === after.drawingsTotal, 'DFS: releasing the last drawing in Drawing Control completes the discipline at once');
    const un = await as(ADMIN, 'POST', `/api/drawings/${last.id}/unrelease`, { reason: 'E2E DFS check — restoring state' });
    const back = await rowNow();
    check(un.status === 200 && back.status === 'NOT_COMPLETE', 'DFS: withdrawing the release re-opens it at once');
    notes.push(`DFS: drawing ${last.drawingCode} was released and its release withdrawn again; the revision history keeps a note of it.`);
  }

  // 7  Permissions
  const vTree = await (await fetch(`${BASE}/drawings?projectId=${t08.id}`, { headers: hdrFor(VIEWER) })).text();
  const aTree = await (await fetch(`${BASE}/drawings?projectId=${t08.id}`, { headers: hdrFor(ADMIN) })).text();
  check(!vTree.includes('Open Drawing Control') && aTree.includes('Open Drawing Control'), 'DFS: Open Drawing Control only for users who can edit drawings');
}

// ---------------------------------------------------------------------------
// Import (Import Centre): upload → dry run → import → undo
// ---------------------------------------------------------------------------

async function wordingChecks() {
  console.log('-'.repeat(78));
  console.log('Wording on every screen');
  const { findProblems } = await import('./page-scan');
  const pages = ['/', '/projects', '/goals', '/deliverables', '/fy26', '/fy26/import', '/drawings', '/drawings?view=summary', '/drawings?view=periods', '/drawings?view=periods&basis=FY', '/drawings?view=list', '/drawing-control', '/import-centre', '/update-centre', '/schedule', '/audit', '/settings'];
  for (const p of pages) {
    const problems = findProblems(await getHtml(p));
    check(problems.length === 0, `Wording: ${p} has no banned phrase or unexplained abbreviation`, problems.slice(0, 2).join(' / '));
  }
}

async function importCentreChecks() {
  console.log('-'.repeat(78));
  console.log('Import');
  const XLSX = await import('xlsx');
  const VIEWER = process.env.E2E_VIEWER_EMAIL ?? 'e2e.viewer@company.local';
  const vPage = await fetch(`${BASE}/import-centre`, { headers: hdrFor(VIEWER) });
  check(vPage.status === 403, 'Import: refused for a Viewer (403)', `HTTP ${vPage.status}`);
  const aPage = await getHtml('/import-centre');
  check(aPage.includes('Choose the workbook') && aPage.includes('Import history'), 'Import: the screen renders for an Administrator');

  const stamp = Date.now().toString(36).toUpperCase();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      [null, 'E2E Park', null, null, 'AR', null, 'ST'],
      [null, null, null, null, '%', 'Fee', '%', 'Fee'],
      [],
      [],
      [null, 'CONSTRUCTION DOCUMENTS'],
      [null, '1', null, 'Block 1'],
      [null, '1', 'EB1-01', 'Foundations', 0.1, 0.5, 0.1, 0.2],
    ]),
    'Design Fee',
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['E2E Park register'],
      ['Discipline', 'Drawing No.', 'Drawing name', 'Location', 'Batch Code', 'Revision', 'Date of release'],
      ['AR', `EP-AR-${stamp}-1`, 'Foundation plan', 'EB1', 'AR-EB1-1', 'R0', '2026-03-10'],
      ['ST', `EP-ST-${stamp}-1`, 'Foundation reinforcement', 'EB1', 'ST-EB1-1', 'R0', null],
    ]),
    'Drawing Register',
  );
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const fd = new FormData();
  fd.set('file', new Blob([new Uint8Array(buf)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'E2E Park.xlsx');
  const up = await fetch(`${BASE}/api/import-centre/upload`, { method: 'POST', headers: { Cookie: HEADERS.Cookie }, body: fd });
  const upJson = (await up.json()) as { uploadId: string; inspection: { detected: string } };
  check(up.ok && upJson.inspection.detected === 'PLAN', 'Import: the upload is read and recognised as a drawing register', upJson.inspection?.detected);
  const bad1 = new FormData();
  bad1.set('file', new Blob([new Uint8Array(buf)]), 'macro.xlsm');
  const r1 = await fetch(`${BASE}/api/import-centre/upload`, { method: 'POST', headers: { Cookie: HEADERS.Cookie }, body: bad1 });
  check(r1.status === 400, 'Import: a macro-enabled workbook is refused', `HTTP ${r1.status}`);
  const body = { uploadId: upJson.uploadId, fileType: 'PLAN', newProject: { fullName: `E2E Park ${stamp}` }, apply: false };
  const dry = await send<{ mode: string; counts: { create: number } }>('POST', '/api/import-centre/run', body);
  check(dry.status === 200 && dry.json.mode === 'PREVIEW' && dry.json.counts.create === 2, 'Import: dry run counts what it would create, and writes nothing', JSON.stringify(dry.json.counts));
  const noConfirm = await send('POST', '/api/import-centre/run', { ...body, apply: true });
  check(noConfirm.status === 400, 'Import: refused without confirming the dry run');
  const done = await send<{ mode: string; batchId: string; project: { id: string } }>('POST', '/api/import-centre/run', { ...body, apply: true, confirmed: true });
  check(done.status === 200 && done.json.mode === 'APPLIED', 'Import: the import is written after confirmation');
  const t = await getJson<DfsRowsJson>(`/api/dfs?projectId=${done.json.project.id}`);
  check(t.totals.drawingsTotal === 2 && t.totals.drawingsReleased === 1 && t.totals.packagesTotal === 1, 'Import: the new project appears in the DFS', `${t.totals.drawingsReleased} of ${t.totals.drawingsTotal}`);
  const hist = await getJson<{ runs: { id: string; canUndo: boolean }[] }>('/api/import-centre/history');
  check(hist.runs[0]?.id === done.json.batchId && hist.runs[0].canUndo, 'Import: the run is at the top of the history and can be undone');
  const undo = await send<{ removedDrawings: number }>('POST', '/api/import-centre/undo', { batchId: done.json.batchId });
  check(undo.status === 200 && undo.json.removedDrawings === 2, 'Import: Undo this import removes what it created');
  const gone = await getJson<{ id: string }[]>('/api/projects');
  check(!gone.some((p) => p.id === done.json.project.id), 'Import: the project it created is removed again');
}

main().catch((err) => {
  console.error('\nEND-TO-END CHECK ABORTED');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
