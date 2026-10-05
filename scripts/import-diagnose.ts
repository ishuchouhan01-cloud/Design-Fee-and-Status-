/**
 * Dry-run diagnostic of the drawing-register importer (nothing is written).
 *
 *   npm run import:diagnose -- [folder] [--out import-reports/name] [--json]
 *
 * Reads every .xlsx under the folder (default ./import/dfs-2026) with the same
 * code the Import Centre uses (manifest → parse → plan) and prints, per
 * workbook: the Design Fee sheet used (and the others), the layout detected,
 * the headings, packages, drawings, drawings linked to a package by rule,
 * the batches that link to nothing (with their counts) and the issues.
 * With --out, the text report and a JSON copy are written there.
 */
import fs from 'node:fs';
import path from 'node:path';
import { feeSheetCandidates, type FeeSheetCandidate } from '../src/lib/import/drawing-register/design-fee';
import { centreManifest } from '../src/lib/import/centre-manifest';
import { parseSources } from '../src/lib/import/drawing-register/parse';
import { buildPlan } from '../src/lib/import/drawing-register/plan';
import { readTextWorkbook } from '../src/lib/import/drawing-register/read';

interface WorkbookReport {
  workbook: string;
  folder: string;
  title: { code: string | null; name: string | null } | null;
  feeSheets: FeeSheetCandidate[];
  feeSheet: string | null;
  layout: string | null;
  headings: number;
  headingNames: string[];
  packages: number;
  packageCodes: string[];
  drawings: number;
  released: number;
  linked: number;
  linkedByRule: Record<string, number>;
  linkedPct: number | null;
  unlinked: { batch: string; drawings: number }[];
  disciplines: Record<string, number>;
  fees: { total: number | null; billed: number | null; packages: number | null; packagesBilled: number | null; outsidePackages: number | null; duplicates: number | null } | null;
  issues: Record<string, number>;
  issueSamples: { code: string; message: string }[];
  error: string | null;
}

function walk(dir: string, out: string[] = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (/\.xlsx$/i.test(f) && !f.startsWith('~$')) out.push(p);
  }
  return out;
}

const sum = (o: Record<string, number> | undefined) => Object.values(o ?? {}).reduce((a, b) => a + b, 0);
const r4 = (v: number) => Math.round(v * 10000) / 10000;

function diagnose(file: string): WorkbookReport {
  const fileName = path.basename(file);
  const base: WorkbookReport = {
    workbook: fileName,
    folder: path.dirname(file),
    title: null,
    feeSheets: [],
    feeSheet: null,
    layout: null,
    headings: 0,
    headingNames: [],
    packages: 0,
    packageCodes: [],
    drawings: 0,
    released: 0,
    linked: 0,
    linkedByRule: {},
    linkedPct: null,
    unlinked: [],
    disciplines: {},
    fees: null,
    issues: {},
    issueSamples: [],
    error: null,
  };
  try {
    const sheets = readTextWorkbook(file);
    base.feeSheets = feeSheetCandidates(sheets);
    const manifest = centreManifest({ fileName, fileType: 'PLAN', sheets, mapping: null, code: 'DIAG', name: fileName });
    const src = parseSources(manifest, path.dirname(file));
    const plan = buildPlan(manifest, src);
    const fee = src.designFees[0] ?? null;
    base.feeSheet = manifest.designFees[0]?.sheet ?? null;
    base.layout = fee?.layout ?? null;
    base.title = fee?.title ?? null;
    base.headings = plan.wbsNodes.length;
    base.headingNames = plan.wbsNodes.map((n) => n.sourceLabel);
    base.packages = plan.packages.length;
    base.packageCodes = plan.packages.map((p) => p.code);
    base.drawings = plan.drawings.length;
    base.released = plan.drawings.filter((d) => d.released).length;
    for (const d of plan.drawings) {
      base.disciplines[d.discipline] = (base.disciplines[d.discipline] ?? 0) + 1;
      if (!d.packageCode) continue;
      base.linked++;
      const rule = d.packageRule ?? 'BATCH';
      base.linkedByRule[rule] = (base.linkedByRule[rule] ?? 0) + 1;
    }
    base.linkedPct = base.drawings ? Math.round((base.linked / base.drawings) * 1000) / 10 : null;
    const unl = new Map<string, number>();
    for (const d of plan.drawings) if (!d.packageCode) unl.set(d.batchCode ?? '(no batch)', (unl.get(d.batchCode ?? '(no batch)') ?? 0) + 1);
    base.unlinked = [...unl.entries()].map(([batch, drawings]) => ({ batch, drawings })).sort((a, b) => b.drawings - a.drawings || a.batch.localeCompare(b.batch));
    if (fee) {
      base.fees = {
        total: fee.sheetTotal ? r4(sum(fee.sheetTotal)) : null,
        billed: fee.sheetBilled ? r4(sum(fee.sheetBilled)) : null,
        packages: r4(sum(fee.packageFees)),
        packagesBilled: fee.packageBilled ? r4(sum(fee.packageBilled)) : null,
        outsidePackages: r4(sum(fee.feesOutsidePackages)),
        duplicates: r4(sum(fee.duplicateFees)),
      };
    }
    for (const i of plan.issues) {
      base.issues[i.code] = (base.issues[i.code] ?? 0) + 1;
      if (i.severity !== 'INFO' && base.issueSamples.filter((s) => s.code === i.code).length < 3) base.issueSamples.push({ code: i.code, message: i.message });
    }
  } catch (e) {
    base.error = e instanceof Error ? e.message : String(e);
  }
  return base;
}

