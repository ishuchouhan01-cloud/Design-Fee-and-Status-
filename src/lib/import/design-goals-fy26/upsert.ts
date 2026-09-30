/**
 * Idempotent writes for the FY26 importer.
 *
 * Re-running the import updates rather than duplicates, and never overwrites a
 * field a user has edited: every write through the FY26 update service records
 * the field name in `userEditedFields`, and `applyIncoming` skips those.
 */
import { and, eq } from 'drizzle-orm';
import type { DbLike } from '@/db';
import {
  disciplines,
  fy26PackageDependencies,
  fy26Packages,
  fy26Phases,
  fy26Projects,
  users,
} from '@/db/schema';
import { codeify, newId, slug } from '@/lib/ids';
import { canonicalDisciplineCode } from '@/lib/seed';
import { hash6 } from '../upsert';
import type { ParsedDependency, ParsedPackage } from './read-sheet';

export interface UpsertCaches {
  disciplineByCode: Map<string, string>;
  userByName: Map<string, string>;
  projectByKey: Map<string, string>;
  phaseByKey: Map<string, string>;
}

export function newCaches(): UpsertCaches {
  return {
    disciplineByCode: new Map(),
    userByName: new Map(),
    projectByKey: new Map(),
    phaseByKey: new Map(),
  };
}

export function packageNaturalKey(pkg: ParsedPackage): string {
  return hash6(
    codeify(pkg.projectName),
    pkg.phaseName ? codeify(pkg.phaseName) : '-',
    pkg.disciplineLabel ?? '-',
    pkg.sourceScopeLabel,
    pkg.packageDescription,
    pkg.occurrence,
  );
}

/**
 * Number each package within its (project, phase, discipline, scope,
 * description) group, in the order the workbooks were read. Without this, the
 * eight source rows that repeat a description under one package group collapse
 * into one record.
 */
export function assignOccurrences(packages: ParsedPackage[]): void {
  const seen = new Map<string, number>();
  for (const pkg of packages) {
    const base = [
      codeify(pkg.projectName),
      pkg.phaseName ? codeify(pkg.phaseName) : '-',
      pkg.disciplineLabel ?? '-',
      pkg.sourceScopeLabel,
      pkg.packageDescription,
    ].join('|');
    const next = seen.get(base) ?? 0;
    pkg.occurrence = next;
    seen.set(base, next + 1);
  }
}

/**
 * The within-package sequence is part of the key because ten source rows share
 * a description with a sibling under the same package (two `Step` rows both
 * reading "Tree Avenue details", for instance). Without it they collapse.
 */
export function dependencyNaturalKey(dep: ParsedDependency): string {
  return hash6(dep.stepLabel ?? '-', dep.description, dep.sequence);
}

export async function disciplineIdFor(tx: DbLike, raw: string | null, cache: UpsertCaches): Promise<string | null> {
  const code = canonicalDisciplineCode(raw);
  if (!code) return null;
  const hit = cache.disciplineByCode.get(code);
  if (hit) return hit;
  const [row] = await tx.select({ id: disciplines.id }).from(disciplines).where(eq(disciplines.code, code)).limit(1);
  if (!row) return null;
  cache.disciplineByCode.set(code, row.id);
  return row.id;
}

/**
 * Resolve a package's `Responsible` cell to a user. Package-level values name
 * one person; dependency-level values name several and are kept as free text
 * instead (see `fy26_package_dependencies.responsible_text`).
 */
export async function userIdFor(tx: DbLike, raw: string | null, cache: UpsertCaches): Promise<string | null> {
  if (!raw) return null;
  const key = slug(raw);
  if (cache.userByName.has(key)) return cache.userByName.get(key) ?? null;
  const rows = await tx.select({ id: users.id, name: users.name }).from(users);
  for (const r of rows) cache.userByName.set(slug(r.name), r.id);
  return cache.userByName.get(key) ?? null;
}

