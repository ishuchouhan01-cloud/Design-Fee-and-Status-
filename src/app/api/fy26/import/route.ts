import { fail, ok, requirePermission, searchParams } from '@/lib/api';
import { runFy26Import } from '@/lib/import/design-goals-fy26';
import { importIssueSummary, latestImportBatch, listImportIssues } from '@/lib/services/fy26';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requirePermission(req, 'fy26.read');
    const sp = searchParams(req);
    const batch = sp.get('batchId') ? { id: sp.get('batchId')! } : await latestImportBatch();
    if (!batch) return ok({ batch: null, issues: [], summary: [] });
    const [issues, summary] = await Promise.all([
      listImportIssues(batch.id, sp.get('severity') ?? undefined, sp.get('code') ?? undefined),
      importIssueSummary(batch.id),
    ]);
    return ok({ batch, issues, summary });
  } catch (e) {
    return fail(e);
  }
}

/**
 * Preview by default. Applying requires an explicit `confirm: true` in the body
 * as well as the `fy26.import` permission, so no request can write the
 * hierarchy by accident.
 */
export async function POST(req: Request) {
  try {
    const ctx = await requirePermission(req, 'fy26.import');
    const body = await req.json().catch(() => ({}));
    const apply = body?.confirm === true;
    const result = await runFy26Import({ apply, actor: ctx.actor });
    return ok(result);
  } catch (e) {
    return fail(e);
  }
}
