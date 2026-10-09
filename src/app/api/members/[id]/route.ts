import { z } from 'zod';
import { context, fail, ok } from '@/lib/api';
import { adminCtx } from '@/lib/members/api-ctx';
import { memberDetail, setAccountAdmin, updateProfile } from '@/lib/members/service';

export const dynamic = 'force-dynamic';

type P = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: P) {
  try {
    const ctx = adminCtx(await context(req), req);
    return ok(await memberDetail(ctx, (await params).id));
  } catch (e) {
    return fail(e);
  }
}

const schema = z.object({
  name: z.string().max(200).optional(),
  email: z.string().max(254).optional(),
  phone: z.string().max(60).nullish(),
  company: z.string().max(200).nullish(),
  role: z.string().max(200).nullish(),
  accountAdmin: z.boolean().optional(),
});

/** Profile (name, email before the first sign-in, phone, company, role) and — Account Admin only — Account Admin on / off. */
export async function PATCH(req: Request, { params }: P) {
  try {
    const ctx = adminCtx(await context(req), req);
    const id = (await params).id;
    const { accountAdmin, ...profile } = schema.parse(await req.json());
    if (Object.keys(profile).length) await updateProfile(ctx, id, profile);
    if (accountAdmin !== undefined) await setAccountAdmin(ctx, id, accountAdmin);
    return ok({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
