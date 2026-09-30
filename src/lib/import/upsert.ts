/**
 * Idempotent upsert helpers keyed on natural keys, so re-running the migration
 * updates rather than duplicates (spec §30).
 */
import { createHash } from 'node:crypto';
import { sourceDating } from '@/lib/updated-on';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  criticalRequirements,
  deliverables,
  dependencies,
  disciplines,
  drawings,
  goalRevisions,
  goals,
  packageFees,
  packages,
  projectPhases,
  projects,
  teamAssignments,
  users,
} from '@/db/schema';
import { codeify, newId, slug } from '@/lib/ids';
import { parseEditedFields } from '@/lib/domain';
import { canonicalDisciplineCode } from '@/lib/seed';

export function hash6(...parts: (string | number | null | undefined)[]): string {
  return createHash('sha1').update(slug(...parts)).digest('hex').slice(0, 6).toUpperCase();
}

// --- caches keep the importer fast on large workbooks ----------------------
const cache = {
  disciplineByCode: new Map<string, string>(),
  userByName: new Map<string, string>(),
  projectByName: new Map<string, string>(),
  phaseByKey: new Map<string, string>(),
  packageByKey: new Map<string, string>(),
};

export function resetCaches() {
  cache.disciplineByCode.clear();
  cache.userByName.clear();
  cache.projectByName.clear();
  cache.phaseByKey.clear();
  cache.packageByKey.clear();
}

export function normaliseName(v: string): string {
  return v.trim().replace(/\s+/g, ' ').toUpperCase();
}

export async function disciplineIdFor(raw: string | null | undefined): Promise<string | null> {
  const code = canonicalDisciplineCode(raw);
  if (!code) return null;
  if (cache.disciplineByCode.has(code)) return cache.disciplineByCode.get(code)!;
  const [row] = await db.select().from(disciplines).where(eq(disciplines.code, code)).limit(1);
  if (!row) return null;
  cache.disciplineByCode.set(code, row.id);
  return row.id;
}

/**
 * Design leads and team members come through as display names. They become
 * real user rows (role EDITOR) so that ownership, filters and the audit trail
 * all point at one identity per person.
 */
export async function userIdForPersonName(rawName: string | null | undefined): Promise<string | null> {
  const name = rawName ? rawName.trim().replace(/\s+/g, ' ') : '';
  if (!name || name.length < 2) return null;
  const key = normaliseName(name);
  if (cache.userByName.has(key)) return cache.userByName.get(key)!;
  const email = `${codeify(name).toLowerCase().replace(/-+/g, '.')}@imported.local`;
  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing) {
    cache.userByName.set(key, existing.id);
    return existing.id;
  }
  const id = newId('us_');
  await db.insert(users).values({ id, name, email, role: 'EDITOR', active: true, updatedAt: new Date() });
  cache.userByName.set(key, id);
  return id;
}

export interface ProjectInput {
  name: string;
  portfolio?: string;
  description?: string | null;
  onHold?: boolean;
  active?: boolean;
  location?: string | null;
}

export async function upsertProject(input: ProjectInput): Promise<string> {
  const key = normaliseName(input.name);
  if (cache.projectByName.has(key)) {
    const id = cache.projectByName.get(key)!;
    if (input.portfolio || input.description || input.onHold != null) {
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (input.portfolio) patch.portfolio = input.portfolio;
      if (input.description) patch.description = input.description;
      if (input.onHold != null) patch.onHold = input.onHold;
      if (input.location) patch.location = input.location;
      await db.update(projects).set(patch as never).where(eq(projects.id, id));
    }
    return id;
  }
  const projectCode = codeify(input.name);
  const [existing] = await db.select().from(projects).where(eq(projects.projectCode, projectCode)).limit(1);
  if (existing) {
    cache.projectByName.set(key, existing.id);
    return existing.id;
  }
  const id = newId('pr_');
  await db.insert(projects).values({
    id,
    projectCode,
    projectName: input.name.trim().replace(/\s+/g, ' '),
    portfolio: input.portfolio ?? 'Ongoing',
    description: input.description ?? null,
    location: input.location ?? null,
    active: input.active ?? true,
    onHold: input.onHold ?? false,
    updatedAt: new Date(),
  });
  cache.projectByName.set(key, id);
  return id;
}

