import { fail, requirePermission, searchParams } from '@/lib/api';
import { parseFilters } from '@/lib/services/filters';
import { buildExport, type ExportFormat, type ExportKind } from '@/lib/services/export';
import { recordAudit } from '@/lib/audit';
import { parseDrawingFilters } from '@/lib/services/drawing-register';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const ctx = await requirePermission(req, 'export.run');
    const sp = searchParams(req);
    const kind = (sp.get('kind') ?? 'drawings') as ExportKind;
    const format = (sp.get('format') ?? 'xlsx') as ExportFormat;
    if (!['goals', 'deliverables', 'drawings'].includes(kind)) throw new Error('Unknown export kind');
    if (!['xlsx', 'csv'].includes(format)) throw new Error('Unknown export format');
    const drawingFilters = kind === 'drawings' ? parseDrawingFilters(sp) : undefined;
    const result = await buildExport(kind, format, parseFilters(sp), drawingFilters);
    await recordAudit({
      actor: ctx.actor,
      entityType: 'EXPORT',
      entityId: result.filename,
      action: 'EXPORT',
      newValue: `${result.rowCount} rows`,
      reason: `Snapshot export of ${kind}`,
    });
    return new Response(new Uint8Array(result.buffer), {
      headers: {
        'Content-Type': result.contentType,
        'Content-Disposition': `attachment; filename="${result.filename}"`,
        'X-Row-Count': String(result.rowCount),
      },
    });
  } catch (e) {
    return fail(e);
  }
}
