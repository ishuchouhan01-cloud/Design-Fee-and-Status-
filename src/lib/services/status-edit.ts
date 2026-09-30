/**
 * Edit Mode on Project Drawing Status — the writes that have no Drawing
 * Control equivalent: Responsible Person, package name and code, billing
 * amounts, new towers / packages / disciplines, package dependencies and
 * archiving. Drawing edits, releases, revisions and date moves go through the
 * existing Drawing Control services and the reschedule engine.
 *
 * Every write is validated, audited and marks the field as edited by a
 * person, so a later import keeps it.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, type DbLike } from '@/db';
import { disciplines, drawings, packageDependencies, packageFees, packages, projects, users } from '@/db/schema';
import { recordAudit, type Actor } from '@/lib/audit';
import { parseEditedFields } from '@/lib/domain';
import { newId } from '@/lib/ids';
import { projectLabel } from '@/lib/labels';
import { startOfDay } from '@/lib/periods';
import { updateDrawing } from './drawing-control';

export class EditRuleError extends Error {
  status = 400;
}

const addEdited = (existing: string | null | undefined, fields: string[]) => {
  const set = parseEditedFields(existing);
  for (const f of fields) set.add(f);
  return [...set].sort().join(',');
};

const text = (v: unknown) => (v == null ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v));

async function loadPackage(id: string, tx: DbLike = db) {
  const [p] = await tx.select().from(packages).where(eq(packages.id, id)).limit(1);
  if (!p || p.archivedAt) throw new EditRuleError('This package was not found (it may have been archived).');
  return p;
}

/** A user whose name matches (ignoring case), else the name as given. Never invents a person. */
export async function resolvePerson(name: string | null | undefined, tx: DbLike = db) {
  const n = name?.trim().replace(/\s+/g, ' ') ?? '';
  if (!n) return { userId: null as string | null, text: null as string | null };
  if (n.length > 200) throw new EditRuleError('A name can be at most 200 characters.');
  const [u] = await tx
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.active, true), sql`lower(${users.name}) = lower(${n})`))
    .limit(1);
  return u ? { userId: u.id, text: null } : { userId: null, text: n };
}

/** People to suggest in the Responsible Person cell: active users and names already used. */
export async function peopleSuggestions() {
  const rows = await db.execute(sql`
    select name from (
      select name from users where active and email not like '%@project-drawing-status.local'
      union select responsible_text from packages where responsible_text is not null
      union select responsible_text from drawings where responsible_text is not null
    ) x where name is not null order by name limit 500`);
  return (rows.rows as { name: string }[]).map((r) => r.name);
}

// ---------------------------------------------------------------------------
// Responsible Person
// ---------------------------------------------------------------------------

export async function setResponsible(kind: 'PACKAGE' | 'DRAWING', id: string, name: string | null, actor: Actor) {
  const person = await resolvePerson(name);
  if (kind === 'DRAWING') {
    return updateDrawing(id, { responsibleUserId: person.userId, responsibleText: person.text }, actor, 'Responsible Person set in Project Drawing Status');
  }
  return db.transaction(async (tx) => {
    const p = await loadPackage(id, tx);
    const before = p.responsibleUserId ? ((await tx.select({ name: users.name }).from(users).where(eq(users.id, p.responsibleUserId)))[0]?.name ?? null) : p.responsibleText;
    const after = name?.trim() || null;
    if ((before ?? '') === (after ?? '')) return { id, changes: [] };
    await tx
      .update(packages)
      .set({ responsibleUserId: person.userId, responsibleText: person.text, userEditedFields: addEdited(p.userEditedFields, ['responsible']), updatedAt: new Date() })
      .where(eq(packages.id, id));
    await recordAudit(
      { actor, entityType: 'PACKAGE', entityId: id, entityLabel: `${p.packageCode} — ${p.packageName}`, action: 'UPDATE', field: 'responsible', oldValue: before, newValue: after, projectId: p.projectId, reason: 'Project Drawing Status (Edit Mode)' },
      tx,
    );
    return { id, changes: [{ field: 'responsible', from: before, to: after }] };
  });
}

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9 ._/()-]{0,39}$/;

async function assertCodeFree(tx: DbLike, projectId: string, code: string, exceptId?: string) {
  const [clash] = await tx
    .select({ id: packages.id })
    .from(packages)
    .where(and(eq(packages.projectId, projectId), sql`upper(${packages.packageCode}) = upper(${code})`))
    .limit(1);
  if (clash && clash.id !== exceptId) throw new EditRuleError(`Package code ${code} is already used in this project.`);
}