export async function findProjectByName(name: string): Promise<string | null> {
  const key = normaliseName(name);
  if (cache.projectByName.has(key)) return cache.projectByName.get(key)!;
  const code = codeify(name);
  const [row] = await db.select().from(projects).where(eq(projects.projectCode, code)).limit(1);
  if (row) {
    cache.projectByName.set(key, row.id);
    return row.id;
  }
  return null;
}

export async function upsertPhase(projectId: string, code: string, sequence = 100): Promise<string> {
  const clean = code.trim().replace(/\s+/g, ' ');
  const key = `${projectId}|${normaliseName(clean)}`;
  if (cache.phaseByKey.has(key)) return cache.phaseByKey.get(key)!;
  const [existing] = await db
    .select()
    .from(projectPhases)
    .where(and(eq(projectPhases.projectId, projectId), eq(projectPhases.code, clean)))
    .limit(1);
  if (existing) {
    cache.phaseByKey.set(key, existing.id);
    return existing.id;
  }
  const id = newId('ph_');
  await db.insert(projectPhases).values({ id, projectId, code: clean, name: clean, sequence, active: true });
  cache.phaseByKey.set(key, id);
  return id;
}

export interface PackageInput {
  projectId: string;
  phaseId?: string | null;
  packageCode: string;
  packageName: string;
  packageGroup?: string | null;
  sequence?: number;
  durationDays?: number | null;
  baselineReleaseDate?: Date | null;
  currentExpectedReleaseDate?: Date | null;
}

export async function upsertPackage(input: PackageInput): Promise<string> {
  const key = `${input.projectId}|${input.packageCode.toUpperCase()}`;
  if (cache.packageByKey.has(key)) {
    const id = cache.packageByKey.get(key)!;
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.durationDays != null) patch.durationDays = input.durationDays;
    if (input.packageGroup) patch.packageGroup = input.packageGroup;
    if (input.baselineReleaseDate) patch.baselineReleaseDate = input.baselineReleaseDate;
    if (input.currentExpectedReleaseDate) patch.currentExpectedReleaseDate = input.currentExpectedReleaseDate;
    // A date or name a person changed (Edit Mode) is kept.
    const [cur] = await db.select({ edited: packages.userEditedFields }).from(packages).where(eq(packages.id, id)).limit(1);
    if (cur?.edited.includes('currentExpectedReleaseDate')) delete patch.currentExpectedReleaseDate;
    await db.update(packages).set(patch as never).where(eq(packages.id, id));
    return id;
  }
  const [existing] = await db
    .select()
    .from(packages)
    .where(and(eq(packages.projectId, input.projectId), sql`coalesce(${packages.sourceCode}, ${packages.packageCode}) = ${input.packageCode}`))
    .limit(1);
  if (existing) {
    cache.packageByKey.set(key, existing.id);
    return existing.id;
  }
  const id = newId('pk_');
  await db.insert(packages).values({
    id,
    projectId: input.projectId,
    phaseId: input.phaseId ?? null,
    packageCode: input.packageCode,
    sourceCode: input.packageCode,
    packageName: input.packageName,
    packageGroup: input.packageGroup ?? null,
    sequence: input.sequence ?? 100,
    durationDays: input.durationDays ?? null,
    baselineReleaseDate: input.baselineReleaseDate ?? null,
    currentExpectedReleaseDate: input.currentExpectedReleaseDate ?? input.baselineReleaseDate ?? null,
    updatedAt: new Date(),
  });
  cache.packageByKey.set(key, id);
  return id;
}

