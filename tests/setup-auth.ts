/**
 * Test identities. The application has one way in — the sign-in screen and
 * its session cookie (lib/auth). The older suites call route handlers as a
 * named user (header x-user-email); here, in tests only, that header picks
 * the user, with the full sign-in role so only the existing permission checks
 * apply. A request with a session cookie always goes through the real sign-in
 * path (tests/pds-*.test.ts).
 */
import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { vi } from 'vitest';
import * as XLSX from 'xlsx';

// SheetJS 0.20 as an ES module writes files (XLSX.writeFile, used by the fixtures) only once given fs.
XLSX.set_fs(fs);

process.env.SESSION_SECRET ??= randomBytes(32).toString('hex');

vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...real,
    async getCurrentUser(headers?: Headers) {
      const email = headers?.get('x-user-email')?.trim().toLowerCase();
      if (!email || headers?.get('cookie')) return real.getCurrentUser(headers);
      const { db } = await import('@/db');
      const { users } = await import('@/db/schema');
      const { eq } = await import('drizzle-orm');
      const { newId } = await import('@/lib/ids');
      let [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      if (!u) {
        const isDefault = email === 'admin@company.local';
        const row = { id: newId('us_'), name: isDefault ? 'Administrator' : email.split('@')[0], email, role: isDefault ? 'ADMIN' : 'VIEWER', active: true, updatedAt: new Date() };
        await db.insert(users).values(row);
        u = { ...row, createdAt: new Date() };
      }
      const { legacyPrincipal } = await import('@/lib/members/principal');
      return { id: u.id, name: u.name, email: u.email, role: u.role as 'ADMIN' | 'MANAGER' | 'EDITOR' | 'VIEWER', loginRole: 'SUPER_ADMIN' as const, sessionId: null, editMode: false, extraPermissions: [], principal: legacyPrincipal('SUPER_ADMIN'), member: null, emergency: false };
    },
  };
});
