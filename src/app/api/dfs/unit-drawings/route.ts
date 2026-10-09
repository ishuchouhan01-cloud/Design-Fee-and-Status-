import { fail, ok, requirePermission, requireProject, searchParams } from '@/lib/api';
import { parseDfsFilters, parseUnitKey, unitDrawings } from '@/lib/services/dfs';
import { updatedOnText } from '@/lib/updated-on';

export const dynamic = 'force-dynamic';

/** The drawings of one discipline row of the DFS, a page at a time, with the page filters applied. */
export async function GET(req: Request) {
  try {
    const ctx = await requirePermission(req, 'drawing.read');
    const sp = searchParams(req);
    const key = sp.get('key');
    if (!key) throw new Error('A DFS row is required.');
    // The discipline row's project must be one of the person's.
    await requireProject(ctx, 'status', parseUnitKey(key)?.projectId);
    const f = parseDfsFilters(sp);
    const res = await unitDrawings(key, f, f.page ?? 1, Math.min(200, f.pageSize ?? 50));
    return ok({
      ...res,
      rows: res.rows.map((r) => ({
        id: r.id,
        drawingName: r.drawingName,
        drawingCode: r.drawingCode,
        numberStatus: r.numberStatus,
        partialNumber: r.partialNumber,
        revision: r.revision,
        disciplineId: r.disciplineId,
        disciplineCode: r.disciplineCode,
        disciplineName: r.disciplineName,
        projectId: r.projectId,
        packageId: r.packageId,
        responsible: r.responsibleName ?? r.responsibleText ?? null,
        expectedDate: r.currentExpectedReleaseDate,
        actualReleaseDate: r.actualReleaseDate,
        updatedOn: r.updatedOn,
        updatedOnText: updatedOnText(r),
        completionStatus: r.completionStatus,
      })),
    });
  } catch (e) {
    return fail(e);
  }
}