export async function updatePackage(id: string, patch: { packageName?: string; packageCode?: string }, actor: Actor) {
  return db.transaction(async (tx) => {
    const p = await loadPackage(id, tx);
    const set: Record<string, unknown> = {};
    const changes: { field: string; from: string; to: string }[] = [];
    if (patch.packageName !== undefined) {
      const name = patch.packageName.trim().replace(/\s+/g, ' ');
      if (!name) throw new EditRuleError('A package needs a name.');
      if (name.length > 200) throw new EditRuleError('A package name can be at most 200 characters.');
      if (name !== p.packageName) {
        set.packageName = name;
        changes.push({ field: 'packageName', from: p.packageName, to: name });
      }
    }
    if (patch.packageCode !== undefined) {
      const code = patch.packageCode.trim();
      if (!CODE_RE.test(code)) throw new EditRuleError('A package code is 1–40 letters, digits, spaces or . _ / ( ) -');
      if (code !== p.packageCode) {
        await assertCodeFree(tx, p.projectId, code, id);
        set.packageCode = code;
        // The source's code is kept so an import still finds this package.
        if (!p.sourceCode && p.sourceWorkbook) set.sourceCode = p.packageCode;
        changes.push({ field: 'packageCode', from: p.packageCode, to: code });
      }
    }
    if (!changes.length) return { id, changes };
    await tx
      .update(packages)
      .set({ ...set, userEditedFields: addEdited(p.userEditedFields, changes.map((c) => c.field)), updatedAt: new Date() } as never)
      .where(eq(packages.id, id));
    for (const c of changes) {
      await recordAudit(
        { actor, entityType: 'PACKAGE', entityId: id, entityLabel: `${p.packageCode} — ${p.packageName}`, action: 'UPDATE', field: c.field, oldValue: c.from, newValue: c.to, projectId: p.projectId, reason: 'Project Drawing Status (Edit Mode)' },
        tx,
      );
    }
    return { id, changes };
  });
}

export async function createPackage(
  input: { projectId: string; wbsNodeId?: string | null; packageCode: string; packageName: string; expectedReleaseDate?: Date | null; responsible?: string | null },
  actor: Actor,
) {
  const code = input.packageCode.trim();
  const name = input.packageName.trim().replace(/\s+/g, ' ');
  if (!CODE_RE.test(code)) throw new EditRuleError('A package code is 1–40 letters, digits, spaces or . _ / ( ) -');
  if (!name) throw new EditRuleError('A package needs a name.');
  return db.transaction(async (tx) => {
    const [prj] = await tx.select().from(projects).where(eq(projects.id, input.projectId)).limit(1);
    if (!prj || prj.archivedAt) throw new EditRuleError('The project was not found.');
    await assertCodeFree(tx, prj.id, code);
    const person = await resolvePerson(input.responsible, tx);
    const expected = input.expectedReleaseDate ? startOfDay(input.expectedReleaseDate) : null;
    const [{ seq }] = await tx.select({ seq: sql<number>`coalesce(max(${packages.sequence}), 0)::int` }).from(packages).where(eq(packages.projectId, prj.id));
    const id = newId('pk_');
    await tx.insert(packages).values({
      id,
      projectId: prj.id,
      packageCode: code,
      packageName: name,
      sequence: seq + 10,
      wbsNodeId: input.wbsNodeId ?? null,
      // A new package's first plan is its baseline; it is never changed afterwards.
      baselineReleaseDate: expected,
      currentExpectedReleaseDate: expected,
      responsibleUserId: person.userId,
      responsibleText: person.text,
      userEditedFields: 'packageCode,packageName',
      updatedAt: new Date(),
    });
    await recordAudit({ actor, entityType: 'PACKAGE', entityId: id, entityLabel: `${code} — ${name}`, action: 'CREATE', projectId: prj.id, reason: 'Added in Project Drawing Status (Edit Mode)' }, tx);
    return { id };
  });
}

