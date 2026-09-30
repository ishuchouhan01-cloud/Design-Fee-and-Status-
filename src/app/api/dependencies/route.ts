import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { dependencies } from '@/db/schema';
import { fail, ok, requirePermission, searchParams } from '@/lib/api';
import { newId } from '@/lib/ids';
import { dependencySchema } from '@/lib/validation';
import { recordAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requirePermission(req, 'project.read');
    const sp = searchParams(req);
    const id = sp.get('entityId');
    const type = sp.get('entityType');
    if (!id || !type) return ok(await db.select().from(dependencies).limit(500));
    const rows = await db
      .select()
      .from(dependencies)
      .where(and(eq(dependencies.predecessorType, type), eq(dependencies.predecessorId, id)));
    const inbound = await db
      .select()
      .from(dependencies)
      .where(and(eq(dependencies.successorType, type), eq(dependencies.successorId, id)));
    return ok({ successors: rows, predecessors: inbound });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await requirePermission(req, 'schedule.reschedule');
    const input = dependencySchema.parse(await req.json());
    if (input.predecessorType === input.successorType && input.predecessorId === input.successorId) {
      throw new Error('An item cannot depend on itself.');
    }
    const id = newId('dp_');
    await db.insert(dependencies).values({ id, ...input, createdAt: new Date() });
    await recordAudit({
      actor: ctx.actor,
      entityType: 'DEPENDENCY',
      entityId: id,
      action: 'CREATE',
      newValue: JSON.stringify(input),
    });
    return ok({ id }, 201);
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(req: Request) {
  try {
    const ctx = await requirePermission(req, 'schedule.reschedule');
    const id = searchParams(req).get('id');
    if (!id) throw new Error('id is required');
    const [existing] = await db.select().from(dependencies).where(eq(dependencies.id, id)).limit(1);
    if (!existing) throw new Error('Dependency not found');
    await db.delete(dependencies).where(eq(dependencies.id, id));
    await recordAudit({
      actor: ctx.actor,
      entityType: 'DEPENDENCY',
      entityId: id,
      action: 'DELETE',
      oldValue: JSON.stringify(existing),
    });
    return ok({ deleted: id });
  } catch (e) {
    return fail(e);
  }
}
