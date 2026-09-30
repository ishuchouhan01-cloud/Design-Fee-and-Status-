import fs from 'node:fs';
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { goals, projects } from '@/db/schema';
import { buildExecutiveDashboard, buildProjectDashboard } from '@/lib/services/dashboard';
import { buildProjectReport, buildWeeklyReport } from '@/lib/services/reporting';
import { buildExport } from '@/lib/services/export';
import { buildGantt } from '@/lib/services/gantt';
import { checkPgTools, createBackup, inspectBackup, listBackups } from '@/lib/services/backup';
import { runDataQualityChecks } from '@/lib/import/quality';
import { can, assertCan, ForbiddenError } from '@/lib/rbac';
import { pct } from '@/lib/metrics';

describe('dashboard is calculated from the database', () => {
  it('derives the goal block from the goal rows, not from a stored total', async () => {
    const d = await buildExecutiveDashboard({ fiscalYear: 'FY26-27' });
    const [agg] = await db
      .select({
        n: sql<number>`count(*)::int`,
        planned: sql<number>`coalesce(sum(${goals.plannedQuantity}), 0)::int`,
        delivered: sql<number>`coalesce(sum(${goals.reportedActualQuantity}), 0)::int`,
      })
      .from(goals)
      .where(eq(goals.fiscalYear, 'FY26-27'));
    expect(d.goalBlock.goalCount).toBe(Number(agg.n));
    expect(d.goalBlock.plannedPackages).toBe(Number(agg.planned));
    expect(d.goalBlock.deliveredPackages).toBe(Number(agg.delivered));
    expect(d.goalBlock.completionPercent).toBe(pct(Number(agg.delivered), Number(agg.planned)));
  });

  it('quarter rows sum to the period totals', async () => {
    const d = await buildExecutiveDashboard({ fiscalYear: 'FY26-27' });
    const quarterPlanSum = d.quarters.reduce((s, q) => s + q.plan, 0);
    expect(quarterPlanSum).toBe(d.goalBlock.plannedPackages);
  });

  it('project rows sum to the portfolio total', async () => {
    const d = await buildExecutiveDashboard({ fiscalYear: 'FY26-27' });
    const sum = d.projectRows.reduce((s, p) => s + p.plannedPackages, 0);
    expect(sum).toBe(d.goalBlock.plannedPackages);
    expect(d.projectRows.every((p) => ['GREEN', 'AMBER', 'RED', 'GREY'].includes(p.rag))).toBe(true);
  });

  it('reacts to a data change without any cache to invalidate', async () => {
    const before = await buildExecutiveDashboard({ fiscalYear: 'FY26-27' });
    const [g] = await db
      .select()
      .from(goals)
      .where(eq(goals.fiscalYear, 'FY26-27'))
      .limit(1);
    await db
      .update(goals)
      .set({ plannedQuantity: g.plannedQuantity + 7 })
      .where(eq(goals.id, g.id));
    const after = await buildExecutiveDashboard({ fiscalYear: 'FY26-27' });
    expect(after.goalBlock.plannedPackages).toBe(before.goalBlock.plannedPackages + 7);
    await db.update(goals).set({ plannedQuantity: g.plannedQuantity }).where(eq(goals.id, g.id));
  });

  it('builds a project dashboard with a forecast and a RAG reason', async () => {
    const [vh] = await db.select().from(projects).where(eq(projects.projectCode, 'VIOLET-HILL')).limit(1);
    const d = await buildProjectDashboard(vh.id, 'FY26-27');
    expect(d).toBeTruthy();
    expect(d!.packages.length).toBeGreaterThan(20);
    expect(d!.byDiscipline.length).toBeGreaterThan(0);
    expect(d!.byQuarter).toHaveLength(4);
    expect(d!.rag.reason.length).toBeGreaterThan(3);
    expect(d!.forecast.forecastCompletion).toBeInstanceOf(Date);
  });

  it('returns null for an unknown project rather than throwing', async () => {
    expect(await buildProjectDashboard('no-such-project', 'FY26-27')).toBeNull();
  });
});

describe('programme (Gantt) view', () => {
  it('produces baseline, expected and actual tracks plus links', async () => {
    const [vh] = await db.select().from(projects).where(eq(projects.projectCode, 'VIOLET-HILL')).limit(1);
    const g = await buildGantt({ projectId: vh.id, include: ['PACKAGE', 'DELIVERABLE'], limit: 100 });
    expect(g.bars.length).toBeGreaterThan(10);
    expect(g.windowStart).toBeInstanceOf(Date);
    expect(g.windowEnd).toBeInstanceOf(Date);
    expect(g.bars.some((b) => b.baselineFinish !== null)).toBe(true);
    expect(g.bars.some((b) => b.expectedFinish !== null)).toBe(true);
    expect(g.links.length).toBeGreaterThan(0);
    expect(g.bars.every((b) => ['PACKAGE', 'DELIVERABLE', 'DRAWING'].includes(b.entityType))).toBe(true);
  });
});

describe('reporting layer for the weekly PowerPoint automation', () => {
  it('returns a complete payload from the same rows the dashboard uses', async () => {
    const report = await buildWeeklyReport({ fiscalYear: 'FY26-27' });
    const d = await buildExecutiveDashboard({ fiscalYear: 'FY26-27' });
    expect(report.headline.plannedPackages).toBe(d.goalBlock.plannedPackages);
    expect(report.headline.deliveredPackages).toBe(d.goalBlock.deliveredPackages);
    expect(report.projects.length).toBe(d.projectRows.length);
    expect(report.quarters).toHaveLength(4);
    expect(report.planVsActual.plan).toBe(d.deliveryBlock.planned);
    expect(report.managementAttention).toHaveProperty('overdueDeliverables');
    expect(report.managementAttention).toHaveProperty('recentReschedules');
    expect(report.disciplines.length).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toMatch(/\.xlsx/i);
  });

  it('returns a per-project payload', async () => {
    const [vh] = await db.select().from(projects).where(eq(projects.projectCode, 'VIOLET-HILL')).limit(1);
    const r = await buildProjectReport(vh.id, 'FY26-27');
    expect(r?.project.code).toBe('VIOLET-HILL');
    expect(r?.packages.length).toBeGreaterThan(0);
    expect(r?.forecast).toHaveProperty('varianceDays');
  });
});