export async function findPackageByName(projectId: string, name: string): Promise<string | null> {
  const rows = await db.select().from(packages).where(eq(packages.projectId, projectId));
  const target = normaliseName(name).replace(/[^A-Z0-9]/g, '');
  const hit = rows.find((r) => normaliseName(r.packageName).replace(/[^A-Z0-9]/g, '') === target);
  return hit?.id ?? null;
}

export async function upsertPackageFee(packageId: string, disciplineId: string, feePercent: number | null, feeValue: number | null) {
  const [existing] = await db
    .select()
    .from(packageFees)
    .where(and(eq(packageFees.packageId, packageId), eq(packageFees.disciplineId, disciplineId)))
    .limit(1);
  if (existing) {
    // A fee a person set in Edit Mode (Billing) is kept.
    const keepFee = existing.userEditedFields.includes('feeValue');
    await db.update(packageFees).set(keepFee ? { feePercent } : { feePercent, feeValue }).where(eq(packageFees.id, existing.id));
    return existing.id;
  }
  const id = newId('pf_');
  await db.insert(packageFees).values({ id, packageId, disciplineId, feePercent, feeValue });
  return id;
}

export interface GoalInput {
  projectId: string;
  phaseId: string | null;
  disciplineId: string | null;
  designLeadId: string | null;
  goalDescription: string;
  fiscalYear: string;
  quarter: number;
  periodStart: Date;
  periodEnd: Date;
  plannedQuantity: number;
  plannedValue: number;
  reportedActualQuantity?: number;
  reportedActualValue?: number;
  priority?: string;
  remarks?: string | null;
  sourceSheet?: string;
  sourceRow?: number;
  isBaselineRevision?: boolean;
}

export interface UpsertResult {
  id: string;
  created: boolean;
}

export function goalCodeFor(input: {
  projectCode: string;
  phase: string | null;
  discipline: string | null;
  lead: string | null;
  description: string;
  fiscalYear: string;
  quarter: number;
}): string {
  return `G-${input.projectCode}-${input.fiscalYear.replace(/[^A-Z0-9]/gi, '')}Q${input.quarter}-${hash6(
    input.phase,
    input.discipline,
    input.lead,
    input.description,
  )}`;
}

export async function upsertGoal(goalCode: string, input: GoalInput): Promise<UpsertResult> {
  const [existing] = await db.select().from(goals).where(eq(goals.goalCode, goalCode)).limit(1);
  const completion = deriveGoalCompletion(input.plannedQuantity, input.reportedActualQuantity ?? 0);
  if (existing) {
    await db
      .update(goals)
      .set({
        projectId: input.projectId,
        phaseId: input.phaseId,
        disciplineId: input.disciplineId,
        designLeadId: input.designLeadId,
        goalDescription: input.goalDescription,
        plannedQuantity: input.plannedQuantity,
        plannedValue: input.plannedValue,
        reportedActualQuantity: input.reportedActualQuantity ?? existing.reportedActualQuantity,
        reportedActualValue: input.reportedActualValue ?? existing.reportedActualValue,
        priority: input.priority ?? existing.priority,
        remarks: input.remarks ?? existing.remarks,
        sourceSheet: input.sourceSheet ?? existing.sourceSheet,
        sourceRow: input.sourceRow ?? existing.sourceRow,
        isBaselineRevision: input.isBaselineRevision ?? existing.isBaselineRevision,
        // BASELINE IS NEVER REWRITTEN once set (spec §11 / §32).
        completionStatus: completion.status,
        actualCompletionDate:
          completion.status === 'COMPLETED' ? existing.actualCompletionDate ?? input.periodEnd : null,
        updatedAt: new Date(),
      })
      .where(eq(goals.id, existing.id));
    return { id: existing.id, created: false };
  }
  const id = newId('gl_');
  await db.insert(goals).values({
    id,
    goalCode,
    projectId: input.projectId,
    phaseId: input.phaseId,
    disciplineId: input.disciplineId,
    designLeadId: input.designLeadId,
    goalDescription: input.goalDescription,
    fiscalYear: input.fiscalYear,
    quarter: input.quarter,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    plannedQuantity: input.plannedQuantity,
    plannedValue: input.plannedValue,
    reportedActualQuantity: input.reportedActualQuantity ?? 0,
    reportedActualValue: input.reportedActualValue ?? 0,
    baselineTargetDate: input.periodEnd,
    currentExpectedDate: input.periodEnd,
    actualCompletionDate: completion.status === 'COMPLETED' ? input.periodEnd : null,
    completionStatus: completion.status,
    priority: input.priority ?? 'MEDIUM',
    remarks: input.remarks ?? null,
    sourceSheet: input.sourceSheet ?? null,
    sourceRow: input.sourceRow ?? null,
    isBaselineRevision: input.isBaselineRevision ?? false,
    updatedAt: new Date(),
  });
  return { id, created: true };
}