/** A discipline under a package: its fee line (Applicable, no amounts yet). */
export async function addDiscipline(packageId: string, disciplineId: string, actor: Actor) {
  return db.transaction(async (tx) => {
    const p = await loadPackage(packageId, tx);
    const [d] = await tx.select().from(disciplines).where(eq(disciplines.id, disciplineId)).limit(1);
    if (!d) throw new EditRuleError('Choose a discipline.');
    const group = d.dfsGroup ?? d.code;
    const lines = await tx
      .select({ id: packageFees.id, applicability: packageFees.applicability, edited: packageFees.userEditedFields })
      .from(packageFees)
      .innerJoin(disciplines, eq(packageFees.disciplineId, disciplines.id))
      .where(and(eq(packageFees.packageId, packageId), sql`coalesce(${disciplines.dfsGroup}, ${disciplines.code}) = ${group}`));
    if (lines.length && lines.every((l) => l.applicability === 'APPLICABLE')) throw new EditRuleError(`${d.name} is already in this package.`);
    if (lines.length) {
      for (const l of lines) await tx.update(packageFees).set({ applicability: 'APPLICABLE', userEditedFields: addEdited(l.edited, ['applicability', 'added']), updatedAt: new Date() }).where(eq(packageFees.id, l.id));
    } else {
      await tx.insert(packageFees).values({ id: newId('pf_'), packageId, disciplineId, applicability: 'APPLICABLE', userEditedFields: 'added', updatedAt: new Date() });
    }
    await recordAudit(
      { actor, entityType: 'PACKAGE', entityId: packageId, entityLabel: `${p.packageCode} — ${p.packageName}`, action: 'UPDATE', field: `discipline.${group}`, newValue: 'APPLICABLE', projectId: p.projectId, reason: 'Discipline added in Project Drawing Status (Edit Mode)' },
      tx,
    );
    return { packageId, group };
  });
}

// ---------------------------------------------------------------------------
// Billing: Total (scope) and Billed (to date) of a package × discipline
// ---------------------------------------------------------------------------

export async function setBilling(input: { packageId: string; group: string; total?: number | null; billed?: number | null }, actor: Actor) {
  const check = (v: number | null | undefined, what: string) => {
    if (v == null) return;
    if (!Number.isFinite(v) || v < 0) throw new EditRuleError(`${what} must be zero or more.`);
    if (v > 1_000_000) throw new EditRuleError(`${what} looks too large — amounts are in crores of rupees.`);
  };
  check(input.total, 'Total');
  check(input.billed, 'Billed');
  return db.transaction(async (tx) => {
    const p = await loadPackage(input.packageId, tx);
    const lines = await tx
      .select({ f: packageFees, code: disciplines.code })
      .from(packageFees)
      .innerJoin(disciplines, eq(packageFees.disciplineId, disciplines.id))
      .where(and(eq(packageFees.packageId, p.id), sql`coalesce(${disciplines.dfsGroup}, ${disciplines.code}) = ${input.group}`));
    let line = lines[0]?.f;
    if (lines.length > 1) throw new EditRuleError('This discipline has more than one fee line; change them in the Design Fee sheet and import it.');
    if (!line) {
      const [d] = await tx
        .select()
        .from(disciplines)
        .where(sql`coalesce(${disciplines.dfsGroup}, ${disciplines.code}) = ${input.group}`)
        .orderBy(sql`case when ${disciplines.code} = ${input.group} then 0 else 1 end`)
        .limit(1);
      if (!d) throw new EditRuleError('Unknown discipline.');
      [line] = await tx.insert(packageFees).values({ id: newId('pf_'), packageId: p.id, disciplineId: d.id, applicability: 'APPLICABLE', userEditedFields: 'added', updatedAt: new Date() }).returning();
    }
    if (line.applicability === 'NA') throw new EditRuleError('This discipline is Not Applicable; it carries no billing.');
    const changes: { field: string; from: number | null; to: number | null }[] = [];
    const set: Record<string, unknown> = {};
    if (input.total !== undefined && input.total !== line.feeValue) {
      set.feeValue = input.total;
      changes.push({ field: 'feeValue', from: line.feeValue, to: input.total });
    }
    if (input.billed !== undefined && input.billed !== line.billedToDateValue) {
      set.billedToDateValue = input.billed;
      changes.push({ field: 'billedToDateValue', from: line.billedToDateValue, to: input.billed });
    }
    if (!changes.length) return { changes };
    await tx
      .update(packageFees)
      .set({ ...set, userEditedFields: addEdited(line.userEditedFields, changes.map((c) => c.field)), updatedAt: new Date() } as never)
      .where(eq(packageFees.id, line.id));
    for (const c of changes) {
      await recordAudit(
        {
          actor,
          entityType: 'PACKAGE',
          entityId: p.id,
          entityLabel: `${p.packageCode} — ${p.packageName}`,
          action: 'UPDATE',
          field: `${c.field === 'feeValue' ? 'billing.total' : 'billing.billed'}.${input.group}`,
          oldValue: c.from == null ? null : String(c.from),
          newValue: c.to == null ? null : String(c.to),
          projectId: p.projectId,
          reason: 'Billing (Edit Mode)',
        },
        tx,
      );
    }
    return { changes };
  });
}

