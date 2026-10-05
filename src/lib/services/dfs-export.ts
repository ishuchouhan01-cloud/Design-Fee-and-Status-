/**
 * Project Drawing Status export — the filtered view, as Excel or CSV, with
 * the hierarchy spelled out in columns and every label in full. Billing
 * columns only for roles that may see billing.
 */
import * as XLSX from 'xlsx';
import { APP_NAME, APP_TITLE, DFS_LABEL, packageStatusLabel, releaseLabel } from '@/lib/labels';
import { formatDate, formatDateTime } from '@/lib/format';
import { updatedOnText } from '@/lib/updated-on';
import { PACKAGE_FEE_LINE } from '@/lib/import/drawing-register/design-fee';
import { EXCLUDED_NO_RELEASE } from './billing-rollup';
import { buildDfsModel, modelBilling, type DfsFilters, type DfsModel, type DfsRow } from './dfs';

type Line = Record<string, string | number>;

function walk(model: DfsModel, visit: (r: DfsRow, path: DfsRow[]) => void) {
  const go = (keys: string[], path: DfsRow[]) => {
    for (const k of keys) {
      const r = model.rows.get(k);
      if (!r) continue;
      visit(r, path);
      go(model.children.get(k) ?? [], [...path, r]);
    }
  };
  go(model.roots, []);
}

function hierarchy(path: DfsRow[]) {
  const projectsOnPath = path.filter((p) => p.kind === 'PROJECT');
  return {
    [DFS_LABEL.colProject]: projectsOnPath[0]?.name ?? '',
    [DFS_LABEL.colTower]: projectsOnPath.slice(1).map((p) => p.name).join(' › '),
    [DFS_LABEL.colGroup]: path.filter((p) => p.kind === 'NODE').map((p) => p.name).join(' › '),
  };
}

const date = (iso: string | null) => (iso ? formatDate(new Date(iso)) : '—');
const money = (v: number | undefined) => (v == null ? '' : Math.round(v * 10000) / 10000);

function billingCols(r: DfsRow, on: boolean): Line {
  if (!on) return {};
  // A fee line with no released drawing is left out of billing: "—", as on the screen.
  const out = !r.billing && (r.billingFlags ?? []).includes(EXCLUDED_NO_RELEASE);
  return {
    [`${DFS_LABEL.colTotal} (₹ Cr)`]: out ? '—' : money(r.billing?.total),
    [`${DFS_LABEL.colBilled} (₹ Cr)`]: out ? '—' : money(r.billing?.billed),
    [`${DFS_LABEL.colUnbilled} (₹ Cr)`]: out ? '—' : money(r.billing?.unbilled),
    'Billing note': out
      ? DFS_LABEL.billingExcludedNote
      : (r.billingFlags ?? []).includes('BILLED_BEFORE_COMPLETION')
      ? DFS_LABEL.billedBeforeCompletion
      : (r.billingFlags ?? []).includes('ELIGIBLE_AFTER_COMPLETION')
        ? DFS_LABEL.eligibleAfterCompletion
        : '',
  };
}