/**
 * A goal is a target quantity. It is complete when the reported delivered
 * quantity reaches the planned quantity. Nothing here stores a percentage.
 */
export function deriveGoalCompletion(planned: number, actual: number): { status: 'COMPLETED' | 'NOT_COMPLETED' } {
  return { status: planned > 0 && actual >= planned ? 'COMPLETED' : 'NOT_COMPLETED' };
}

export async function replaceTeam(goalId: string, members: { name: string; role: string }[]) {
  await db.delete(teamAssignments).where(eq(teamAssignments.goalId, goalId));
  for (const m of members) {
    if (!m.name) continue;
    await db.insert(teamAssignments).values({
      id: newId('ta_'),
      goalId,
      userId: await userIdForPersonName(m.name),
      personName: m.name,
      roleOnGoal: m.role,
    });
  }
}

export async function addGoalRevision(row: {
  goalId: string;
  previousExpectedDate?: Date | null;
  newExpectedDate?: Date | null;
  previousTargetQuantity?: number | null;
  newTargetQuantity?: number | null;
  previousTargetValue?: number | null;
  newTargetValue?: number | null;
  reason: string;
  impactSummary?: string;
}) {
  await db.insert(goalRevisions).values({
    id: newId('gr_'),
    goalId: row.goalId,
    previousExpectedDate: row.previousExpectedDate ?? null,
    newExpectedDate: row.newExpectedDate ?? null,
    previousTargetQuantity: row.previousTargetQuantity ?? null,
    newTargetQuantity: row.newTargetQuantity ?? null,
    previousTargetValue: row.previousTargetValue ?? null,
    newTargetValue: row.newTargetValue ?? null,
    reason: row.reason,
    changedById: null,
    changedAt: new Date(),
    impactSummary: row.impactSummary ?? null,
  });
}

export interface DeliverableInput {
  projectId: string;
  phaseId?: string | null;
  goalId?: string | null;
  packageId?: string | null;
  disciplineId?: string | null;
  deliverableDescription: string;
  baselineReleaseDate: Date;
  currentExpectedReleaseDate?: Date | null;
  actualReleaseDate?: Date | null;
  completionStatus: 'COMPLETED' | 'NOT_COMPLETED';
  ownerId?: string | null;
  revision?: string | null;
  remarks?: string | null;
  fiscalYear?: string | null;
  quarter?: number | null;
  sourceSheet?: string;
}

