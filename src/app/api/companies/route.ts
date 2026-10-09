import { z } from 'zod';
import { context, fail, ok } from '@/lib/api';
import { adminCtx } from '@/lib/members/api-ctx';
import { listNamed, mergeNamed, saveNamed } from '@/lib/members/service';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await context(req);
    return ok({ rows: await listNamed('company') });
  } catch (e) {
    return fail(e);
  }
}

const schema = z.union([
  z.object({ mergeFrom: z.string().min(1), mergeInto: z.string().min(1) }),
  z.object({ id: z.string().nullish(), name: z.string().trim().min(1).max(200), trade: z.string().max(200).nullish() }),
]);

/** Add or rename a company, or merge two (Account Admin). */
export async function POST(req: Request) {
  try {
    const ctx = adminCtx(await context(req), req);
    const b = schema.parse(await req.json());
    if ('mergeFrom' in b) await mergeNamed(ctx, 'company', b.mergeFrom, b.mergeInto);
    else await saveNamed(ctx, 'company', b);
    return ok({ rows: await listNamed('company') });
  } catch (e) {
    return fail(e);
  }
}
