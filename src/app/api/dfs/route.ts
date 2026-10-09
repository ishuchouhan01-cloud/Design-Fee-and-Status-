import { billingEverywhere, billingFor, fail, ok, requireInScope, requirePermission, scopeOf, searchParams } from '@/lib/api';
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
 * Only the person's projects (lib/members can); billing only on rows of
 * projects where Billing is on. `showEmpty=1` is honoured in Edit Mode only.
 */
export async function GET(req: Request) {
  try {
    const ctx = await requirePermission(req, 'drawing.read');
    const sp = searchParams(req);
    const f = parseDfsFilters(sp);
    if (f.showEmpty && !(ctx.user.editMode && ctx.user.loginRole !== 'VIEWER')) delete f.showEmpty;
    const view = sp.get('view');
    const summary = view === 'periods' || view === 'summary';
    const scope = scopeOf(ctx, summary ? 'planning' : 'status');
    requireInScope(f.projectId, scope);
    f.scopeProjectIds = scope;
    // The Year / Quarter and DFS Summary views are billing: Billing on for every project in them.
    if (summary && !billingEverywhere(ctx, scope)) throw new ForbiddenError('billing.read', ctx.user.role);
    if (view === 'periods') return ok(await dfsPeriods(f, sp.get('basis') === 'FY' ? 'FY' : 'CY'));
    if (view === 'summary') return ok(await dfsSummary(f));
    const model = await buildDfsModel(f);
    const billing = billingFor(ctx);
    const parent = sp.get('parent') || null;
    const totals = billingEverywhere(ctx, scope) ? { ...modelTotals(model), billing: modelBilling(model) } : modelTotals(model);
    if (parent && !model.rows.has(parent)) return ok({ rows: [], totals });
    return ok({ rows: rowsOf(model, parent, parseLevel(sp.get('expand'))).map((r) => forRole(r, billing(r.projectId))), totals });
  } catch (e) {
    return fail(e);
  }
}
