/**
 * Reference data seeding. Idempotent — matched on natural keys.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { appSettings, disciplines, users } from '@/db/schema';
import { newId } from './ids';
import type { Role } from './domain';

export const DISCIPLINE_SEED: { code: string; name: string; category: string; sortOrder: number; dfsGroup?: string }[] = [
  { code: 'AR', name: 'Architecture', category: 'DESIGN', sortOrder: 10 },
  { code: 'ST', name: 'Structural', category: 'DESIGN', sortOrder: 20 },
  { code: 'MEP', name: 'Mechanical, Electrical & Plumbing', category: 'DESIGN', sortOrder: 30 },
  { code: 'LS', name: 'Landscape', category: 'DESIGN', sortOrder: 40 },
  { code: 'ID', name: 'Interior Design', category: 'DESIGN', sortOrder: 50 },
  // Master planning / urban design drawings are billed under the Architecture fee.
  { code: 'MP', name: 'Master Planning', category: 'DESIGN', sortOrder: 5, dfsGroup: 'AR' },
  { code: 'INFRA', name: 'Infrastructure Consultants', category: 'INFRA', sortOrder: 60 },
  // Building services sub-disciplines are billed under the MEP fee.
  { code: 'PHE', name: 'Public Health Engineering', category: 'INFRA', sortOrder: 70, dfsGroup: 'MEP' },
  { code: 'ELE', name: 'Electrical', category: 'INFRA', sortOrder: 80, dfsGroup: 'MEP' },
  { code: 'IBMS', name: 'Integrated Building Management System', category: 'INFRA', sortOrder: 90, dfsGroup: 'MEP' },
  { code: 'UD', name: 'Urban Design', category: 'DESIGN', sortOrder: 15, dfsGroup: 'AR' },
];

/** Aliases seen across the workbooks, mapped onto the canonical discipline. */
export const DISCIPLINE_ALIASES: Record<string, string> = {
  ARCHITECTURE: 'AR',
  ARCHITECTURAL: 'AR',
  AR: 'AR',
  STRUCTURAL: 'ST',
  STRUCTURE: 'ST',
  STRUCTURES: 'ST',
  STR: 'ST',
  ST: 'ST',
  S: 'ST',
  MEP: 'MEP',
  LANDSCAPE: 'LS',
  LANDSCAPING: 'LS',
  LDS: 'LS',
  LS: 'LS',
  'INTERIOR DESIGN': 'ID',
  INTERIORS: 'ID',
  ID: 'ID',
  'MASTER PLANNING': 'MP',
  'MASTER PLAN': 'MP',
  MP: 'MP',
  'INFRA CONSULTANTS': 'INFRA',
  INFRA: 'INFRA',
  PHE: 'PHE',
  ELE: 'ELE',
  ELECTRICAL: 'ELE',
  IBMS: 'IBMS',
  UD: 'UD',
};

const USER_SEED: { name: string; email: string; role: Role }[] = [
  { name: 'Administrator', email: 'admin@company.local', role: 'ADMIN' },
];

const SETTING_SEED: Record<string, string> = {
  'app.name': 'Design Goals & Delivery Control System',
  'app.currentFiscalYear': 'FY26-27',
  'app.currentQuarter': '2',
  'app.sourceOfTruth': 'DATABASE',
};

export async function seedReferenceData() {
  let disciplineCount = 0;
  for (const d of DISCIPLINE_SEED) {
    const [existing] = await db.select().from(disciplines).where(eq(disciplines.code, d.code)).limit(1);
    if (existing) {
      await db
        .update(disciplines)
        // The fee group is data an Admin may change: seeded once, never overwritten.
        .set({ name: d.name, category: d.category, sortOrder: d.sortOrder, ...(existing.dfsGroup == null && d.dfsGroup ? { dfsGroup: d.dfsGroup } : {}) })
        .where(eq(disciplines.id, existing.id));
    } else {
      await db.insert(disciplines).values({ id: newId('dc_'), active: true, ...d, dfsGroup: d.dfsGroup ?? null });
    }
    disciplineCount += 1;
  }

  let userCount = 0;
  for (const u of USER_SEED) {
    const [existing] = await db.select().from(users).where(eq(users.email, u.email)).limit(1);
    if (!existing) {
      await db.insert(users).values({ id: newId('us_'), ...u, active: true, updatedAt: new Date() });
    }
    userCount += 1;
  }

  let settingCount = 0;
  for (const [key, value] of Object.entries(SETTING_SEED)) {
    const [existing] = await db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
    if (existing) {
      // keep operator-changed values
    } else {
      await db.insert(appSettings).values({ key, value, updatedAt: new Date() });
    }
    settingCount += 1;
  }

  return { disciplines: disciplineCount, users: userCount, settings: settingCount };
}

export function canonicalDisciplineCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = raw.trim().toUpperCase().replace(/\s+/g, ' ');
  return DISCIPLINE_ALIASES[key] ?? null;
}