export async function buildDfsExport(f: DfsFilters, format: 'xlsx' | 'csv', opts: { billing?: boolean } = {}) {
  const billing = !!opts.billing;
  const model = await buildDfsModel(f);
  const packagesOut: Line[] = [];
  const lines: Line[] = [];
  const unitKeys: { key: string; path: DfsRow[] }[] = [];
  walk(model, (r, path) => {
    if (r.kind === 'PACKAGE' || r.kind === 'NO_PACKAGE') {
      packagesOut.push({
        ...hierarchy(path),
        [DFS_LABEL.colPackageCode]: r.code ?? '',
        [DFS_LABEL.colPackage]: r.name,
        [DFS_LABEL.colResponsible]: r.responsible ?? '',
        [DFS_LABEL.colPackageStatus]: r.status ? packageStatusLabel(r.status) : '',
        [DFS_LABEL.colReleaseDate]: date(r.releaseDate),
        [DFS_LABEL.colDrawingsReleased]: r.drawingsReleased,
        'Drawings Total': r.drawingsTotal,
        ...billingCols(r, billing),
      });
      // One fee for the whole package: its own line, so the lines still add up to the totals.
      if (r.group === PACKAGE_FEE_LINE) {
        lines.push({
          ...hierarchy(path),
          [DFS_LABEL.colPackageCode]: r.code ?? '',
          [DFS_LABEL.colPackage]: r.name,
          [DFS_LABEL.colResponsible]: r.responsible ?? '',
          [DFS_LABEL.colPackageStatus]: r.status ? packageStatusLabel(r.status) : '',
          [DFS_LABEL.colDiscipline]: DFS_LABEL.wholePackage,
          'Discipline Status': '',
          [DFS_LABEL.colReleaseDate]: date(r.releaseDate),
          [DFS_LABEL.colDrawingsReleased]: '',
          'Drawings Total': '',
          ...billingCols(r, billing),
        });
      }
    }
    if (r.kind === 'DISCIPLINE') {
      const pk = path[path.length - 1];
      const inPackage = pk && (pk.kind === 'PACKAGE' || pk.kind === 'NO_PACKAGE');
      lines.push({
        ...hierarchy(inPackage ? path.slice(0, -1) : path),
        [DFS_LABEL.colPackageCode]: inPackage ? (pk.code ?? '') : '',
        [DFS_LABEL.colPackage]: inPackage ? pk.name : '',
        [DFS_LABEL.colResponsible]: inPackage ? (pk.responsible ?? '') : '',
        [DFS_LABEL.colPackageStatus]: inPackage && pk.status ? packageStatusLabel(pk.status) : '',
        [DFS_LABEL.colDiscipline]: r.name,
        'Discipline Status': r.status ? packageStatusLabel(r.status) : '',
        [DFS_LABEL.colReleaseDate]: date(r.releaseDate),
        [DFS_LABEL.colDrawingsReleased]: r.drawingsReleased,
        'Drawings Total': r.drawingsTotal,
        ...billingCols(r, billing),
      });
      if (r.unitKey && r.drawingsTotal > 0) unitKeys.push({ key: r.unitKey, path: [...path, r] });
    }
  });
  const stamp = new Date().toISOString().slice(0, 10);
  const base = `project-drawing-status-${stamp}`;
  if (format === 'csv') {
    const csv = XLSX.utils.sheet_to_csv(XLSX.utils.json_to_sheet(lines));
    return { buffer: Buffer.from(`﻿${csv}`, 'utf8'), filename: `${base}.csv`, contentType: 'text/csv; charset=utf-8', rowCount: lines.length };
  }
  // Drawings of every discipline row in the view, with the same names and dates as the screen.
  const { unitDrawings } = await import('./dfs');
  const drawingsOut: Line[] = [];
  for (const u of unitKeys) {
    for (let page = 1; ; page++) {
      const res = await unitDrawings(u.key, f, page, 500);
      const pk = u.path.find((x) => x.kind === 'PACKAGE' || x.kind === 'NO_PACKAGE');
      for (const d of res.rows) {
        drawingsOut.push({
          ...hierarchy(u.path.filter((x) => x.kind === 'PROJECT' || x.kind === 'NODE')),
          [DFS_LABEL.colPackage]: pk?.name ?? '',
          [DFS_LABEL.colDiscipline]: u.path[u.path.length - 1].name,
          [DFS_LABEL.colDrawingName]: d.drawingName,
          [DFS_LABEL.colDrawingNumber]: d.numberStatus === 'NOT_YET_NUMBERED' ? DFS_LABEL.notYetNumbered : d.drawingCode,
          [DFS_LABEL.colRevision]: d.revision ?? '',
          [DFS_LABEL.colResponsible]: d.responsibleName ?? d.responsibleText ?? '',
          [DFS_LABEL.colReleaseStatus]: releaseLabel(d.completionStatus),
          [DFS_LABEL.colUpdatedOn]: updatedOnText(d),
        });
      }
      if (page >= res.pageCount) break;
    }
  }
  const wb = XLSX.utils.book_new();
  const totals = model.roots.map((k) => model.rows.get(k)!);
  const all = modelBilling(model);
  const about = XLSX.utils.aoa_to_sheet([
    [APP_NAME],
    [APP_TITLE],
    ['Exported on', formatDateTime(new Date())],
    [],
    [DFS_LABEL.colProject, DFS_LABEL.colPackagesComplete, 'Packages Total', DFS_LABEL.colDrawingsReleased, 'Drawings Total', ...(billing ? ['Total (₹ Cr)', 'Billed (₹ Cr)', 'Unbilled (₹ Cr)'] : [])],
    ...totals.map((r) => [r.name, r.packagesComplete, r.packagesTotal, r.drawingsReleased, r.drawingsTotal, ...(billing ? [money(r.billing?.total), money(r.billing?.billed), money(r.billing?.unbilled)] : [])]),
    ...(billing && all ? [['All projects', '', '', '', '', money(all.total), money(all.billed), money(all.unbilled)]] : []),
    ...(billing
      ? [
          [],
          ['Reconciliation (₹ Cr)', '', '', '', '', 'Total', 'Billed'],
          ['Fee lines as stored (source)', '', '', '', '', money(model.source.total), money(model.source.billed)],
          ['Left out: no drawings released', '', '', '', '', money(model.excluded.noRelease.total), money(model.excluded.noRelease.billed)],
          ['Left out: Not Applicable', '', '', '', '', money(model.excluded.notApplicable.total), money(model.excluded.notApplicable.billed)],
          ['Shown (as above)', '', '', '', '', money(all?.total ?? 0), money(all?.billed ?? 0)],
        ]
      : []),
  ]);
  XLSX.utils.book_append_sheet(wb, about, 'Summary');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(packagesOut), 'Packages');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(lines), 'Packages by discipline');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(drawingsOut), 'Drawings');
  if (billing) {
    const review = model.review.map((x) => ({
      [DFS_LABEL.colProject]: x.project,
      [DFS_LABEL.colPackageCode]: x.packageCode,
      [DFS_LABEL.colPackage]: x.packageName,
      [DFS_LABEL.colDiscipline]: x.disciplineName,
      [`${DFS_LABEL.colTotal} (₹ Cr)`]: money(x.total),
      [`${DFS_LABEL.colBilled} (₹ Cr)`]: money(x.billed),
      Reason: x.reason,
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(review.length ? review : [{ [DFS_LABEL.colProject]: DFS_LABEL.reviewEmpty }]), 'Billing to review');
  }
  return {
    buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer,
    filename: `${base}.xlsx`,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    rowCount: lines.length,
  };
}
