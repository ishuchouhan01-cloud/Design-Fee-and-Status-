import { billingEverywhere, billingFor, fail, requireInScope, requirePermission, scopeOf, searchParams } from '@/lib/api';
import { recordAudit } from '@/lib/audit';
import { userCan } from '@/lib/auth';
import { parseDfsFilters } from '@/lib/services/dfs';
import { buildDfsExport } from '@/lib/services/dfs-export';

export const dynamic = 'force-dynamic';

/** Project Drawing Status export of the filtered view — Excel or CSV: the person's projects with Import / Export; billing only where Billing is on. */
export async function GET(req: Request) {
  try {
    const ctx = await requirePermission(req, 'export.run');
    const sp = searchParams(req);
    const format = sp.get('format') === 'csv' ? 'csv' : 'xlsx';
    const f = parseDfsFilters(sp);
    // The export follows the screen: empty rows only when Edit Mode shows them.
    if (f.showEmpty && !(ctx.user.editMode && ctx.user.loginRole !== 'VIEWER')) delete f.showEmpty;
    const scope = scopeOf(ctx, 'importExport');
    requireInScope(f.projectId, scope);
    f.scopeProjectIds = scope;
    const result = await buildDfsExport(f, format, { billing: userCan(ctx.user, 'billing.read'), rowBilling: billingFor(ctx), billingAll: billingEverywhere(ctx, scope) });
    await recordAudit({ actor: ctx.actor, entityType: 'EXPORT', entityId: result.filename, action: 'EXPORT', newValue: `${result.rowCount} rows`, reason: 'Project Drawing Status export' });
    return new Response(new Uint8Array(result.buffer), {
      headers: { 'Content-Type': result.contentType, 'Content-Disposition': `attachment; filename="${result.filename}"`, 'X-Row-Count': String(result.rowCount) },
    });
  } catch (e) {
    return fail(e);
  }
}