// ---------------------------------------------------------------------------
// Towers / products
// ---------------------------------------------------------------------------

export async function createTower(input: { parentProjectId: string; name: string }, actor: Actor) {
  const name = input.name.trim().replace(/\s+/g, ' ');
  if (!name) throw new EditRuleError('A tower or product needs a name.');
  if (name.length > 120) throw new EditRuleError('A name can be at most 120 characters.');
  return db.transaction(async (tx) => {
    const [parent] = await tx.select().from(projects).where(eq(projects.id, input.parentProjectId)).limit(1);
    if (!parent || parent.archivedAt) throw new EditRuleError('The project was not found.');
    const siblings = await tx.select().from(projects).where(and(eq(projects.parentProjectId, parent.id), isNull(projects.archivedAt)));
    if (siblings.some((s) => projectLabel(s).toLowerCase() === name.toLowerCase())) throw new EditRuleError(`${name} is already under ${projectLabel(parent)}.`);
    const base = `${parent.projectCode}-${name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`.slice(0, 60);
    let code = base;
    for (let i = 2; (await tx.select({ id: projects.id }).from(projects).where(eq(projects.projectCode, code)).limit(1)).length; i++) code = `${base}-${i}`;
    const id = newId('pr_');
    const [{ order }] = await tx.select({ order: sql<number>`coalesce(max(${projects.displayOrder}), 0)::int` }).from(projects).where(eq(projects.parentProjectId, parent.id));
    await tx.insert(projects).values({ id, projectCode: code, projectName: name, displayName: name, parentProjectId: parent.id, displayOrder: order + 1, updatedAt: new Date() });
    await recordAudit({ actor, entityType: 'PROJECT', entityId: id, entityLabel: name, action: 'CREATE', reason: `Added under ${projectLabel(parent)} in Project Drawing Status (Edit Mode)` }, tx);
    return { id, projectCode: code };
  });
}

// ---------------------------------------------------------------------------
// Archive (soft delete): hidden everywhere, never removed; audited.
// ---------------------------------------------------------------------------

export async function archiveRow(kind: 'DRAWING' | 'PACKAGE' | 'PROJECT', id: string, reason: string, actor: Actor) {
  const why = reason.trim();
  if (why.length < 3) throw new EditRuleError('Give a reason for archiving.');
  const stamp = new Date();
  return db.transaction(async (tx) => {
    if (kind === 'DRAWING') {
      const [d] = await tx.select().from(drawings).where(eq(drawings.id, id)).limit(1);
      if (!d || d.archivedAt) throw new EditRuleError('This drawing was not found (it may already be archived).');
      await tx.update(drawings).set({ archivedAt: stamp, archivedByLabel: actor.label, updatedAt: stamp, editedAt: stamp }).where(eq(drawings.id, id));
      await recordAudit({ actor, entityType: 'DRAWING', entityId: id, entityLabel: `${d.drawingCode} — ${d.drawingName}`, action: 'ARCHIVE', reason: why, projectId: d.projectId }, tx);
      return { archived: 1 };
    }
    if (kind === 'PACKAGE') {
      const p = await loadPackage(id, tx);
      const ds = await tx.update(drawings).set({ archivedAt: stamp, archivedByLabel: actor.label, updatedAt: stamp }).where(and(eq(drawings.packageId, id), isNull(drawings.archivedAt))).returning({ id: drawings.id });
      await tx.update(packages).set({ archivedAt: stamp, archivedByLabel: actor.label, updatedAt: stamp }).where(eq(packages.id, id));
      await recordAudit(
        { actor, entityType: 'PACKAGE', entityId: id, entityLabel: `${p.packageCode} — ${p.packageName}`, action: 'ARCHIVE', newValue: `${ds.length} drawing(s) archived with it`, reason: why, projectId: p.projectId },
        tx,
      );
      return { archived: 1 + ds.length };
    }
    const [prj] = await tx.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (!prj || prj.archivedAt) throw new EditRuleError('This tower or product was not found (it may already be archived).');
    if (!prj.parentProjectId) throw new EditRuleError('A top-level project is not archived here; archive its towers, packages or drawings.');
    await tx.update(projects).set({ archivedAt: stamp, archivedByLabel: actor.label, updatedAt: stamp }).where(eq(projects.id, id));
    await recordAudit({ actor, entityType: 'PROJECT', entityId: id, entityLabel: projectLabel(prj), action: 'ARCHIVE', reason: why }, tx);
    return { archived: 1 };
  });
}

