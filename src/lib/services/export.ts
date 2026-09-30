/**
 * Export. Every exported file carries a banner naming the system and the date
 * it was exported on (spec §39).
 */
import * as XLSX from 'xlsx';
import { updatedOnText } from '@/lib/updated-on';
import { formatDate } from '@/lib/periods';
import { SCHEDULE_STATUS_LABEL } from '@/lib/domain';
import { APP_NAME, evidenceLabel, periodLabelFull, projectLabel, quarterLabel, releaseLabel, STATUS_LABEL, yearLabel } from '@/lib/labels';
import { queryDeliverables, queryGoals } from './queries';
import type { ListFilters } from './filters';

export type ExportKind = 'goals' | 'deliverables' | 'drawings';
export type ExportFormat = 'xlsx' | 'csv';

function banner(): string {
  return `Exported from the ${APP_NAME} on ${formatDate(new Date())}.`;
}

function completionLabel(status: string): string {
  return status === 'COMPLETED' ? STATUS_LABEL.COMPLETE : STATUS_LABEL.PENDING;
}

function scheduleLabel(status: string): string {
  return SCHEDULE_STATUS_LABEL[status as keyof typeof SCHEDULE_STATUS_LABEL] ?? status;
}

async function rowsFor(
  kind: ExportKind,
  filters: ListFilters,
  drawingFilters?: import('./drawing-register').DrawingFilters,
): Promise<Record<string, unknown>[]> {
  const all: ListFilters = { ...filters, page: 1, pageSize: 500 };
  const out: Record<string, unknown>[] = [];
  let page = 1;
  for (;;) {
    const f = { ...all, page };
    if (kind === 'goals') {
      const res = await queryGoals(f);
      for (const r of res.rows) {
        out.push({
          'Goal code': r.goalCode,
          Project: projectLabel(r),
          Phase: r.phaseCode ?? '',
          Discipline: r.disciplineName ?? '',
          'Design lead': r.designLeadName ?? '',
          Description: r.goalDescription,
          'Financial year': yearLabel(r.fiscalYear),
          Quarter: quarterLabel(r.quarter),
          'Planned packages': r.plannedQuantity,
          'Delivered packages': r.reportedActualQuantity,
          'Planned billing (₹ Cr)': r.plannedValue,
          'Actual billing (₹ Cr)': r.reportedActualValue,
          'Baseline target': formatDate(r.baselineTargetDate),
          'Current expected': formatDate(r.currentExpectedDate),
          'Actual completion': formatDate(r.actualCompletionDate),
          Completion: completionLabel(r.completionStatus),
          'Schedule status': scheduleLabel(r.schedule.status),
          'Slip (days)': r.schedule.slipDays,
          Priority: r.priority,
          Reschedules: r.rescheduleCount,
          Remarks: r.remarks ?? '',
        });
      }
      if (page >= res.pageCount) break;
    } else if (kind === 'deliverables') {
      const res = await queryDeliverables(f);
      for (const r of res.rows) {
        out.push({
          'Deliverable code': r.deliverableCode,
          Project: projectLabel(r),
          Package: r.packageCode ?? '',
          'Package name': r.packageName ?? '',
          Discipline: r.disciplineName ?? '',
          Description: r.deliverableDescription,
          Owner: r.ownerName ?? '',
          'Baseline release': formatDate(r.baselineReleaseDate),
          'Current expected release': formatDate(r.currentExpectedReleaseDate),
          'Actual release': formatDate(r.actualReleaseDate),
          Completion: completionLabel(r.completionStatus),
          'Schedule status': scheduleLabel(r.schedule.status),
          'Slip (days)': r.schedule.slipDays,
          Revision: r.revision ?? '',
          Reschedules: r.rescheduleCount,
          Remarks: r.remarks ?? '',
        });
      }
      if (page >= res.pageCount) break;
    } else {
      // The Drawing Register: every matching row in one query (no page cap).
      const { allDrawings, assessDrawing, drawingFiltersFromList } = await import('./drawing-register');
      const rows = await allDrawings(drawingFilters ?? drawingFiltersFromList(f));
      for (const r of rows) {
        const schedule = assessDrawing(r);
        out.push({
          'Drawing number': r.numberStatus === 'NOT_YET_NUMBERED' ? 'Not yet numbered' : r.drawingCode,
          'Number status': r.numberStatus === 'NOT_YET_NUMBERED' ? 'Not yet numbered' : 'Numbered',
          'Partial sheet number': r.partialNumber ?? '',
          'Drawing name': r.drawingName,
          Project: projectLabel({ displayName: r.projectDisplayName, projectName: r.projectName }),
          Phase: r.phaseCode ?? '',
          Discipline: r.disciplineName ?? '',
          'Area of works': r.areaOfWorks ?? '',
          Package: r.packageCode ?? '',
          'Batch code': r.batchCode ?? '',
          Batch: r.batch ?? '',
          Location: r.location ?? '',
          Revision: r.revision ?? '',
          'Release status': releaseLabel(r.completionStatus),
          'Release evidence': evidenceLabel(r.releaseEvidence),
          'Plan period': periodLabelFull(r.planPeriodLabel),
          'Baseline release': formatDate(r.baselineReleaseDate),
          'Current expected release': formatDate(r.currentExpectedReleaseDate),
          'Actual release':
            formatDate(r.actualReleaseDate),
          'Updated On': updatedOnText(r),
          'Schedule status': schedule ? scheduleLabel(schedule.status) : '',
          'Slip (days)': schedule?.slipDays ?? '',
          Responsible: r.responsibleName ?? r.responsibleText ?? '',
          Reschedules: r.rescheduleCount,
          Remarks: r.remarks ?? '',
        });
      }
      break;
    }
    page += 1;
    if (page > 200) break; // hard stop
  }
  return out;
}

export async function buildExport(
  kind: ExportKind,
  format: ExportFormat,
  filters: ListFilters,
  drawingFilters?: import('./drawing-register').DrawingFilters,
): Promise<{ buffer: Buffer; filename: string; contentType: string; rowCount: number }> {
  const rows = await rowsFor(kind, filters, drawingFilters);
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'csv') {
    const sheet = XLSX.utils.json_to_sheet(rows);
    const csv = `# ${banner()}\n${XLSX.utils.sheet_to_csv(sheet)}`;
    return {
      buffer: Buffer.from(csv, 'utf8'),
      filename: `${kind}-snapshot-${stamp}.csv`,
      contentType: 'text/csv; charset=utf-8',
      rowCount: rows.length,
    };
  }
  const wb = XLSX.utils.book_new();
  const info = XLSX.utils.aoa_to_sheet([
    [APP_NAME],
    [banner()],
    ['Exported at', new Date().toISOString()],
    ['Register', kind],
    ['Rows', rows.length],
    ['Filters', JSON.stringify(filters)],
  ]);
  XLSX.utils.book_append_sheet(wb, info, 'Read me');
  const data = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, data, kind.slice(0, 28));
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return {
    buffer,
    filename: `${kind}-snapshot-${stamp}.xlsx`,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    rowCount: rows.length,
  };
}
