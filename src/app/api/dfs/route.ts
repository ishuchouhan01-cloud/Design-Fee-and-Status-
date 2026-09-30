import { fail, ok, requirePermission, searchParams } from '@/lib/api';
import { userCan } from '@/lib/auth';
import { ForbiddenError } from '@/lib/rbac';
import { buildDfsModel, dfsPeriods, dfsSummary, forRole, modelBilling, modelTotals, parseDfsFilters, rowsOf } from '@/lib/services/dfs';

export const dynamic = 'force-dynamic';

/**
 * Design Fee Schedule (DFS), `drawing.read`:
 *   view=rows (default)  the rows under `parent` (the top rows without it);
 *                        `expand=packages` returns every row down to packages
 *   view=summary         packages and billing per project and discipline
 *   view=periods&basis=CY|FY  year / quarter spread
 */
export async function GET(req: Request) {
  try {
    const ctx = await requirePermission(req, 'drawing.read');
    // Billing only for roles that may see it (Admin, Super Admin).
    const billing = userCan(ctx.user, 'billing.read');
    const sp = searchParams(req);
    const f = parseDfsFilters(sp);
    const view = sp.get('view');
    // The Year / Quarter and DFS Summary views carry billing.
    if ((view === 'periods' || view === 'summary') && !billing) throw new ForbiddenError('billing.read', ctx.user.role);
    if (view === 'periods') return ok(await dfsPeriods(f, sp.get('basis') === 'FY' ? 'FY' : 'CY'));
    if (view === 'summary') return ok(await dfsSummary(f));
    const model = await buildDfsModel(f);
    const parent = sp.get('parent') || null;
    const totals = billing ? { ...modelTotals(model), billing: modelBilling(model) } : modelTotals(model);
    if (parent && !model.rows.has(parent)) return ok({ rows: [], totals });
    return ok({ rows: rowsOf(model, parent, sp.get('expand') === 'packages' ? 'PACKAGE' : undefined).map((r) => forRole(r, billing)), totals });
  } catch (e) {
    return fail(e);
  }
}
