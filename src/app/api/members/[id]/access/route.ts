import { z } from 'zod';
import { context, fail, ok, searchParams } from '@/lib/api';
import { adminCtx } from '@/lib/members/api-ctx';
import { MemberRuleError, removeFromProject, setAccess } from '@/lib/members/service';

export const dynamic = 'force-dynamic';

type P = { params: Promise<{ id: string }> };

const schema = z.object({
  projectId: z.string().min(1),
  level: z.enum(['project_admin', 'member']).optional(),
  switches: z.object({ billing: z.boolean().optional(), edit: z.boolean().optional(), importExport: z.boolean().optional(), planning: z.boolean().optional() }).optional(),
});

/** Access level and switches of a member on one project (added when missing). */
export async function POST(req: Request, { params }: P) {
  try {
    const ctx = adminCtx(await context(req), req);
    const b = schema.parse(await req.json());
    await setAccess(ctx, (await params).id, b.projectId, { level: b.level, switches: b.switches });
    return ok({ ok: true });
  } catch (e) {
    return fail(e);
  }
}

/** Remove from a project (?projectId=). */
export async function DELETE(req: Request, { params }: P) {
  try {
    const ctx = adminCtx(await context(req), req);
    const projectId = searchParams(req).get('projectId');
    if (!projectId) throw new MemberRuleError('Give the project.');
    await removeFromProject(ctx, (await params).id, projectId);
    return ok({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
