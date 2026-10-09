/**
 * Settings → Members, Companies and Roles (Account Admin, Project Admins).
 *
 * Guards (every write):
 *   - an Account Admin manages everyone; a Project Admin manages the members
 *     of the projects where they are Project Admin, up to Project Admin
 *   - nobody grants a level or a switch above their own on that project
 *   - only an Account Admin makes or unmakes an Account Admin, and edits the
 *     Companies and Roles lists (anyone who adds members may add a new name)
 *   - the last active Account Admin cannot be deactivated, demoted or removed
 *   - nobody deactivates themselves
 * Every change is audited with the person's name and email.
 */
import { and, asc, desc, eq, ilike, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import * as XLSX from 'xlsx';
import { db, type DbLike } from '@/db';
import { auditLog, companies, jobRoles, loginSessions, memberInvites, members, projectMembers, projects } from '@/db/schema';
import { recordAudit, type Actor } from '@/lib/audit';
import { newId } from '@/lib/ids';
import { projectLabel } from '@/lib/labels';
import { createInvite, revokeMemberSessions } from './auth';
import { can, EMAIL_RE, effectiveGrant, LEVEL_LABEL, lineage, normaliseEmail, SWITCHES, type AccessLevel, type Principal, type Switch } from './policy';

export class MemberRuleError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface AdminCtx {
  principal: Principal;
  actor: Actor;
  /** The signed-in member (null for the shared role sign-ins). */
  memberId: string | null;
  /** The address the app is reached at (for invite links). */
  origin?: string | null;
}

type MemberRow = typeof members.$inferSelect;
type Switches = Record<Switch, boolean>;

const label = (m: Pick<MemberRow, 'name' | 'email'>) => `${m.name} <${m.email}>`;
const forbid = (msg = 'You cannot manage this member here.') => new MemberRuleError(msg, 403);

async function memberById(id: string, tx: DbLike = db) {
  const [m] = await tx.select().from(members).where(eq(members.id, id)).limit(1);
  if (!m) throw new MemberRuleError('This member was not found.', 404);
  return m;
}

async function projectById(id: string) {
  const [p] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (!p) throw new MemberRuleError('This project was not found.', 404);
  return p;
}

/** May the person manage memberships of this project? */
export function canManageProject(ctx: AdminCtx, projectId: string) {
  return can(ctx.principal, 'members', projectId);
}

/** May the person manage this member at all (profile, deactivate, sessions)? */
async function canManageMember(ctx: AdminCtx, target: MemberRow, everyProject = false) {
  if (ctx.principal.accountAdmin) return true;
  if (target.isAccountAdmin) return false;
  const rows = await db.select({ p: projectMembers.projectId }).from(projectMembers).where(eq(projectMembers.memberId, target.id));
  if (!rows.length) return target.createdBy === ctx.actor.label;
  return everyProject ? rows.every((r) => canManageProject(ctx, r.p)) : rows.some((r) => canManageProject(ctx, r.p));
}

async function activeAccountAdmins(tx: DbLike = db, exceptId?: string) {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(members)
    .where(and(eq(members.isAccountAdmin, true), eq(members.status, 'active'), exceptId ? ne(members.id, exceptId) : undefined));
  return r.n;
}

/** Refuse taking away the last active Account Admin. */
async function guardLastAccountAdmin(target: MemberRow, tx: DbLike = db) {
  if (target.isAccountAdmin && target.status === 'active' && (await activeAccountAdmins(tx, target.id)) === 0) {
    throw new MemberRuleError('This is the last active Account Admin. Make someone else an Account Admin first.', 409);
  }
}

/** The switches the person may hand out on a project (their own; Project Admin: all). */
function grantable(ctx: AdminCtx, projectId: string): Switches & { projectAdmin: boolean } {
  const g = effectiveGrant(ctx.principal, projectId);
  const admin = !!g && g.level === 'project_admin';
  return { billing: !!g?.billing, edit: !!g?.edit, importExport: !!g?.importExport, planning: !!g?.planning, projectAdmin: admin };
}

function checkGrant(ctx: AdminCtx, projectId: string, level: AccessLevel, sw: Partial<Switches>) {
  if (!canManageProject(ctx, projectId)) throw forbid('You are not a Project Admin of this project.');
  const mine = grantable(ctx, projectId);
  if (level === 'project_admin' && !mine.projectAdmin) throw forbid('You cannot make someone a Project Admin above your own level.');
  for (const k of SWITCHES) if (sw[k] && !mine[k]) throw forbid(`You cannot switch on ${k} for others: you do not have it yourself.`);
}

async function namedId(table: typeof companies | typeof jobRoles, name: string | null | undefined, tx: DbLike = db): Promise<string | null> {
  const n = name?.trim().replace(/\s+/g, ' ');
  if (!n) return null;
  const [hit] = await tx.select({ id: table.id }).from(table).where(sql`lower(${table.name}) = lower(${n})`).limit(1);
  if (hit) return hit.id;
  const id = newId(table === companies ? 'co_' : 'jr_');
  await tx.insert(table).values({ id, name: n, updatedAt: new Date() } as never);
  return id;
}

// ---------------------------------------------------------------------------
// The list (the Members table)
// ---------------------------------------------------------------------------

export interface MemberListQuery {
  /** A project, or null for "All projects" (Account Admin). */
  projectId: string | null;
  search?: string;
  companyId?: string;
  roleId?: string;
  level?: string; // account_admin | project_admin | member
  status?: string;
  switch?: string; // billing | edit | importExport | planning (on)
  page?: number;
  pageSize?: number;
}

export interface MemberListRow {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  status: string;
  company: string | null;
  companyId: string | null;
  role: string | null;
  roleId: string | null;
  accountAdmin: boolean;
  /** On the chosen project: project_admin | member; "All projects": the highest anywhere. */
  level: 'account_admin' | AccessLevel | null;
  levelLabel: string;
  projects: number;
  addedOn: string | null;
  lastSignIn: string | null;
  switches: Switches;
  /** Project Admin / Account Admin: every switch on, locked. */
  locked: boolean;
  canEdit: boolean;
}

export async function listMembers(ctx: AdminCtx, q: MemberListQuery) {
  if (q.projectId) {
    await projectById(q.projectId);
    if (!canManageProject(ctx, q.projectId)) throw forbid('You are not a Project Admin of this project.');
  } else if (!ctx.principal.accountAdmin) throw forbid('Choose one of your projects.');
  const pageSize = [20, 50, 100].includes(q.pageSize ?? 20) ? (q.pageSize ?? 20) : 20;
  const page = Math.max(1, q.page ?? 1);

  const where: (SQL | undefined)[] = [];
  if (q.search?.trim()) {
    const s = `%${q.search.trim()}%`;
    where.push(or(ilike(members.name, s), ilike(members.email, s)));
  }
  if (q.companyId) where.push(eq(members.companyId, q.companyId));
  if (q.roleId) where.push(eq(members.jobRoleId, q.roleId));
  if (q.status) where.push(eq(members.status, q.status));
  if (q.projectId) where.push(sql`exists (select 1 from ${projectMembers} pm where pm.member_id = ${members.id} and pm.project_id = ${q.projectId})`);
  const base = await db
    .select({ m: members, company: companies.name, role: jobRoles.name })
    .from(members)
    .leftJoin(companies, eq(members.companyId, companies.id))
    .leftJoin(jobRoles, eq(members.jobRoleId, jobRoles.id))
    .where(where.length ? and(...(where.filter(Boolean) as SQL[])) : undefined)
    .orderBy(asc(members.name));
  const ids = base.map((b) => b.m.id);
  const grants = ids.length ? await db.select().from(projectMembers).where(inArray(projectMembers.memberId, ids)) : [];
  const byMember = new Map<string, (typeof grants)[number][]>();
  for (const g of grants) byMember.set(g.memberId, [...(byMember.get(g.memberId) ?? []), g]);
  let rows: MemberListRow[] = base.map(({ m, company, role }) => {
    const gs = byMember.get(m.id) ?? [];
    const here = q.projectId ? gs.find((g) => g.projectId === q.projectId) : null;
    const level: MemberListRow['level'] = m.isAccountAdmin ? 'account_admin' : q.projectId ? ((here?.accessLevel as AccessLevel) ?? null) : gs.some((g) => g.accessLevel === 'project_admin') ? 'project_admin' : gs.length ? 'member' : null;
    const locked = m.isAccountAdmin || level === 'project_admin';
    const sw = (k: 'swBilling' | 'swEdit' | 'swImportExport' | 'swPlanning') => locked || (q.projectId ? !!here?.[k] : gs.some((g) => g[k]));
    return {
      id: m.id,
      name: m.name,
      email: m.email,
      phone: m.phone,
      status: m.status,
      company,
      companyId: m.companyId,
      role,
      roleId: m.jobRoleId,
      accountAdmin: m.isAccountAdmin,
      level,
      levelLabel: level ? LEVEL_LABEL[level] : '—',
      projects: gs.length,
      addedOn: (here?.addedAt ?? m.createdAt)?.toISOString() ?? null,
      lastSignIn: m.lastSignInAt?.toISOString() ?? null,
      switches: { billing: sw('swBilling'), edit: sw('swEdit'), importExport: sw('swImportExport'), planning: sw('swPlanning') },
      locked,
      canEdit: ctx.principal.accountAdmin || (!m.isAccountAdmin && (q.projectId ? canManageProject(ctx, q.projectId) : false)),
    };
  });
  if (q.level) rows = rows.filter((r) => r.level === q.level);
  if (q.switch && (SWITCHES as readonly string[]).includes(q.switch)) rows = rows.filter((r) => r.switches[q.switch as Switch]);
  const total = rows.length;
  return { rows: rows.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

/** The projects the person may manage members of (the project picker). */
export async function managedProjects(ctx: AdminCtx) {
  const all = await db.select().from(projects).where(isNull(projects.archivedAt));
  const order = (a: (typeof all)[number], b: (typeof all)[number]) => (a.displayOrder ?? 1e6) - (b.displayOrder ?? 1e6) || projectLabel(a).localeCompare(projectLabel(b));
  const byId = new Map(all.map((p) => [p.id, p]));
  const path = (p: (typeof all)[number]) =>
    lineage(p.id, new Map(all.map((x) => [x.id, x.parentProjectId])))
      .reverse()
      .map((id) => projectLabel(byId.get(id)!))
      .join(' › ');
  return all
    .filter((p) => canManageProject(ctx, p.id))
    .sort(order)
    .map((p) => ({ id: p.id, code: p.projectCode, name: projectLabel(p), path: path(p) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------
// Add, edit, access
// ---------------------------------------------------------------------------

export interface AddMemberInput {
  name: string;
  email: string;
  phone?: string | null;
  company?: string | null;
  role?: string | null;
  projectId?: string | null;
  level?: AccessLevel;
  switches?: Partial<Switches>;
  accountAdmin?: boolean;
}

export interface AddResult {
  memberId: string;
  created: boolean;
  /** The one-time invite link, shown once (new members and invited members). */
  invite: { link: string; expiresAt: string } | null;
}

export async function addMember(ctx: AdminCtx, input: AddMemberInput, tx: DbLike = db): Promise<AddResult> {
  const name = input.name?.trim().replace(/\s+/g, ' ');
  const email = normaliseEmail(input.email ?? '');
  if (!name) throw new MemberRuleError('Give the name.');
  if (!EMAIL_RE.test(email)) throw new MemberRuleError(`"${input.email}" is not an email address.`);
  if (input.accountAdmin && !ctx.principal.accountAdmin) throw forbid('Only an Account Admin can add an Account Admin.');
  const level: AccessLevel = input.level === 'project_admin' ? 'project_admin' : 'member';
  if (!input.projectId && !input.accountAdmin) throw new MemberRuleError('Choose the project to add the member to.');
  if (input.projectId) {
    await projectById(input.projectId);
    checkGrant(ctx, input.projectId, level, input.switches ?? {});
  }
  const [existing] = await tx.select().from(members).where(eq(members.email, email)).limit(1);
  let memberId = existing?.id;
  let created = false;
  if (existing) {
    // Fill what is missing; a name or details someone already has are kept.
    const patch: Partial<MemberRow> = {};
    if (!existing.phone && input.phone) patch.phone = input.phone.trim();
    if (!existing.companyId && input.company) patch.companyId = await namedId(companies, input.company, tx);
    if (!existing.jobRoleId && input.role) patch.jobRoleId = await namedId(jobRoles, input.role, tx);
    if (input.accountAdmin && !existing.isAccountAdmin) patch.isAccountAdmin = true;
    if (Object.keys(patch).length) {
      await tx.update(members).set({ ...patch, updatedAt: new Date() }).where(eq(members.id, existing.id));
      await recordAudit({ actor: ctx.actor, entityType: 'MEMBER', entityId: existing.id, entityLabel: label(existing), action: 'UPDATE_MEMBER', newValue: JSON.stringify(patch), reason: 'Added again (details filled in)' }, tx);
    }
  } else {
    memberId = newId('mb_');
    created = true;
    await tx.insert(members).values({
      id: memberId,
      name,
      email,
      phone: input.phone?.trim() || null,
      companyId: await namedId(companies, input.company, tx),
      jobRoleId: await namedId(jobRoles, input.role, tx),
      status: 'invited',
      isAccountAdmin: !!input.accountAdmin,
      createdBy: ctx.actor.label,
      updatedAt: new Date(),
    });
    await recordAudit({ actor: ctx.actor, entityType: 'MEMBER', entityId: memberId, entityLabel: `${name} <${email}>`, action: 'ADD_MEMBER', newValue: input.accountAdmin ? 'Account Admin' : null, projectId: input.projectId ?? null }, tx);
  }
  if (input.projectId) await upsertAccess(ctx, memberId!, input.projectId, level, input.switches ?? {}, tx);
  const m = await memberById(memberId!, tx);
  const invite = m.status === 'invited' && (created || !m.passwordHash) ? await createInvite(m.id, ctx.actor.label, ctx.origin, tx) : null;
  if (invite) await recordAudit({ actor: ctx.actor, entityType: 'MEMBER', entityId: m.id, entityLabel: label(m), action: 'INVITE_CREATED', newValue: invite.expiresAt.toISOString() }, tx);
  return { memberId: m.id, created, invite: invite ? { link: invite.link, expiresAt: invite.expiresAt.toISOString() } : null };
}

async function upsertAccess(ctx: AdminCtx, memberId: string, projectId: string, level: AccessLevel, sw: Partial<Switches>, tx: DbLike = db) {
  const admin = level === 'project_admin';
  const values = {
    accessLevel: level,
    swBilling: admin || !!sw.billing,
    swEdit: admin || !!sw.edit,
    swImportExport: admin || !!sw.importExport,
    swPlanning: admin || !!sw.planning,
  };
  const [cur] = await tx.select().from(projectMembers).where(and(eq(projectMembers.memberId, memberId), eq(projectMembers.projectId, projectId))).limit(1);
  if (cur) await tx.update(projectMembers).set({ ...values, updatedAt: new Date() }).where(eq(projectMembers.id, cur.id));
  else await tx.insert(projectMembers).values({ id: newId('pm_'), memberId, projectId, ...values, addedBy: ctx.actor.label, updatedAt: new Date() });
  const m = await memberById(memberId, tx);
  await recordAudit(
    {
      actor: ctx.actor,
      entityType: 'MEMBER',
      entityId: memberId,
      entityLabel: label(m),
      action: 'SET_ACCESS',
      field: 'access',
      oldValue: cur ? JSON.stringify({ level: cur.accessLevel, billing: cur.swBilling, edit: cur.swEdit, importExport: cur.swImportExport, planning: cur.swPlanning }) : null,
      newValue: JSON.stringify({ level, billing: values.swBilling, edit: values.swEdit, importExport: values.swImportExport, planning: values.swPlanning }),
      projectId,
    },
    tx,
  );
}

/** Change the access level or a switch of a member on one project. */
export async function setAccess(ctx: AdminCtx, memberId: string, projectId: string, patch: { level?: AccessLevel; switches?: Partial<Switches> }) {
  const target = await memberById(memberId);
  if (target.isAccountAdmin) throw new MemberRuleError('An Account Admin has every project and switch; change "Account Admin" first.');
  const [cur] = await db.select().from(projectMembers).where(and(eq(projectMembers.memberId, memberId), eq(projectMembers.projectId, projectId))).limit(1);
  const level = patch.level ?? ((cur?.accessLevel as AccessLevel) ?? 'member');
  const sw: Switches = {
    billing: patch.switches?.billing ?? cur?.swBilling ?? false,
    edit: patch.switches?.edit ?? cur?.swEdit ?? false,
    importExport: patch.switches?.importExport ?? cur?.swImportExport ?? false,
    planning: patch.switches?.planning ?? cur?.swPlanning ?? false,
  };
  // Demoting a Project Admin needs the same right as making one.
  if (cur?.accessLevel === 'project_admin' && level !== 'project_admin' && !grantable(ctx, projectId).projectAdmin) throw forbid('You cannot change a Project Admin.');
  if (ctx.memberId === memberId && !ctx.principal.accountAdmin) throw forbid('Ask another admin to change your own access.');
  checkGrant(ctx, projectId, level, patch.switches ? Object.fromEntries(Object.entries(patch.switches).filter(([, v]) => v)) : {});
  await upsertAccess(ctx, memberId, projectId, level, sw);
}

export async function setAccountAdmin(ctx: AdminCtx, memberId: string, on: boolean) {
  if (!ctx.principal.accountAdmin) throw forbid('Only an Account Admin can change who is an Account Admin.');
  const target = await memberById(memberId);
  if (target.isAccountAdmin === on) return;
  if (!on) await guardLastAccountAdmin(target);
  if (on && target.status === 'deactivated') throw new MemberRuleError('Reactivate the member first.');
  await db.update(members).set({ isAccountAdmin: on, updatedAt: new Date() }).where(eq(members.id, memberId));
  await recordAudit({ actor: ctx.actor, entityType: 'MEMBER', entityId: memberId, entityLabel: label(target), action: 'SET_ACCESS', field: 'accountAdmin', oldValue: String(!on), newValue: String(on) });
}

export async function updateProfile(ctx: AdminCtx, memberId: string, patch: { name?: string; email?: string; phone?: string | null; company?: string | null; role?: string | null }) {
  const target = await memberById(memberId);
  if (!(await canManageMember(ctx, target))) throw forbid();
  const set: Partial<MemberRow> = {};
  if (patch.name !== undefined) {
    const n = patch.name.trim().replace(/\s+/g, ' ');
    if (!n) throw new MemberRuleError('Give the name.');
    set.name = n;
  }
  if (patch.email !== undefined && normaliseEmail(patch.email) !== target.email) {
    // The email is the sign-in name: it can be corrected only before the member has set a password.
    const email = normaliseEmail(patch.email);
    if (target.status !== 'invited' || target.passwordHash) throw new MemberRuleError('The email can be changed only before the member has set a password.', 409);
    if (!EMAIL_RE.test(email)) throw new MemberRuleError(`"${patch.email}" is not an email address.`);
    const [taken] = await db.select({ id: members.id }).from(members).where(eq(members.email, email)).limit(1);
    if (taken) throw new MemberRuleError('Another member already has this email.', 409);
    set.email = email;
    // Earlier invite links were sent to the old address: they stop working.
    await db.update(memberInvites).set({ usedAt: new Date() }).where(and(eq(memberInvites.memberId, memberId), isNull(memberInvites.usedAt)));
  }
  if (patch.phone !== undefined) set.phone = patch.phone?.trim() || null;
  if (patch.company !== undefined) set.companyId = await namedId(companies, patch.company);
  if (patch.role !== undefined) set.jobRoleId = await namedId(jobRoles, patch.role);
  if (!Object.keys(set).length) return;
  await db.update(members).set({ ...set, updatedAt: new Date() }).where(eq(members.id, memberId));
  await recordAudit({ actor: ctx.actor, entityType: 'MEMBER', entityId: memberId, entityLabel: label(target), action: 'UPDATE_MEMBER', oldValue: JSON.stringify({ name: target.name, email: target.email, phone: target.phone, companyId: target.companyId, jobRoleId: target.jobRoleId }), newValue: JSON.stringify(set) });
}

export async function removeFromProject(ctx: AdminCtx, memberId: string, projectId: string) {
  const target = await memberById(memberId);
  if (!canManageProject(ctx, projectId)) throw forbid('You are not a Project Admin of this project.');
  if (ctx.memberId === memberId && !ctx.principal.accountAdmin) throw forbid('Ask another admin to remove you.');
  const [cur] = await db.select().from(projectMembers).where(and(eq(projectMembers.memberId, memberId), eq(projectMembers.projectId, projectId))).limit(1);
  if (!cur) return;
  if (cur.accessLevel === 'project_admin' && !grantable(ctx, projectId).projectAdmin) throw forbid('You cannot remove a Project Admin.');
  await db.delete(projectMembers).where(eq(projectMembers.id, cur.id));
  await recordAudit({ actor: ctx.actor, entityType: 'MEMBER', entityId: memberId, entityLabel: label(target), action: 'REMOVE_MEMBER', oldValue: cur.accessLevel, projectId });
}

export async function deactivate(ctx: AdminCtx, memberId: string) {
  const target = await memberById(memberId);
  if (ctx.memberId === memberId) throw new MemberRuleError('You cannot deactivate yourself.', 409);
  if (!(await canManageMember(ctx, target, true))) throw forbid('This member also belongs to projects you do not administer. Ask an Account Admin.');
  await guardLastAccountAdmin(target);
  await db.transaction(async (tx) => {
    await tx.update(members).set({ status: 'deactivated', deactivatedAt: new Date(), updatedAt: new Date() }).where(eq(members.id, memberId));
    await revokeMemberSessions(memberId, tx);
    await recordAudit({ actor: ctx.actor, entityType: 'MEMBER', entityId: memberId, entityLabel: label(target), action: 'DEACTIVATE_MEMBER', oldValue: target.status }, tx);
  });
}

export async function reactivate(ctx: AdminCtx, memberId: string) {
  const target = await memberById(memberId);
  if (!(await canManageMember(ctx, target, true))) throw forbid();
  if (target.status !== 'deactivated') return;
  const status = target.passwordHash ? 'active' : 'invited';
  await db.update(members).set({ status, deactivatedAt: null, updatedAt: new Date() }).where(eq(members.id, memberId));
  await recordAudit({ actor: ctx.actor, entityType: 'MEMBER', entityId: memberId, entityLabel: label(target), action: 'REACTIVATE_MEMBER', newValue: status });
}

/** A new one-time invite link: for an invited member ("Copy invite link / Resend"). */
export async function newInviteLink(ctx: AdminCtx, memberId: string) {
  const target = await memberById(memberId);
  if (!(await canManageMember(ctx, target))) throw forbid();
  if (target.status === 'deactivated') throw new MemberRuleError('Reactivate the member first.');
  if (target.status === 'active') throw new MemberRuleError('This member has already set a password. Use Reset password for a new link.');
  const inv = await createInvite(memberId, ctx.actor.label, ctx.origin);
  await recordAudit({ actor: ctx.actor, entityType: 'MEMBER', entityId: memberId, entityLabel: label(target), action: 'INVITE_CREATED', newValue: inv.expiresAt.toISOString() });
  return { link: inv.link, expiresAt: inv.expiresAt.toISOString() };
}

/** Reset password: the old password stops working, every session ends, a new invite link is made. */
export async function resetPassword(ctx: AdminCtx, memberId: string) {
  const target = await memberById(memberId);
  if (!(await canManageMember(ctx, target, true))) throw forbid('This member also belongs to projects you do not administer. Ask an Account Admin.');
  if (target.isAccountAdmin && !ctx.principal.accountAdmin) throw forbid();
  if (target.status === 'deactivated') throw new MemberRuleError('Reactivate the member first.');
  const inv = await db.transaction(async (tx) => {
    await tx.update(members).set({ passwordHash: null, status: 'invited', updatedAt: new Date() }).where(eq(members.id, memberId));
    await revokeMemberSessions(memberId, tx);
    const i = await createInvite(memberId, ctx.actor.label, ctx.origin, tx);
    await recordAudit({ actor: ctx.actor, entityType: 'MEMBER', entityId: memberId, entityLabel: label(target), action: 'RESET_PASSWORD', newValue: i.expiresAt.toISOString() }, tx);
    return i;
  });
  return { link: inv.link, expiresAt: inv.expiresAt.toISOString() };
}

/** Copy one member's access on a project to other projects. */
export async function copyAccess(ctx: AdminCtx, memberId: string, fromProjectId: string, toProjectIds: string[]) {
  const [g] = await db.select().from(projectMembers).where(and(eq(projectMembers.memberId, memberId), eq(projectMembers.projectId, fromProjectId))).limit(1);
  if (!g) throw new MemberRuleError('The member has no access on that project to copy.');
  for (const to of toProjectIds) {
    if (to === fromProjectId) continue;
    const level = g.accessLevel as AccessLevel;
    const sw = { billing: g.swBilling, edit: g.swEdit, importExport: g.swImportExport, planning: g.swPlanning };
    checkGrant(ctx, to, level, sw);
    await upsertAccess(ctx, memberId, to, level, sw);
  }
}

/** Copy every member of one project to another (their level and switches). */
export async function copyMembers(ctx: AdminCtx, fromProjectId: string, toProjectId: string) {
  if (!canManageProject(ctx, fromProjectId)) throw forbid('You are not a Project Admin of the project you copy from.');
  const rows = await db.select().from(projectMembers).where(eq(projectMembers.projectId, fromProjectId));
  let n = 0;
  for (const g of rows) {
    const level = g.accessLevel as AccessLevel;
    const sw = { billing: g.swBilling, edit: g.swEdit, importExport: g.swImportExport, planning: g.swPlanning };
    checkGrant(ctx, toProjectId, level, sw);
    await upsertAccess(ctx, g.memberId, toProjectId, level, sw);
    n++;
  }
  return { copied: n };
}

// ---------------------------------------------------------------------------
// Member detail
// ---------------------------------------------------------------------------

export async function memberDetail(ctx: AdminCtx, memberId: string) {
  const m = await memberById(memberId);
  if (!(await canManageMember(ctx, m)) && ctx.memberId !== memberId) throw forbid();
  const [company] = m.companyId ? await db.select().from(companies).where(eq(companies.id, m.companyId)) : [];
  const [role] = m.jobRoleId ? await db.select().from(jobRoles).where(eq(jobRoles.id, m.jobRoleId)) : [];
  const gs = await db.select({ g: projectMembers, p: projects }).from(projectMembers).innerJoin(projects, eq(projectMembers.projectId, projects.id)).where(eq(projectMembers.memberId, memberId));
  const sessions = await db
    .select({ id: loginSessions.id, createdAt: loginSessions.createdAt, lastSeenAt: loginSessions.lastSeenAt, expiresAt: loginSessions.expiresAt, ip: loginSessions.ip, editMode: loginSessions.editMode })
    .from(loginSessions)
    .where(and(eq(loginSessions.memberId, memberId), isNull(loginSessions.revokedAt), sql`${loginSessions.expiresAt} > now()`))
    .orderBy(desc(loginSessions.createdAt));
  const activity = await db
    .select()
    .from(auditLog)
    .where(or(eq(auditLog.entityId, memberId), m.userId ? eq(auditLog.userId, m.userId) : sql`false`))
    .orderBy(desc(auditLog.timestamp))
    .limit(50);
  return {
    member: { id: m.id, name: m.name, email: m.email, phone: m.phone, status: m.status, accountAdmin: m.isAccountAdmin, company: company?.name ?? null, role: role?.name ?? null, createdAt: m.createdAt, createdBy: m.createdBy, lastSignInAt: m.lastSignInAt, deactivatedAt: m.deactivatedAt },
    memberships: gs
      .map(({ g, p }) => ({
        projectId: p.id,
        project: projectLabel(p),
        level: g.accessLevel,
        billing: g.swBilling || g.accessLevel === 'project_admin',
        edit: g.swEdit || g.accessLevel === 'project_admin',
        importExport: g.swImportExport || g.accessLevel === 'project_admin',
        planning: g.swPlanning || g.accessLevel === 'project_admin',
        addedAt: g.addedAt,
        addedBy: g.addedBy,
        canEdit: canManageProject(ctx, p.id),
      }))
      .sort((a, b) => a.project.localeCompare(b.project)),
    sessions,
    activity: activity.map((a) => ({ at: a.timestamp, who: a.userLabel, action: a.action, entity: a.entityLabel ?? a.entityType, field: a.field, newValue: a.newValue, projectId: a.projectId })),
    canManage: await canManageMember(ctx, m),
  };
}

export async function endSession(ctx: AdminCtx, sessionId: string) {
  const [s] = await db.select().from(loginSessions).where(eq(loginSessions.id, sessionId)).limit(1);
  if (!s?.memberId) throw new MemberRuleError('This session was not found.', 404);
  const target = await memberById(s.memberId);
  if (!(await canManageMember(ctx, target)) && ctx.memberId !== s.memberId) throw forbid();
  await db.update(loginSessions).set({ revokedAt: new Date(), editMode: false }).where(eq(loginSessions.id, sessionId));
  await recordAudit({ actor: ctx.actor, entityType: 'MEMBER', entityId: target.id, entityLabel: label(target), action: 'END_SESSION', newValue: sessionId });
}

// ---------------------------------------------------------------------------
// Companies and Roles
// ---------------------------------------------------------------------------

export async function listNamed(kind: 'company' | 'role') {
  const t = kind === 'company' ? companies : jobRoles;
  const col = kind === 'company' ? members.companyId : members.jobRoleId;
  const rows = await db.select().from(t).orderBy(asc(t.name));
  const counts = await db.select({ id: col, n: sql<number>`count(*)::int` }).from(members).groupBy(col);
  const n = new Map(counts.map((c) => [c.id, c.n]));
  return rows.map((r) => ({ id: r.id, name: r.name, trade: 'trade' in r ? (r as { trade: string | null }).trade : null, members: n.get(r.id) ?? 0 }));
}

export async function saveNamed(ctx: AdminCtx, kind: 'company' | 'role', input: { id?: string | null; name: string; trade?: string | null }) {
  if (!ctx.principal.accountAdmin) throw forbid('Only an Account Admin edits the Companies and Roles lists.');
  const t = kind === 'company' ? companies : jobRoles;
  const name = input.name?.trim().replace(/\s+/g, ' ');
  if (!name) throw new MemberRuleError('Give the name.');
  const [clash] = await db.select({ id: t.id }).from(t).where(sql`lower(${t.name}) = lower(${name})`).limit(1);
  if (clash && clash.id !== input.id) throw new MemberRuleError(`"${name}" is already on the list. Use Merge to combine two entries.`, 409);
  const extra = kind === 'company' ? { trade: input.trade?.trim() || null } : {};
  if (input.id) await db.update(t).set({ name, ...extra, updatedAt: new Date() } as never).where(eq(t.id, input.id));
  else await db.insert(t).values({ id: newId(kind === 'company' ? 'co_' : 'jr_'), name, ...extra, updatedAt: new Date() } as never);
  await recordAudit({ actor: ctx.actor, entityType: kind === 'company' ? 'COMPANY' : 'JOB_ROLE', entityId: input.id ?? name, entityLabel: name, action: input.id ? 'UPDATE' : 'CREATE' });
}

/** Merge: every member of `fromId` moves to `intoId`; `fromId` is removed. */
export async function mergeNamed(ctx: AdminCtx, kind: 'company' | 'role', fromId: string, intoId: string) {
  if (!ctx.principal.accountAdmin) throw forbid('Only an Account Admin edits the Companies and Roles lists.');
  if (fromId === intoId) return;
  const t = kind === 'company' ? companies : jobRoles;
  const [a] = await db.select().from(t).where(eq(t.id, fromId));
  const [b] = await db.select().from(t).where(eq(t.id, intoId));
  if (!a || !b) throw new MemberRuleError('Choose two entries of the list.', 404);
  await db.transaction(async (tx) => {
    await tx.update(members).set(kind === 'company' ? { companyId: intoId } : { jobRoleId: intoId }).where(eq(kind === 'company' ? members.companyId : members.jobRoleId, fromId));
    await tx.delete(t).where(eq(t.id, fromId));
    await recordAudit({ actor: ctx.actor, entityType: kind === 'company' ? 'COMPANY' : 'JOB_ROLE', entityId: intoId, entityLabel: b.name, action: 'MERGE', oldValue: a.name, newValue: b.name }, tx);
  });
}

// ---------------------------------------------------------------------------
// Import (our template or a Forma / ACC Members export) and export
// ---------------------------------------------------------------------------

export interface ImportRow {
  row: number;
  name: string;
  email: string;
  phone: string | null;
  company: string | null;
  role: string | null;
  level: AccessLevel;
  switches: Partial<Switches>;
}

export interface ImportPlanRow extends ImportRow {
  action: 'new' | 'updated' | 'skipped' | 'error';
  reason: string | null;
}

const HEADERS: Record<string, RegExp> = {
  name: /^(name|full name|member name|member)$/i,
  first: /^first ?name$/i,
  last: /^(last ?name|surname)$/i,
  email: /^(e-?mail|email address)$/i,
  phone: /^(phone|phone number|mobile|mobile number|telephone)$/i,
  company: /^company( name)?$/i,
  role: /^(role|roles|job role|job title)$/i,
  level: /^(access level|access|permission level)$/i,
  billing: /^billing$/i,
  edit: /^(edit|edit mode)$/i,
  importExport: /^(import ?\/ ?export|import export|import)$/i,
  planning: /^planning$/i,
};

const yes = (v: unknown) => /^(y|yes|true|1|on|x|✓|✔)$/i.test(String(v ?? '').trim());

/** Read our template or Forma's own Members export: headers matched by name, case-insensitive. */
export function parseMembersWorkbook(buf: Buffer): { rows: ImportRow[]; errors: { row: number; message: string }[]; sheet: string } {
  const wb = XLSX.read(buf, { type: 'buffer' });
  for (const sheet of wb.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheet], { header: 1, raw: false, defval: null, blankrows: false });
    for (let h = 0; h < Math.min(10, aoa.length); h++) {
      const header = (aoa[h] ?? []).map((v) => String(v ?? '').trim());
      const col: Record<string, number> = {};
      header.forEach((v, i) => {
        for (const [k, re] of Object.entries(HEADERS)) if (col[k] == null && re.test(v)) col[k] = i;
      });
      if (col.email == null || (col.name == null && col.first == null)) continue;
      const rows: ImportRow[] = [];
      const errors: { row: number; message: string }[] = [];
      for (let r = h + 1; r < aoa.length; r++) {
        const x = aoa[r] ?? [];
        const get = (k: string) => (col[k] != null ? String(x[col[k]] ?? '').trim() : '');
        const name = get('name') || [get('first'), get('last')].filter(Boolean).join(' ');
        const email = normaliseEmail(get('email'));
        if (!name && !email) continue;
        if (!EMAIL_RE.test(email)) {
          errors.push({ row: r + 1, message: `"${get('email')}" is not an email address.` });
          continue;
        }
        rows.push({
          row: r + 1,
          name: name || email.split('@')[0],
          email,
          phone: get('phone') || null,
          company: get('company') || null,
          role: get('role') || null,
          // "Project Admin" → project_admin; anything else (Member, Viewer, Executive …) → member.
          level: /^project\s*admin(istrator)?$/i.test(get('level')) ? 'project_admin' : 'member',
          switches: { billing: yes(get('billing')), edit: yes(get('edit')), importExport: yes(get('importExport')), planning: yes(get('planning')) },
        });
      }
      return { rows, errors, sheet };
    }
  }
  throw new MemberRuleError('No sheet has a Name (or First name / Last name) column and an Email column.', 400);
}

/** Dry run (apply = false) or import of a members list into one project. */
export async function importMembers(ctx: AdminCtx, projectId: string, buf: Buffer, apply: boolean) {
  await projectById(projectId);
  if (!canManageProject(ctx, projectId)) throw forbid('You are not a Project Admin of this project.');
  const parsed = parseMembersWorkbook(buf);
  const plan: ImportPlanRow[] = [];
  const seen = new Set<string>();
  const existing = parsed.rows.length ? await db.select().from(members).where(inArray(members.email, parsed.rows.map((r) => r.email))) : [];
  const byEmail = new Map(existing.map((m) => [m.email, m]));
  const here = existing.length ? await db.select().from(projectMembers).where(and(eq(projectMembers.projectId, projectId), inArray(projectMembers.memberId, existing.map((m) => m.id)))) : [];
  const hereBy = new Map(here.map((g) => [g.memberId, g]));
  const mine = grantable(ctx, projectId);
  for (const r of parsed.rows) {
    const m = byEmail.get(r.email);
    let action: ImportPlanRow['action'] = m ? 'updated' : 'new';
    let reason: string | null = null;
    if (seen.has(r.email)) [action, reason] = ['skipped', 'The email repeats an earlier row.'];
    else if (m?.isAccountAdmin) [action, reason] = ['skipped', 'Account Admin: has every project already.'];
    else if (m?.status === 'deactivated') [action, reason] = ['skipped', 'Deactivated: reactivate first.'];
    else if (r.level === 'project_admin' && !mine.projectAdmin) [action, reason] = ['error', 'You cannot make someone a Project Admin.'];
    else if (SWITCHES.some((k) => r.switches[k] && !mine[k])) [action, reason] = ['error', 'A switch you do not have yourself.'];
    else if (m) {
      const g = hereBy.get(m.id);
      const same =
        g &&
        g.accessLevel === r.level &&
        (r.level === 'project_admin' || (g.swBilling === !!r.switches.billing && g.swEdit === !!r.switches.edit && g.swImportExport === !!r.switches.importExport && g.swPlanning === !!r.switches.planning));
      if (same) [action, reason] = ['skipped', 'Already a member of this project with the same access.'];
    }
    seen.add(r.email);
    plan.push({ ...r, action, reason });
  }
  for (const e of parsed.errors) plan.push({ row: e.row, name: '', email: '', phone: null, company: null, role: null, level: 'member', switches: {}, action: 'error', reason: e.message });
  plan.sort((a, b) => a.row - b.row);
  const counts = { new: 0, updated: 0, skipped: 0, errors: 0 };
  for (const p of plan) counts[p.action === 'error' ? 'errors' : p.action]++;
  const links: { email: string; link: string }[] = [];
  if (apply) {
    for (const p of plan.filter((x) => x.action === 'new' || x.action === 'updated')) {
      const res = await addMember(ctx, { name: p.name, email: p.email, phone: p.phone, company: p.company, role: p.role, projectId, level: p.level, switches: p.switches });
      if (res.invite) links.push({ email: p.email, link: res.invite.link });
    }
  }
  return { sheet: parsed.sheet, counts, rows: plan, applied: apply, links };
}

export function membersTemplate(): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['Name', 'Email', 'Phone', 'Company', 'Role', 'Access level', 'Billing', 'Edit Mode', 'Import / Export', 'Planning'],
      ['First Last', 'name@company.com', null, 'Company name', 'Architect', 'Member', 'No', 'No', 'No', 'No'],
    ]),
    'Members',
  );
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export async function exportMembers(ctx: AdminCtx, q: MemberListQuery): Promise<Buffer> {
  const all = await listMembers(ctx, { ...q, page: 1, pageSize: 100 });
  const rows = [...all.rows];
  for (let page = 2; page <= all.pageCount; page++) rows.push(...(await listMembers(ctx, { ...q, page, pageSize: 100 })).rows);
  const yn = (b: boolean) => (b ? 'Yes' : 'No');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      rows.map((r) => ({
        Name: r.name,
        Email: r.email,
        Phone: r.phone ?? '',
        Status: r.status,
        Company: r.company ?? '',
        Role: r.role ?? '',
        'Access level': r.levelLabel,
        'Added on': r.addedOn?.slice(0, 10) ?? '',
        'Last sign-in': r.lastSignIn ? r.lastSignIn.slice(0, 16).replace('T', ' ') : '',
        Billing: yn(r.switches.billing),
        'Edit Mode': yn(r.switches.edit),
        'Import / Export': yn(r.switches.importExport),
        Planning: yn(r.switches.planning),
      })),
    ),
    'Members',
  );
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/** A new-project import makes the importer its Project Admin (Import Centre). */
export async function grantProjectAdmin(memberId: string, projectId: string, actor: Actor) {
  const [cur] = await db.select().from(projectMembers).where(and(eq(projectMembers.memberId, memberId), eq(projectMembers.projectId, projectId))).limit(1);
  if (cur?.accessLevel === 'project_admin') return;
  const values = { accessLevel: 'project_admin', swBilling: true, swEdit: true, swImportExport: true, swPlanning: true };
  if (cur) await db.update(projectMembers).set({ ...values, updatedAt: new Date() }).where(eq(projectMembers.id, cur.id));
  else await db.insert(projectMembers).values({ id: newId('pm_'), memberId, projectId, ...values, addedBy: actor.label, updatedAt: new Date() });
  const m = await memberById(memberId);
  await recordAudit({ actor, entityType: 'MEMBER', entityId: memberId, entityLabel: label(m), action: 'SET_ACCESS', newValue: JSON.stringify({ level: 'project_admin' }), reason: 'Created the project by an import', projectId });
}
