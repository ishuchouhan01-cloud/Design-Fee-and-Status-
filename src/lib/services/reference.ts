import { asc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { disciplines, packages, projectPhases, projects, users } from '@/db/schema';

export async function listProjects() {
  return db.select().from(projects).orderBy(asc(projects.projectName));
}

export async function listActiveProjects() {
  return db.select().from(projects).where(eq(projects.active, true)).orderBy(asc(projects.projectName));
}

export async function getProject(id: string) {
  const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  return row ?? null;
}

export async function listDisciplines() {
  return db.select().from(disciplines).orderBy(asc(disciplines.sortOrder), asc(disciplines.name));
}

export async function listDesignLeads() {
  return db.select().from(users).orderBy(asc(users.name));
}

export async function listPhases(projectId?: string) {
  const q = db.select().from(projectPhases);
  const rows = projectId ? await q.where(eq(projectPhases.projectId, projectId)) : await q;
  return rows.sort((a, b) => a.sequence - b.sequence || a.code.localeCompare(b.code));
}

export async function listPackages(projectId?: string) {
  const q = db.select().from(packages);
  const rows = projectId ? await q.where(eq(packages.projectId, projectId)) : await q;
  return rows.sort((a, b) => a.sequence - b.sequence || a.packageCode.localeCompare(b.packageCode));
}

export async function mapById<T extends { id: string }>(rows: T[]): Promise<Map<string, T>> {
  return new Map(rows.map((r) => [r.id, r]));
}

export async function usersByIds(ids: string[]) {
  const clean = [...new Set(ids.filter(Boolean))];
  if (clean.length === 0) return new Map<string, typeof users.$inferSelect>();
  const rows = await db.select().from(users).where(inArray(users.id, clean));
  return new Map(rows.map((r) => [r.id, r]));
}

export async function fiscalYears(): Promise<string[]> {
  const { goals } = await import('@/db/schema');
  const rows = await db.selectDistinct({ fy: goals.fiscalYear }).from(goals);
  return rows.map((r) => r.fy).sort().reverse();
}

export async function getSetting(key: string, fallback: string): Promise<string> {
  const { appSettings } = await import('@/db/schema');
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
  return row?.value ?? fallback;
}

export async function setSetting(key: string, value: string) {
  const { appSettings } = await import('@/db/schema');
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
  if (row) await db.update(appSettings).set({ value, updatedAt: new Date() }).where(eq(appSettings.key, key));
  else await db.insert(appSettings).values({ key, value, updatedAt: new Date() });
}
