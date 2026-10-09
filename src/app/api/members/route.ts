import { z } from 'zod';
import { context, fail, ok, searchParams } from '@/lib/api';
import { adminCtx } from '@/lib/members/api-ctx';
import { addMember, listMembers, managedProjects } from '@/lib/members/service';

export const dynamic = 'force-dynamic';

/** The Members table: one project (Project Admin, Account Admin) or "All projects" (Account Admin). */
export async function GET(req: Request) {
  try {
    const ctx = adminCtx(await context(req), req);
    const sp = searchParams(req);
    const list = await listMembers(ctx, {
      projectId: sp.get('projectId') || null,
      search: sp.get('search') ?? undefined,
      companyId: sp.get('companyId') ?? undefined,
      roleId: sp.get('roleId') ?? undefined,
      level: sp.get('level') ?? undefined,
      status: sp.get('status') ?? undefined,
      switch: sp.get('switch') ?? undefined,
      page: Number(sp.get('page') ?? 1),
      pageSize: Number(sp.get('pageSize') ?? 20),
    });
    return ok({ ...list, projects: await managedProjects(ctx) });
  } catch (e) {
    return fail(e);
  }
}

const sw = z.object({ billing: z.boolean().optional(), edit: z.boolean().optional(), importExport: z.boolean().optional(), planning: z.boolean().optional() });
const schema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().min(3).max(320),
  phone: z.string().max(60).nullish(),
  company: z.string().max(200).nullish(),
  role: z.string().max(200).nullish(),
  projectId: z.string().nullish(),
  level: z.enum(['project_admin', 'member']).optional(),
  switches: sw.optional(),
  accountAdmin: z.boolean().optional(),
});

/** Add one member; a new member gets a one-time invite link (shown once). */
export async function POST(req: Request) {
  try {
    const ctx = adminCtx(await context(req), req);
    return ok(await addMember(ctx, schema.parse(await req.json())));
  } catch (e) {
    return fail(e);
  }
}
