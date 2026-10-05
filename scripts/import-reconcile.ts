/**
 * Reconcile imported projects against their source workbooks:
 *
 *   npm run import:reconcile -- data/drawing-sources/dfs-2026-import.json [--out import-reports/name]
 *
 * Per entry of the import list (see scripts/import-centre-run.ts):
 *   Excel      package rows of the Design Fee sheet used (counted directly on
 *              the sheet), drawings and released drawings of the drawing
 *              lists, and the sheet's own Total / Billed (its "Design Fee"
 *              row at the top)
 *   database   packages, drawings, released, drawings linked to a package,
 *              the stored fees (Total, Billed, Released till date)
 *   screen     Project Drawing Status as shown: packages counted, Total /
 *              Billed / Unbilled, and what the billing rule left out
 *
 *   Excel total = fees on packages + fees outside packages (design stages,
 *   archives, repeated codes);  stored = shown + left out.
 * Also checks, on the whole view: every parent = sum of its children, and the
 * header = sum of the top rows. Nothing is written to the database.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, isNull, sql } from 'drizzle-orm';

const r4 = (v: number) => Math.round(v * 10000) / 10000;
const n = (v: number) => v.toLocaleString('en-IN');

async function main() {
  const args = process.argv.slice(2);
  const listPath = args.find((a) => !a.startsWith('--'));
  if (!listPath) throw new Error('Give the import list (JSON).');
  const outAt = args.indexOf('--out');
  const out = outAt >= 0 ? args[outAt + 1] : null;
  const list = JSON.parse(fs.readFileSync(listPath, 'utf8')) as { folder: string; imports: { file: string; project?: string; newProject?: { shortCode?: string } }[] };
  const { db, closeDb } = await import('../src/db');
  const { drawings, packageFees, packages, projects } = await import('../src/db/schema');
  const { centreManifest } = await import('../src/lib/import/centre-manifest');
  const { PACKAGE_FEE_LINE, packageLineCode } = await import('../src/lib/import/drawing-register/design-fee');
  const { parseSources } = await import('../src/lib/import/drawing-register/parse');
  const { buildPlan } = await import('../src/lib/import/drawing-register/plan');
  const { at, readTextWorkbook } = await import('../src/lib/import/drawing-register/read');
  const { buildDfsModel, modelBilling, modelTotals } = await import('../src/lib/services/dfs');
  const { projectLabel } = await import('../src/lib/labels');

  const rows: Record<string, string | number>[] = [];
  const checks: string[] = [];
  const ok = (cond: boolean, what: string) => {
    checks.push(`${cond ? 'OK  ' : 'FAIL'} ${what}`);
    return cond;
  };
  try {
    for (const e of list.imports) {
      const code = e.project ?? e.newProject?.shortCode?.toUpperCase() ?? '';
      const [p] = await db.select().from(projects).where(eq(projects.projectCode, code)).limit(1);
      if (!p) {
        ok(false, `${e.file}: project ${code} not found`);
        continue;
      }
      // ---- Excel
      const file = path.join(list.folder, e.file);
      const sheets = readTextWorkbook(file);
      const manifest = centreManifest({ fileName: path.basename(file), fileType: 'PLAN', sheets, mapping: null, code: 'X', name: 'X' });
      const plan = buildPlan(manifest, parseSources(manifest, path.dirname(file)));
      const feeSpec = manifest.designFees[0];
      const fs1 = sheets.find((s) => s.name === feeSpec?.sheet);
      // Package rows counted directly on the sheet: a hyphenated package code (any department prefix) in the first columns.
      const codes: string[] = [];
      for (const row of fs1?.rows ?? []) {
        const c = [1, 2, 0].map((i) => packageLineCode(at(row, i))).find((x) => x && x.code.includes('-'));
        if (c) codes.push(c.code);
      }
      const fee = plan.counts.fees.X;
      const excelTotal = fee?.sheetTotal[PACKAGE_FEE_LINE] ?? Object.values(fee?.sheetTotal ?? {}).reduce((a, b) => a + b, 0);
      const excelBilled = fee?.sheetBilled?.[PACKAGE_FEE_LINE] ?? null;
      const onPackages = Object.values(fee?.packageFees ?? {}).reduce((a, b) => a + b, 0);
      const outside = Object.values(fee?.feesOutsidePackages ?? {}).reduce((a, b) => a + b, 0) + Object.values(fee?.duplicateFees ?? {}).reduce((a, b) => a + b, 0);
      const billedOnPackages = fee?.packageBilled?.[PACKAGE_FEE_LINE] ?? null;
      // ---- database
      const live = and(eq(drawings.projectId, p.id), isNull(drawings.archivedAt));
      const [dc] = await db
        .select({
          drawings: sql<number>`count(*)::int`,
          released: sql<number>`(count(*) filter (where ${drawings.completionStatus} = 'COMPLETED'))::int`,
          linked: sql<number>`(count(*) filter (where ${drawings.packageId} is not null))::int`,
        })
        .from(drawings)
        .where(live);
      const [pc] = await db
        .select({
          packages: sql<number>`count(*)::int`,
          fee: sql<number>`coalesce(sum(${packages.feeValue}), 0)::float8`,
          billed: sql<number>`coalesce(sum(${packages.billedToDateValue}), 0)::float8`,
          released: sql<number>`coalesce(sum(${packages.releasedToDateValue}), 0)::float8`,
        })
        .from(packages)
        .where(and(eq(packages.projectId, p.id), isNull(packages.archivedAt)));
      const [lc] = await db
        .select({ fee: sql<number>`coalesce(sum(${packageFees.feeValue}), 0)::float8`, billed: sql<number>`coalesce(sum(${packageFees.billedToDateValue}), 0)::float8` })
        .from(packageFees)
        .innerJoin(packages, eq(packageFees.packageId, packages.id))
        .where(and(eq(packages.projectId, p.id), isNull(packages.archivedAt)));
      const storedTotal = r4(pc.fee + lc.fee);
      const storedBilled = r4(pc.billed + lc.billed);
      // ---- screen
      const m = await buildDfsModel({ projectId: p.id });
      const top = m.rows.get(`P:${p.id}`);
      const shown = top?.billing ?? { total: 0, billed: 0, unbilled: 0 };
      const name = projectLabel(p);
      const distinct = new Set(codes).size;
      rows.push({
        Project: name,
        Workbook: path.basename(e.file),
        'Fee sheet': `${feeSpec?.sheet ?? '—'} (${fee?.layout ?? '—'})`,
        'Package rows (Excel)': `${codes.length}${distinct !== codes.length ? ` (${distinct} distinct)` : ''}`,
        'Packages (DB)': pc.packages,
        'Packages shown': top?.packagesTotal ?? 0,
        'Drawings (Excel)': plan.drawings.length,
        'Drawings (DB)': dc.drawings,
        'Released (Excel)': plan.drawings.filter((d) => d.released).length,
        'Released (DB)': dc.released,
        'Linked (DB)': `${n(dc.linked)} (${dc.drawings ? Math.round((dc.linked / dc.drawings) * 1000) / 10 : 0} %)`,
        'Total Excel': r4(excelTotal),
        'on packages': r4(onPackages),
        'outside packages': r4(outside),
        'Total stored': storedTotal,
        'Total shown': shown.total,
        'Total left out': r4(storedTotal - shown.total),
        'Billed Excel': excelBilled == null ? '—' : r4(excelBilled),
        'Billed on packages (Excel)': billedOnPackages == null ? '—' : r4(billedOnPackages),
        'Billed stored': storedBilled,
        'Billed shown': shown.billed,
        'Released till date (stored)': r4(pc.released),
      });
      ok(pc.packages === distinct, `${name}: packages in the database (${pc.packages}) = package codes of the fee sheet (${distinct})`);
      ok(dc.drawings === plan.drawings.length, `${name}: drawings ${dc.drawings} = drawing lists ${plan.drawings.length}`);
      ok(dc.released === plan.drawings.filter((d) => d.released).length, `${name}: released ${dc.released} = drawing lists`);
      ok(Math.abs(onPackages + outside - excelTotal) < 0.0005, `${name}: Excel total ${r4(excelTotal)} = on packages ${r4(onPackages)} + outside packages ${r4(outside)}`);
      ok(Math.abs(storedTotal - onPackages) < 0.0005, `${name}: stored total ${storedTotal} = fees on the sheet's packages ${r4(onPackages)}`);
      if (billedOnPackages != null) ok(Math.abs(storedBilled - billedOnPackages) < 0.0005, `${name}: stored billed ${storedBilled} = billed on the sheet's packages ${r4(billedOnPackages)}`);
      const left = m.excluded.noRelease;
      ok(Math.abs(m.source.total - (shown.total + left.total + m.excluded.notApplicable.total)) < 0.00005, `${name}: stored (rounded per line) ${m.source.total} = shown ${shown.total} + left out ${r4(left.total + m.excluded.notApplicable.total)}`);
    }
    // ---- the whole view
    const all = await buildDfsModel({});
    let bad = 0;
    for (const [k, r] of all.rows) {
      const c = (all.children.get(k) ?? []).map((x) => all.rows.get(x)!);
      if (!c.length || r.kind === 'DISCIPLINE') continue;
      const sub = r.kind === 'PACKAGE' || r.kind === 'NO_PACKAGE' ? c : c.filter((x) => x.kind !== 'DISCIPLINE' || r.kind === 'PROJECT');
      if (r.drawingsTotal !== sub.reduce((a, x) => a + x.drawingsTotal, 0)) bad++;
      if (r.kind !== 'PACKAGE' && r.kind !== 'NO_PACKAGE') {
        if (r.packagesTotal !== c.reduce((a, x) => a + x.packagesTotal, 0)) bad++;
        if (Math.abs((r.billing?.total ?? 0) - c.reduce((a, x) => a + (x.billing?.total ?? 0), 0)) > 1e-6) bad++;
      }
    }
    ok(bad === 0, `every parent = the sum of its children (${all.rows.size} rows)`);
    const t = modelTotals(all);
    const b = modelBilling(all);
    const roots = all.roots.map((k) => all.rows.get(k)!);
    ok(t.packagesTotal === roots.reduce((a, r) => a + r.packagesTotal, 0) && Math.abs((b?.total ?? 0) - roots.reduce((a, r) => a + (r.billing?.total ?? 0), 0)) < 1e-6, `header = sum of the top rows: ${t.packagesComplete} of ${t.packagesTotal} packages complete, ${n(t.drawingsReleased)} of ${n(t.drawingsTotal)} drawings released, Total ₹ ${b?.total ?? 0} Cr, Billed ₹ ${b?.billed ?? 0} Cr`);
    const cols = Object.keys(rows[0] ?? {});
    const md = [
      `Reconciliation — ${new Date().toISOString()}`,
      '',
      `| ${cols.join(' | ')} |`,
      `|${cols.map(() => '---').join('|')}|`,
      ...rows.map((r) => `| ${cols.map((c) => String(r[c])).join(' | ')} |`),
      '',
      ...checks,
    ].join('\n');
    console.log(md);
    if (out) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(`${out}.md`, md);
      fs.writeFileSync(`${out}.json`, JSON.stringify({ rows, checks }, null, 2));
    }
  } finally {
    await closeDb();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