export async function upsertDeliverable(code: string, input: DeliverableInput): Promise<UpsertResult> {
  const [existing] = await db.select().from(deliverables).where(eq(deliverables.deliverableCode, code)).limit(1);
  if (existing) {
    await db
      .update(deliverables)
      .set({
        projectId: input.projectId,
        phaseId: input.phaseId ?? existing.phaseId,
        goalId: input.goalId ?? existing.goalId,
        packageId: input.packageId ?? existing.packageId,
        disciplineId: input.disciplineId ?? existing.disciplineId,
        deliverableDescription: input.deliverableDescription,
        // baselineReleaseDate intentionally not updated once established
        actualReleaseDate: input.actualReleaseDate ?? existing.actualReleaseDate,
        completionStatus: input.completionStatus,
        ownerId: input.ownerId ?? existing.ownerId,
        revision: input.revision ?? existing.revision,
        remarks: input.remarks ?? existing.remarks,
        fiscalYear: input.fiscalYear ?? existing.fiscalYear,
        quarter: input.quarter ?? existing.quarter,
        sourceSheet: input.sourceSheet ?? existing.sourceSheet,
        updatedAt: new Date(),
      })
      .where(eq(deliverables.id, existing.id));
    return { id: existing.id, created: false };
  }
  const id = newId('dl_');
  await db.insert(deliverables).values({
    id,
    deliverableCode: code,
    projectId: input.projectId,
    phaseId: input.phaseId ?? null,
    goalId: input.goalId ?? null,
    packageId: input.packageId ?? null,
    disciplineId: input.disciplineId ?? null,
    deliverableDescription: input.deliverableDescription,
    baselineReleaseDate: input.baselineReleaseDate,
    currentExpectedReleaseDate: input.currentExpectedReleaseDate ?? input.baselineReleaseDate,
    actualReleaseDate: input.actualReleaseDate ?? null,
    completionStatus: input.completionStatus,
    ownerId: input.ownerId ?? null,
    revision: input.revision ?? null,
    remarks: input.remarks ?? null,
    fiscalYear: input.fiscalYear ?? null,
    quarter: input.quarter ?? null,
    sourceSheet: input.sourceSheet ?? null,
    updatedAt: new Date(),
  });
  return { id, created: true };
}

export interface DrawingInput {
  projectId: string;
  phaseId?: string | null;
  packageId?: string | null;
  disciplineId?: string | null;
  drawingCode: string;
  drawingNumber?: string | null;
  drawingName: string;
  areaOfWorks?: string | null;
  location?: string | null;
  stageCode?: string | null;
  batchCode?: string | null;
  batch?: string | null;
  issueType?: string | null;
  revision?: string | null;
  baselineReleaseDate?: Date | null;
  currentExpectedReleaseDate?: Date | null;
  actualReleaseDate?: Date | null;
  completionStatus: 'COMPLETED' | 'NOT_COMPLETED';
  remarks?: string | null;
  planPeriodLabel?: string | null;
}

export interface DrawingUpsertResult extends UpsertResult {
  /** Fields a user edited whose source value differs — kept, not overwritten. */
  protectedFields: { field: string; kept: unknown; source: unknown }[];
}

/**
 * Upsert a drawing from the Violet Hill plan workbook.
 *
 * Identity is project + drawing number (the same drawing re-issued in another
 * batch is the same drawing). A field a user has edited — listed in
 * `drawings.user_edited_fields` — is never overwritten; the caller logs each
 * one as FIELD_PROTECTED_USER_EDIT. The baseline is never touched on update.
 */