export async function upsertProject(
  tx: DbLike,
  params: { projectName: string; legacyProjectId: string | null; projectCode: string | null },
  cache: UpsertCaches,
): Promise<string> {
  const projectKey = codeify(params.projectName);
  const cached = cache.projectByKey.get(projectKey);
  if (cached) return cached;

  const [existing] = await tx
    .select({ id: fy26Projects.id })
    .from(fy26Projects)
    .where(eq(fy26Projects.projectKey, projectKey))
    .limit(1);

  if (existing) {
    await tx
      .update(fy26Projects)
      .set({
        projectName: params.projectName,
        legacyProjectId: params.legacyProjectId,
        projectCode: params.projectCode,
        updatedAt: new Date(),
      })
      .where(eq(fy26Projects.id, existing.id));
    cache.projectByKey.set(projectKey, existing.id);
    return existing.id;
  }

  const id = newId('fp_');
  await tx.insert(fy26Projects).values({
    id,
    projectKey,
    projectName: params.projectName,
    projectCode: params.projectCode,
    legacyProjectId: params.legacyProjectId,
  });
  cache.projectByKey.set(projectKey, id);
  return id;
}

export async function upsertPhase(
  tx: DbLike,
  params: {
    fy26ProjectId: string;
    phaseName: string;
    sourceLabel: string;
    legacyProjectId: string | null;
    sequence: number;
  },
  cache: UpsertCaches,
): Promise<string> {
  const phaseKey = codeify(params.phaseName);
  const cacheKey = `${params.fy26ProjectId}|${phaseKey}`;
  const cached = cache.phaseByKey.get(cacheKey);
  if (cached) return cached;

  const [existing] = await tx
    .select({ id: fy26Phases.id })
    .from(fy26Phases)
    .where(and(eq(fy26Phases.fy26ProjectId, params.fy26ProjectId), eq(fy26Phases.phaseKey, phaseKey)))
    .limit(1);

  if (existing) {
    await tx
      .update(fy26Phases)
      .set({
        phaseName: params.phaseName,
        sourceLabel: params.sourceLabel,
        legacyProjectId: params.legacyProjectId,
        updatedAt: new Date(),
      })
      .where(eq(fy26Phases.id, existing.id));
    cache.phaseByKey.set(cacheKey, existing.id);
    return existing.id;
  }

  const id = newId('fph_');
  await tx.insert(fy26Phases).values({
    id,
    fy26ProjectId: params.fy26ProjectId,
    phaseKey,
    phaseName: params.phaseName,
    sourceLabel: params.sourceLabel,
    legacyProjectId: params.legacyProjectId,
    sequence: params.sequence,
  });
  cache.phaseByKey.set(cacheKey, id);
  return id;
}

export function parseEditedFields(value: string | null | undefined): Set<string> {
  if (!value) return new Set();
  return new Set(
    value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  );
}

export interface ProtectedField {
  field: string;
  excelValue: unknown;
  keptValue: unknown;
}

/**
 * Build the patch for an existing row, dropping every field the user has
 * edited. The dropped fields are returned so the import report can show
 * exactly what it declined to overwrite.
 */
export function applyIncoming<T extends Record<string, unknown>>(
  existing: Record<string, unknown>,
  incoming: T,
  editedFields: Set<string>,
): { patch: Partial<T>; protectedFields: ProtectedField[] } {
  const patch: Record<string, unknown> = {};
  const protectedFields: ProtectedField[] = [];
  for (const [field, value] of Object.entries(incoming)) {
    if (editedFields.has(field)) {
      protectedFields.push({ field, excelValue: value, keptValue: existing[field] });
      continue;
    }
    patch[field] = value;
  }
  return { patch: patch as Partial<T>, protectedFields };
}

export const PACKAGE_TABLE = fy26Packages;
export const DEPENDENCY_TABLE = fy26PackageDependencies;
