import { fail, ok, requirePermission, searchParams } from '@/lib/api';
import { userCan } from '@/lib/auth';
import { ForbiddenError } from '@/lib/rbac';
import { buildDfsModel, dfsPeriods, dfsSummary, forRole, modelBilling, modelTotals, parseDfsFilters, parseLevel, rowsOf } from '@/lib/services/dfs';

export const dynamic = 'force-dynamic';

/**
 * Design Fee Schedule (DFS), `drawing.read`:
 *   view=rows (default)  the rows under `parent` (the top rows without it);
 *                        `expand=<level>` (project · phase · tower · package ·
 *                        discipline · drawing; `packages` as before) returns
 *                        every row down to that level
 *   view=summary         packages and billing per project and discipline
 *   view=periods&basis=CY|FY  year / quarter spread
 * `showEmpty=1` (rows with no drawings) is honoured in Edit Mode only.
 */
export async function GET(req: Request) {
  try {
    const ctx = await requirePermission(req, 'drawing.read');
    // Billing only for roles that may see it (Admin, Super Admin).
    const billing = userCan(ctx.user, 'billing.read');
    const sp = searchParams(req);
    const f = parseDfsFilters(sp);
    if (f.showEmpty && !(ctx.user.editMode && ctx.user.loginRole !== 'VIEWER')) delete f.showEmpty;
    const view = sp.get('view');
    // The Year / Quarter and DFS Summary views carry billing.
    if ((view === 'periods' || view === 'summary') && !billing) throw new ForbiddenError('billing.read', ctx.user.role);
    if (view === 'periods') return ok(await dfsPeriods(f, sp.get('basis') === 'FY' ? 'FY' : 'CY'));
    if (view === 'summary') return ok(await dfsSummary(f));
    const model = await buildDfsModel(f);
    const parent = sp.get('parent') || null;
    const totals = billing ? { ...modelTotals(model), billing: modelBilling(model) } : modelTotals(model);
    if (parent && !model.rows.has(parent)) return ok({ rows: [], totals });
    return ok({ rows: rowsOf(model, parent, parseLevel(sp.get('expand'))).map((r) => forRole(r, billing)), totals });
  } catch (e) {
    return fail(e);
  }
}