export async function upsertDrawing(input: DrawingInput): Promise<DrawingUpsertResult> {
  const [existing] = await db
    .select()
    .from(drawings)
    .where(and(eq(drawings.projectId, input.projectId), eq(drawings.drawingCode, input.drawingCode)))
    .limit(1);
  if (existing) {
    const edited = parseEditedFields(existing.userEditedFields);
    const proposed: Record<string, unknown> = {
      packageId: input.packageId ?? existing.packageId,
      disciplineId: input.disciplineId ?? existing.disciplineId,
      drawingName: input.drawingName,
      areaOfWorks: input.areaOfWorks ?? existing.areaOfWorks,
      location: input.location ?? existing.location,
      stageCode: input.stageCode ?? existing.stageCode,
      batchCode: input.batchCode ?? existing.batchCode,
      batch: input.batch ?? existing.batch,
      issueType: input.issueType ?? existing.issueType,
      revision: input.revision ?? existing.revision,
      // baseline preserved
      actualReleaseDate: input.actualReleaseDate ?? existing.actualReleaseDate,
      completionStatus: input.completionStatus,
      remarks: input.remarks ?? existing.remarks,
      planPeriodLabel: input.planPeriodLabel ?? existing.planPeriodLabel,
    };
    const patch: Record<string, unknown> = {};
    const protectedFields: DrawingUpsertResult['protectedFields'] = [];
    const same = (a: unknown, b: unknown) =>
      a instanceof Date || b instanceof Date
        ? (a instanceof Date ? a.getTime() : a) === (b instanceof Date ? b.getTime() : b)
        : (a ?? null) === (b ?? null);
    for (const [field, value] of Object.entries(proposed)) {
      const current = (existing as Record<string, unknown>)[field];
      if (edited.has(field)) {
        if (!same(current, value)) protectedFields.push({ field, kept: current, source: value });
        continue;
      }
      patch[field] = value;
    }
    await db
      .update(drawings)
      // "Updated On": the source's own date, never the time this import ran.
      .set({ ...patch, ...(input.actualReleaseDate ? sourceDating(input.actualReleaseDate, null) : {}), updatedAt: new Date() } as never)
      .where(eq(drawings.id, existing.id));
    return { id: existing.id, created: false, protectedFields };
  }
  const id = newId('dw_');
  await db.insert(drawings).values({
    id,
    projectId: input.projectId,
    phaseId: input.phaseId ?? null,
    packageId: input.packageId ?? null,
    disciplineId: input.disciplineId ?? null,
    drawingCode: input.drawingCode,
    drawingNumber: input.drawingNumber ?? null,
    drawingName: input.drawingName,
    areaOfWorks: input.areaOfWorks ?? null,
    location: input.location ?? null,
    stageCode: input.stageCode ?? null,
    batchCode: input.batchCode ?? '',
    batch: input.batch ?? null,
    issueType: input.issueType ?? null,
    revision: input.revision ?? null,
    baselineReleaseDate: input.baselineReleaseDate ?? null,
    currentExpectedReleaseDate: input.currentExpectedReleaseDate ?? input.baselineReleaseDate ?? null,
    actualReleaseDate: input.actualReleaseDate ?? null,
    completionStatus: input.completionStatus,
    remarks: input.remarks ?? null,
    planPeriodLabel: input.planPeriodLabel ?? null,
    ...sourceDating(input.actualReleaseDate, null),
    updatedAt: new Date(),
  });
  return { id, created: true, protectedFields: [] };
}

export async function upsertCriticalRequirement(projectId: string, phaseLabel: string | null, requirement: string) {
  const rows = await db.select().from(criticalRequirements).where(eq(criticalRequirements.projectId, projectId));
  const exists = rows.some(
    (r) => normaliseName(r.requirement) === normaliseName(requirement) && (r.phaseLabel ?? '') === (phaseLabel ?? ''),
  );
  if (exists) return;
  await db.insert(criticalRequirements).values({ id: newId('cr_'), projectId, phaseLabel, requirement });
}

export async function upsertDependency(row: {
  predecessorType: string;
  predecessorId: string;
  successorType: string;
  successorId: string;
  dependencyType?: string;
  lagDays?: number;
}) {
  const [existing] = await db
    .select()
    .from(dependencies)
    .where(
      and(
        eq(dependencies.predecessorType, row.predecessorType),
        eq(dependencies.predecessorId, row.predecessorId),
        eq(dependencies.successorType, row.successorType),
        eq(dependencies.successorId, row.successorId),
      ),
    )
    .limit(1);
  if (existing) return existing.id;
  const id = newId('dp_');
  await db.insert(dependencies).values({
    id,
    predecessorType: row.predecessorType,
    predecessorId: row.predecessorId,
    successorType: row.successorType,
    successorId: row.successorId,
    dependencyType: row.dependencyType ?? 'FS',
    lagDays: row.lagDays ?? 0,
    createdAt: new Date(),
  });
  return id;
}
