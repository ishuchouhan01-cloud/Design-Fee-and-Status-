/**
 * Audit trail. Every material change goes through here (spec §27).
 */
import { desc, eq, and, gte, lte, ilike, inArray, or, sql } from 'drizzle-orm';
import { db, type DbLike } from '@/db';
import { auditLog } from '@/db/schema';
import { newId } from './ids';
import type { AuditAction } from './domain';

export interface Actor {
  id: string | null;
  label: string;
}

export interface AuditEntryInput {
  actor: Actor;
  entityType: string;
  entityId: string;
  entityLabel?: string | null;
  action: AuditAction;
  field?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  reason?: string | null;
  projectId?: string | null;
}

function toRow(input: AuditEntryInput) {
  return {
    id: newId('au_'),
    userId: input.actor.id,
    userLabel: input.actor.label,
    entityType: input.entityType,
    entityId: input.entityId,
    entityLabel: input.entityLabel ?? null,
    action: input.action,
    field: input.field ?? null,
    oldValue: input.oldValue ?? null,
    newValue: input.newValue ?? null,
    reason: input.reason ?? null,
    projectId: input.projectId ?? null,
    timestamp: new Date(),
  };
}

/**
 * Write one audit row. Pass the transaction handle to make the audit entry part
 * of the same transaction as the change it describes — which is what keeps a
 * change and its audit record from ever diverging.
 */
export async function recordAudit(input: AuditEntryInput, tx: DbLike = db): Promise<void> {
  await tx.insert(auditLog).values(toRow(input));
}

export async function recordAuditMany(inputs: AuditEntryInput[], tx: DbLike = db): Promise<void> {
  if (inputs.length === 0) return;
  await tx.insert(auditLog).values(inputs.map(toRow));
}

export interface AuditQuery {
  entityType?: string;
  entityId?: string;
  action?: string;
  projectId?: string;
  search?: string;
  from?: Date;
  to?: Date;
  page?: number;
  pageSize?: number;
}

export async function queryAudit(q: AuditQuery) {
  const page = Math.max(1, q.page ?? 1);
  const pageSize = Math.min(200, Math.max(5, q.pageSize ?? 50));
  const conds = [];
  if (q.entityType) conds.push(eq(auditLog.entityType, q.entityType));
  if (q.entityId) conds.push(eq(auditLog.entityId, q.entityId));
  if (q.action) conds.push(eq(auditLog.action, q.action));
  if (q.projectId) conds.push(eq(auditLog.projectId, q.projectId));
  if (q.from) conds.push(gte(auditLog.timestamp, q.from));
  if (q.to) conds.push(lte(auditLog.timestamp, q.to));
  if (q.search) {
    const s = `%${q.search}%`;
    // ILIKE, not LIKE: PostgreSQL's LIKE is case-sensitive, and the search box
    // has always been case-insensitive.
    conds.push(or(ilike(auditLog.entityLabel, s), ilike(auditLog.userLabel, s), ilike(auditLog.reason, s)));
  }
  const where = conds.length ? and(...conds) : undefined;
  const [rows, counted] = await Promise.all([
    db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.timestamp))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(auditLog).where(where),
  ]);
  return { rows, total: Number(counted[0]?.n ?? 0), page, pageSize };
}

export async function auditForEntity(entityType: string, entityId: string, limit = 100) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, entityType), eq(auditLog.entityId, entityId)))
    .orderBy(desc(auditLog.timestamp))
    .limit(limit);
}

export async function auditActions(): Promise<string[]> {
  const rows = await db.selectDistinct({ action: auditLog.action }).from(auditLog);
  return rows.map((r) => r.action).sort();
}

export { inArray };