function text(reports: WorkbookReport[]) {
  const L: string[] = [];
  const n = (v: number) => v.toLocaleString('en-IN');
  L.push(`Import diagnostic — ${new Date().toISOString()}`);
  L.push('');
  L.push('| Workbook | Fee sheet | Layout | Headings | Packages | Drawings | Released | Linked | % | Unlinked batches |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of reports) {
    L.push(
      `| ${r.workbook} | ${r.feeSheet ?? '—'} | ${r.error ? 'FAILED' : (r.layout ?? '—')} | ${r.headings} | ${r.packages} | ${n(r.drawings)} | ${n(r.released)} | ${n(r.linked)} | ${r.linkedPct ?? '—'} | ${r.unlinked.length} |`,
    );
  }
  const tot = reports.reduce((a, r) => ({ d: a.d + r.drawings, l: a.l + r.linked }), { d: 0, l: 0 });
  L.push(`| **All** | | | | ${reports.reduce((a, r) => a + r.packages, 0)} | ${n(tot.d)} | ${n(reports.reduce((a, r) => a + r.released, 0))} | ${n(tot.l)} | ${tot.d ? Math.round((tot.l / tot.d) * 1000) / 10 : '—'} | |`);
  for (const r of reports) {
    L.push('');
    L.push(`## ${r.workbook}`);
    L.push(`Folder: ${r.folder}`);
    if (r.error) L.push(`IMPORT FAILS: ${r.error}`);
    if (r.title) L.push(`Sheet title: ${[r.title.code, r.title.name].filter(Boolean).join(' | ')}`);
    L.push(`Design Fee sheets: ${r.feeSheets.map((c) => `${c.sheet}${c.hidden ? ' (hidden)' : ''} [${c.layout ?? 'not readable'}${c.billedTill ? `, billed till ${c.billedTill}` : ''}]`).join('; ') || 'none'}`);
    L.push(`Used: ${r.feeSheet ?? '—'} · layout ${r.layout ?? '—'}`);
    if (r.fees) {
      L.push(
        `Fees (₹ Cr): sheet total ${r.fees.total ?? '—'} · billed ${r.fees.billed ?? '—'} · on packages ${r.fees.packages ?? '—'} (billed ${r.fees.packagesBilled ?? '—'}) · outside packages ${r.fees.outsidePackages ?? '—'} · repeated codes ${r.fees.duplicates ?? '—'}`,
      );
    }
    L.push(`Headings (${r.headings}): ${r.headingNames.join(' · ') || '—'}`);
    L.push(`Packages (${r.packages}): ${r.packageCodes.join(', ') || '—'}`);
    L.push(`Drawings ${n(r.drawings)} (released ${n(r.released)}) by discipline: ${Object.entries(r.disciplines).map(([k, v]) => `${k} ${n(v)}`).join(', ') || '—'}`);
    L.push(`Linked to a package: ${n(r.linked)}${r.linkedPct != null ? ` (${r.linkedPct} %)` : ''} — ${Object.entries(r.linkedByRule).map(([k, v]) => `${k} ${n(v)}`).join(', ') || 'none'}`);
    if (r.unlinked.length) L.push(`Unlinked batches (${r.unlinked.length}): ${r.unlinked.map((u) => `${u.batch} ×${u.drawings}`).join(', ')}`);
    L.push(`Issues: ${Object.entries(r.issues).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
    for (const s of r.issueSamples) L.push(`  - ${s.code}: ${s.message}`);
  }
  return L.join('\n');
}

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const out = outAt >= 0 ? args[outAt + 1] : null;
const folder = args.find((a, i) => !a.startsWith('--') && i !== outAt + 1) ?? 'import/dfs-2026';
const files = walk(folder).sort();
if (!files.length) {
  console.error(`No .xlsx workbooks under ${folder}`);
  process.exit(1);
}
const reports = files.map(diagnose);
const report = text(reports);
console.log(report);
if (out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(`${out}.md`, report);
  fs.writeFileSync(`${out}.json`, JSON.stringify(reports, null, 2));
  console.log(`\nWritten: ${out}.md, ${out}.json`);
}
