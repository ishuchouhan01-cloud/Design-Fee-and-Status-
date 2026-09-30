import { fail, requirePermission, searchParams } from '@/lib/api';
import { recordAudit } from '@/lib/audit';
import { userCan } from '@/lib/auth';
import { parseDfsFilters } from '@/lib/services/dfs';
import { buildDfsExport } from '@/lib/services/dfs-export';

export const dynamic = 'force-dynamic';

/** Project Drawing Status export of the filtered view — Excel or CSV (Admin and Super Admin). */
export async function GET(req: Request) {
  try {
    const ctx = await requirePermission(req, 'export.run');
    const sp = searchParams(req);
    const format = sp.get('format') === 'csv' ? 'csv' : 'xlsx';
    const result = await buildDfsExport(parseDfsFilters(sp), format, { billing: userCan(ctx.user, 'billing.read') });
    await recordAudit({ actor: ctx.actor, entityType: 'EXPORT', entityId: result.filename, action: 'EXPORT', newValue: `${result.rowCount} rows`, reason: 'Project Drawing Status export' });
    return new Response(new Uint8Array(result.buffer), {
      headers: { 'Content-Type': result.contentType, 'Content-Disposition': `attachment; filename="${result.filename}"`, 'X-Row-Count': String(result.rowCount) },
    });
  } catch (e) {
    return fail(e);
  }
}