describe('export', () => {
  it('produces an xlsx snapshot with a read-me banner and the filtered rows', async () => {
    const [vh] = await db.select().from(projects).where(eq(projects.projectCode, 'VIOLET-HILL')).limit(1);
    const res = await buildExport('drawings', 'xlsx', { projectId: vh.id });
    expect(res.filename).toMatch(/drawings-snapshot-\d{4}-\d{2}-\d{2}\.xlsx/);
    expect(res.rowCount).toBeGreaterThan(80);
    const wb = XLSX.read(res.buffer, { type: 'buffer' });
    expect(wb.SheetNames).toContain('Read me');
    expect(wb.SheetNames).toContain('drawings');
    const readme = XLSX.utils.sheet_to_json<string[]>(wb.Sheets['Read me'], { header: 1 });
    expect(JSON.stringify(readme)).toMatch(/Exported from the Design Goals & Delivery Control System/);
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets.drawings);
    expect(rows.length).toBe(res.rowCount);
    expect(Object.keys(rows[0])).toContain('Baseline release');
    expect(Object.keys(rows[0])).toContain('Current expected release');
    expect(Object.keys(rows[0])).toContain('Actual release');
    expect(Object.keys(rows[0]).some((k) => /percent/i.test(k))).toBe(false);
  });

  it('produces a csv snapshot for goals and deliverables', async () => {
    const goalsCsv = await buildExport('goals', 'csv', { fiscalYear: 'FY26-27', pageSize: 100 });
    expect(goalsCsv.contentType).toMatch(/text\/csv/);
    expect(goalsCsv.buffer.toString('utf8').split('\n')[0]).toMatch(/^# Exported from the Design Goals & Delivery Control System/);
    const dl = await buildExport('deliverables', 'csv', {});
    expect(dl.rowCount).toBeGreaterThan(100);
  });
});

describe('backup', () => {
  it('pg_dump is reachable, so the backup button will not fail at the point of use', async () => {
    const tools = await checkPgTools();
    expect(tools.available, `${tools.command}: ${tools.hint ?? ''}`).toBe(true);
    expect(tools.version).toMatch(/pg_dump/i);
  });

  it('creates a consistent dump while the database is open, and the dump contains the data', async () => {
    const before = listBackups().length;
    const file = await createBackup({ id: null, label: 'test' }, 'test');
    expect(fs.existsSync(file.path)).toBe(true);
    expect(file.bytes).toBeGreaterThan(20_000);
    expect(file.name.endsWith('.dump')).toBe(true);
    expect(listBackups().length).toBe(before + 1);

    // Verify by reading the dump's own table of contents rather than trusting
    // the exit code: every table we expect must be in there.
    const toc = (await inspectBackup(file.path)).join('\n');
    for (const table of ['goals', 'design_deliverables', 'drawings', 'audit_log', 'reschedule_history']) {
      expect(toc, `dump is missing ${table}`).toMatch(new RegExp(`TABLE DATA public ${table}`));
    }
    const [live] = await db.select({ n: sql<number>`count(*)::int` }).from(goals);
    expect(Number(live.n)).toBeGreaterThan(1000);
  });

  it('prunes to the configured retention', async () => {
    const kept = listBackups();
    expect(kept.length).toBeLessThanOrEqual(20);
  });
});

describe('data quality checks', () => {
  it('runs and returns structured findings', async () => {
    const findings = await runDataQualityChecks();
    expect(Array.isArray(findings)).toBe(true);
    for (const f of findings) {
      expect(['INFO', 'WARNING', 'ERROR']).toContain(f.severity);
      expect(f.count).toBeGreaterThan(0);
      expect(f.message.length).toBeGreaterThan(5);
    }
  });
});

describe('role based access control', () => {
  it('gives viewers read-only access', () => {
    expect(can('VIEWER', 'drawing.read')).toBe(true);
    expect(can('VIEWER', 'drawing.complete')).toBe(false);
    expect(can('VIEWER', 'schedule.reschedule')).toBe(false);
    expect(can('VIEWER', 'import.run')).toBe(false);
  });

  it('lets editors update operational data but not reschedule', () => {
    expect(can('EDITOR', 'deliverable.complete')).toBe(true);
    expect(can('EDITOR', 'bulk.update')).toBe(true);
    expect(can('EDITOR', 'schedule.reschedule')).toBe(false);
  });

  it('lets managers reschedule and override RAG, admins import', () => {
    expect(can('MANAGER', 'schedule.reschedule')).toBe(true);
    expect(can('MANAGER', 'rag.override')).toBe(true);
    expect(can('MANAGER', 'import.run')).toBe(false);
    expect(can('ADMIN', 'import.run')).toBe(true);
    expect(can('ADMIN', 'user.manage')).toBe(true);
  });

  it('throws a ForbiddenError, not a generic one', () => {
    try {
      assertCan('VIEWER', 'schedule.reschedule');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ForbiddenError);
      expect((e as ForbiddenError).status).toBe(403);
    }
  });
});
