import { context, fail, searchParams } from '@/lib/api';
import { recordAudit } from '@/lib/audit';
import { adminCtx } from '@/lib/members/api-ctx';
import { exportMembers } from '@/lib/members/service';

export const dynamic = 'force-dynamic';

/** Export the filtered Members view as Excel. */
export async function GET(req: Request) {
  try {
    const ctx = adminCtx(await context(req), req);
    const sp = searchParams(req);
    const buf = await exportMembers(ctx, {
      projectId: sp.get('projectId') || null,
      search: sp.get('search') ?? undefined,
      companyId: sp.get('companyId') ?? undefined,
      roleId: sp.get('roleId') ?? undefined,
      level: sp.get('level') ?? undefined,
      status: sp.get('status') ?? undefined,
      switch: sp.get('switch') ?? undefined,
    });
    await recordAudit({ actor: ctx.actor, entityType: 'EXPORT', entityId: 'members', action: 'EXPORT', reason: 'Members export', projectId: sp.get('projectId') || null });
    return new Response(new Uint8Array(buf), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="members-${new Date().toISOString().slice(0, 10)}.xlsx"`,
      },
    });
  } catch (e) {
    return fail(e);
  }
}
