/**
 * Roles for the two drawing modules, checked at the permission table and at
 * the real API route handlers (the same functions Next.js serves).
 *
 *   Viewer   drawing.read
 *   Editor   drawing.read · write · complete · reschedule
 *   Manager  same as Editor (plus its non-drawing permissions)
 *   Admin    every drawing permission, including drawing.admin
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { drawings, projects, users } from '@/db/schema';
import { can, reschedulePermissionFor } from '@/lib/rbac';
import { newId } from '@/lib/ids';
import { startOfDay, addDays } from '@/lib/periods';
import * as listRoute from '@/app/api/drawings/route';
import * as itemRoute from '@/app/api/drawings/[id]/route';
import * as releaseRoute from '@/app/api/drawings/[id]/release/route';
import * as revisionRoute from '@/app/api/drawings/[id]/revisions/route';
import * as depRoute from '@/app/api/drawings/[id]/dependencies/route';
import * as importRoute from '@/app/api/drawings/import/route';
import * as conflictsRoute from '@/app/api/drawing-conflicts/route';
import * as rescheduleRoute from '@/app/api/reschedule/route';
import * as bulkRoute from '@/app/api/bulk/route';

const EMAIL = {
  VIEWER: 'drawing-viewer@test.local',
  EDITOR: 'drawing-editor@test.local',
  MANAGER: 'drawing-manager@test.local',
  ADMIN: 'admin@company.local',
} as const;
type Role = keyof typeof EMAIL;

function req(role: Role, url: string, method = 'GET', body?: unknown) {
  return new Request(`http://test.local${url}`, {
    method,
    headers: { 'x-user-email': EMAIL[role], 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe('drawing permissions', () => {
  it('matches the approved permission model', () => {
    const perms = ['drawing.read', 'drawing.write', 'drawing.complete', 'drawing.reschedule', 'drawing.admin'] as const;
    const table = Object.fromEntries((['VIEWER', 'EDITOR', 'MANAGER', 'ADMIN'] as const).map((r) => [r, perms.filter((p) => can(r, p))]));
    expect(table).toEqual({
      VIEWER: ['drawing.read'],
      EDITOR: ['drawing.read', 'drawing.write', 'drawing.complete', 'drawing.reschedule'],
      MANAGER: ['drawing.read', 'drawing.write', 'drawing.complete', 'drawing.reschedule'],
      ADMIN: [...perms],
    });
    // Drawing rescheduling does not need the Manager-level schedule.reschedule.
    expect(reschedulePermissionFor('DRAWING')).toBe('drawing.reschedule');
    expect(can('EDITOR', 'schedule.reschedule')).toBe(false);
    expect(reschedulePermissionFor('DELIVERABLE')).toBe('schedule.reschedule');
  });
});

describe('drawing API routes by role', () => {
  let open: typeof drawings.$inferSelect;
  let projectId: string;

  beforeAll(async () => {
    for (const [role, email] of Object.entries(EMAIL)) {
      if (role === 'ADMIN') continue;
      await db
        .insert(users)
        .values({ id: newId('us_'), name: `Test ${role.toLowerCase()}`, email, role, active: true })
        .onConflictDoUpdate({ target: users.email, set: { role } });
    }
    const [t08] = await db.select().from(projects).where(eq(projects.projectCode, 'POARR-T08'));
    projectId = t08.id;
    [open] = await db
      .select()
      .from(drawings)
      .where(and(eq(drawings.projectId, t08.id), eq(drawings.completionStatus, 'NOT_COMPLETED'), sql`${drawings.currentExpectedReleaseDate} is not null`))
      .limit(1)
      .offset(20);
  });

  it('a Viewer can read the register and a drawing', async () => {
    expect((await listRoute.GET(req('VIEWER', `/api/drawings?projectId=${projectId}`))).status).toBe(200);
    expect((await itemRoute.GET(req('VIEWER', `/api/drawings/${open.id}`), params(open.id))).status).toBe(200);
  });

  it('a Viewer cannot add, edit, release, revise, add a dependency, reschedule, bulk-update or import', async () => {
    const calls = [
      listRoute.POST(req('VIEWER', '/api/drawings', 'POST', { projectId, drawingName: 'viewer attempt' })),
      itemRoute.PATCH(req('VIEWER', `/api/drawings/${open.id}`, 'PATCH', { remarks: 'viewer edit' }), params(open.id)),
      itemRoute.PATCH(req('VIEWER', `/api/drawings/${open.id}`, 'PATCH', { completionStatus: 'COMPLETED' }), params(open.id)),
      releaseRoute.POST(req('VIEWER', `/api/drawings/${open.id}/release`, 'POST', { actualReleaseDate: '2026-01-05' }), params(open.id)),
      revisionRoute.POST(req('VIEWER', `/api/drawings/${open.id}/revisions`, 'POST', { revision: 'R99' }), params(open.id)),
      depRoute.POST(req('VIEWER', `/api/drawings/${open.id}/dependencies`, 'POST', { department: 'PHE', description: 'x' }), params(open.id)),
      rescheduleRoute.POST(req('VIEWER', '/api/reschedule', 'POST', { entityType: 'DRAWING', ids: [open.id], shiftDays: 3, reason: 'viewer try' })),
      bulkRoute.POST(req('VIEWER', '/api/bulk', 'POST', { entityType: 'DRAWING', ids: [open.id], action: 'ADD_REMARK', remark: 'x' })),
      importRoute.POST(req('VIEWER', '/api/drawings/import', 'POST', { apply: false })),
      itemRoute.DELETE(req('VIEWER', `/api/drawings/${open.id}`, 'DELETE', { reason: 'viewer delete' }), params(open.id)),
    ];
    const statuses = (await Promise.all(calls)).map((r) => r.status);
    expect(statuses).toEqual(Array(calls.length).fill(403));
    const [after] = await db.select().from(drawings).where(eq(drawings.id, open.id));
    expect(after.remarks).toBe(open.remarks);
    expect(after.completionStatus).toBe('NOT_COMPLETED');
    expect(after.currentExpectedReleaseDate?.toISOString()).toBe(open.currentExpectedReleaseDate?.toISOString());
  });

  it('an Editor can edit and reschedule a drawing (no schedule.reschedule needed)', async () => {
    const edit = await itemRoute.PATCH(req('EDITOR', `/api/drawings/${open.id}`, 'PATCH', { remarks: 'editor note', reason: 'test' }), params(open.id));
    expect(edit.status).toBe(200);
    const preview = await rescheduleRoute.POST(
      req('EDITOR', '/api/reschedule', 'POST', { entityType: 'DRAWING', ids: [open.id], shiftDays: 5, reason: 'Editor reschedule' }),
    );
    expect(preview.status).toBe(200);
    const applied = await rescheduleRoute.POST(
      req('EDITOR', '/api/reschedule', 'POST', { entityType: 'DRAWING', ids: [open.id], shiftDays: 5, reason: 'Editor reschedule', confirm: true }),
    );
    expect(applied.status).toBe(200);
    const [after] = await db.select().from(drawings).where(eq(drawings.id, open.id));
    expect(after.rescheduleCount).toBe(open.rescheduleCount + 1);
    // An Editor still cannot reschedule a deliverable (Manager-level schedule.reschedule).
    const dl = await rescheduleRoute.POST(req('EDITOR', '/api/reschedule', 'POST', { entityType: 'DELIVERABLE', ids: ['x'], shiftDays: 1, reason: 'nope' }));
    expect(dl.status).toBe(403);
  });

  it('PATCH with an expected date goes through the reschedule engine (history + audit), never a direct write', async () => {
    const [before] = await db.select().from(drawings).where(eq(drawings.id, open.id));
    const target = addDays(startOfDay(before.currentExpectedReleaseDate!), 9).toISOString().slice(0, 10);
    const noReason = await itemRoute.PATCH(req('EDITOR', `/api/drawings/${open.id}`, 'PATCH', { currentExpectedReleaseDate: target }), params(open.id));
    expect(noReason.status).toBe(400);
    const res = await itemRoute.PATCH(
      req('EDITOR', `/api/drawings/${open.id}`, 'PATCH', { currentExpectedReleaseDate: target, reason: 'Via PATCH' }),
      params(open.id),
    );
    expect(res.status).toBe(200);
    const [after] = await db.select().from(drawings).where(eq(drawings.id, open.id));
    expect(after.currentExpectedReleaseDate?.toISOString().slice(0, 10)).toBe(target);
    expect(after.rescheduleCount).toBe(before.rescheduleCount + 1);
    expect(after.baselineReleaseDate?.toISOString()).toBe(before.baselineReleaseDate?.toISOString());
    const hist = await db.execute(sql`select count(*)::int as n from reschedule_history where entity_id = ${open.id} and reason = 'Via PATCH'`);
    expect(Number((hist.rows[0] as { n: number }).n)).toBe(1);
    const aud = await db.execute(sql`select count(*)::int as n from audit_log where entity_id = ${open.id} and action = 'RESCHEDULE_DRAWING' and reason = 'Via PATCH'`);
    expect(Number((aud.rows[0] as { n: number }).n)).toBe(1);
  });

  it('an Editor can add a drawing, release it, revise it and add a dependency — but not administer', async () => {
    const created = await listRoute.POST(req('EDITOR', '/api/drawings', 'POST', { projectId, drawingName: 'Editor-added drawing', drawingNumber: 'A-T8-RBAC-0001' }));
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect((await releaseRoute.POST(req('EDITOR', `/api/drawings/${id}/release`, 'POST', { actualReleaseDate: new Date().toISOString().slice(0, 10) }), params(id))).status).toBe(200);
    expect((await revisionRoute.POST(req('EDITOR', `/api/drawings/${id}/revisions`, 'POST', { revision: 'R1' }), params(id))).status).toBe(201);
    expect((await depRoute.POST(req('EDITOR', `/api/drawings/${id}/dependencies`, 'POST', { department: 'STR', description: 'Beam sizes' }), params(id))).status).toBe(201);
    expect((await importRoute.POST(req('EDITOR', '/api/drawings/import', 'POST', { apply: false }))).status).toBe(403);
    expect((await conflictsRoute.GET(req('EDITOR', '/api/drawing-conflicts'))).status).toBe(403);
    expect((await itemRoute.DELETE(req('EDITOR', `/api/drawings/${id}`, 'DELETE', { reason: 'editor delete' }), params(id))).status).toBe(403);
    // Withdrawing a release is admin-only, in bulk too.
    expect((await itemRoute.PATCH(req('EDITOR', `/api/drawings/${id}`, 'PATCH', { completionStatus: 'NOT_COMPLETED', reason: 'undo' }), params(id))).status).toBe(403);
    expect((await bulkRoute.POST(req('EDITOR', '/api/bulk', 'POST', { entityType: 'DRAWING', ids: [id], action: 'MARK_NOT_COMPLETED', reason: 'undo' }))).status).toBe(403);
  });

  it('a Manager has the same drawing powers as an Editor', async () => {
    expect((await itemRoute.PATCH(req('MANAGER', `/api/drawings/${open.id}`, 'PATCH', { remarks: 'manager note' }), params(open.id))).status).toBe(200);
    expect((await importRoute.POST(req('MANAGER', '/api/drawings/import', 'POST', { apply: false }))).status).toBe(403);
  });

  it('an Admin can preview the import and list conflicts', async () => {
    const res = await importRoute.POST(req('ADMIN', '/api/drawings/import', 'POST', { apply: false }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string; valid: boolean };
    expect(body.mode).toBe('PREVIEW');
    expect(body.valid).toBe(true);
    const c = await conflictsRoute.GET(req('ADMIN', '/api/drawing-conflicts?status=OPEN'));
    expect(c.status).toBe(200);
    expect(((await c.json()) as unknown[]).length).toBeGreaterThan(100);
  }, 120_000);
});