// ---------------------------------------------------------------------------
// Package dependencies (the drawing dependencies' pattern, one level up)
// ---------------------------------------------------------------------------

export interface PackageDependencyInput {
  department: string;
  ownerText?: string | null;
  description: string;
  targetDate?: Date | null;
  remarks?: string | null;
}

export async function listPackageDependencies(packageId: string) {
  return db.select().from(packageDependencies).where(eq(packageDependencies.packageId, packageId)).orderBy(packageDependencies.createdAt);
}

export async function addPackageDependency(packageId: string, input: PackageDependencyInput, actor: Actor) {
  return db.transaction(async (tx) => {
    const p = await loadPackage(packageId, tx);
    const owner = await resolvePerson(input.ownerText, tx);
    const id = newId('pdp_');
    await tx.insert(packageDependencies).values({
      id,
      packageId,
      projectId: p.projectId,
      department: input.department.trim(),
      ownerUserId: owner.userId,
      ownerText: owner.text,
      description: input.description.trim(),
      targetDate: input.targetDate ? startOfDay(input.targetDate) : null,
      status: 'OPEN',
      remarks: input.remarks ?? null,
      createdById: actor.id,
      createdByLabel: actor.label,
      updatedAt: new Date(),
    });
    await recordAudit(
      { actor, entityType: 'PACKAGE', entityId: packageId, entityLabel: `${p.packageCode} — ${p.packageName}`, action: 'ADD_DEPENDENCY', newValue: `${input.department}: ${input.description}`, projectId: p.projectId },
      tx,
    );
    return { id };
  });
}

export async function updatePackageDependency(
  id: string,
  patch: Partial<PackageDependencyInput> & { status?: 'OPEN' | 'CLOSED'; closureDate?: Date | null },
  actor: Actor,
) {
  return db.transaction(async (tx) => {
    const [dep] = await tx.select().from(packageDependencies).where(eq(packageDependencies.id, id)).limit(1);
    if (!dep) throw new EditRuleError('This dependency was not found.');
    const next: Record<string, unknown> = {};
    if (patch.department !== undefined) next.department = patch.department.trim();
    if (patch.description !== undefined) next.description = patch.description.trim();
    if (patch.remarks !== undefined) next.remarks = patch.remarks;
    if (patch.targetDate !== undefined) next.targetDate = patch.targetDate ? startOfDay(patch.targetDate) : null;
    if (patch.ownerText !== undefined) {
      const o = await resolvePerson(patch.ownerText, tx);
      next.ownerUserId = o.userId;
      next.ownerText = o.text;
    }
    if (patch.status === 'CLOSED') {
      next.status = 'CLOSED';
      next.closureDate = patch.closureDate ? startOfDay(patch.closureDate) : startOfDay(new Date());
    } else if (patch.status === 'OPEN') {
      next.status = 'OPEN';
      next.closureDate = null;
    }
    const changes = Object.entries(next).filter(([k, v]) => text((dep as Record<string, unknown>)[k]) !== text(v));
    if (!changes.length) return { id, changes: [] };
    await tx.update(packageDependencies).set({ ...Object.fromEntries(changes), updatedAt: new Date() }).where(eq(packageDependencies.id, id));
    for (const [field, to] of changes) {
      await recordAudit(
        { actor, entityType: 'PACKAGE', entityId: dep.packageId, entityLabel: dep.description, action: 'UPDATE_DEPENDENCY', field, oldValue: text((dep as Record<string, unknown>)[field]), newValue: text(to), projectId: dep.projectId },
        tx,
      );
    }
    return { id, changes: changes.map(([f]) => f) };
  });
}
