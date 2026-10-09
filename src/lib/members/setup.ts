/**
 * Setting up personal sign-in (scripts/members.ts):
 *
 *   inviteFromCommandLine   one member (an Account Admin, or a member of one project), with a one-time link
 *   hasAccountAdmin         whether an Account Admin exists (invited or active)
 *   migrateResponsible      the Responsible Persons of drawings, packages and FY26 packages become
 *                           Invited members, with Member access (Drawing Status only) on their projects
 *
 * Every change is audited as "Setup (command line)".
 */
import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { db } from '@/db';
import { drawings, fy26Packages, fy26Projects, members, packages, projectMembers, users } from '@/db/schema';
import { recordAudit, type Actor } from '@/lib/audit';
import { newId } from '@/lib/ids';
import { legacyPrincipal } from './principal';
import { EMAIL_RE, normaliseEmail } from './policy';
import { addMember, type AddResult } from './service';

export const SETUP_ACTOR: Actor = { id: null, label: 'Setup (command line)' };

const setupCtx = () => ({ principal: legacyPrincipal('SUPER_ADMIN'), actor: SETUP_ACTOR, memberId: null, origin: null });

export async function hasAccountAdmin(): Promise<boolean> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(members)
    .where(and(eq(members.isAccountAdmin, true), ne(members.status, 'deactivated')));
  return (r?.n ?? 0) > 0;
}

export async function inviteFromCommandLine(input: { email: string; name: string; accountAdmin?: boolean; projectId?: string | null; projectAdmin?: boolean }): Promise<AddResult> {
  return addMember(setupCtx(), {
    email: input.email,
    name: input.name,
    accountAdmin: !!input.accountAdmin,
    projectId: input.projectId ?? null,
    level: input.projectAdmin ? 'project_admin' : 'member',
  });
}

/** Responsible Persons → Invited members (no link yet: an admin sends one from Settings → Members). */
export async function migrateResponsible(): Promise<{ created: number; existing: number; grants: number; placeholders: number }> {
  const pairs = new Map<string, Set<string>>();
  const add = (rows: { userId: string | null; projectId: string | null }[]) => {
    for (const r of rows) {
      if (!r.userId || !r.projectId) continue;
      if (!pairs.has(r.userId)) pairs.set(r.userId, new Set());
      pairs.get(r.userId)!.add(r.projectId);
    }
  };
  add(await db.selectDistinct({ userId: drawings.responsibleUserId, projectId: drawings.projectId }).from(drawings).where(isNotNull(drawings.responsibleUserId)));
  add(await db.selectDistinct({ userId: packages.responsibleUserId, projectId: packages.projectId }).from(packages).where(isNotNull(packages.responsibleUserId)));
  add(
    await db
      .selectDistinct({ userId: fy26Packages.responsibleUserId, projectId: fy26Projects.legacyProjectId })
      .from(fy26Packages)
      .innerJoin(fy26Projects, eq(fy26Packages.fy26ProjectId, fy26Projects.id))
      .where(isNotNull(fy26Packages.responsibleUserId)),
  );
  const result = { created: 0, existing: 0, grants: 0, placeholders: 0 };
  if (!pairs.size) return result;
  const people = await db.select().from(users).where(inArray(users.id, [...pairs.keys()]));
  for (const u of people) {
    const email = normaliseEmail(u.email);
    if (!EMAIL_RE.test(email)) continue;
    // Addresses the importer made up (…@….local) are kept so the member can be found; the admin corrects them before sending the link.
    if (email.endsWith('.local')) result.placeholders++;
    await db.transaction(async (tx) => {
      let [m] = await tx.select().from(members).where(eq(members.email, email)).limit(1);
      if (m) result.existing++;
      else {
        const id = newId('mb_');
        await tx.insert(members).values({ id, name: u.name, email, status: 'invited', userId: u.id, createdBy: SETUP_ACTOR.label, updatedAt: new Date() });
        [m] = await tx.select().from(members).where(eq(members.id, id)).limit(1);
        await recordAudit({ actor: SETUP_ACTOR, entityType: 'MEMBER', entityId: id, entityLabel: `${u.name} <${email}>`, action: 'ADD_MEMBER', reason: 'Responsible Person (members:migrate)' }, tx);
        result.created++;
      }
      for (const projectId of pairs.get(u.id) ?? []) {
        const [g] = await tx.select({ id: projectMembers.id }).from(projectMembers).where(and(eq(projectMembers.memberId, m.id), eq(projectMembers.projectId, projectId))).limit(1);
        if (g) continue;
        await tx.insert(projectMembers).values({ id: newId('pm_'), memberId: m.id, projectId, accessLevel: 'member', swBilling: false, swEdit: false, swImportExport: false, swPlanning: false, addedBy: SETUP_ACTOR.label, updatedAt: new Date() });
        await recordAudit({ actor: SETUP_ACTOR, entityType: 'MEMBER', entityId: m.id, entityLabel: `${m.name} <${m.email}>`, action: 'SET_ACCESS', newValue: 'member', projectId }, tx);
        result.grants++;
      }
    });
  }
  return result;
}
