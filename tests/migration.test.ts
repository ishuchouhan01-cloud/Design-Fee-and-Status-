import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  criticalRequirements,
  deliverables,
  dependencies,
  disciplines,
  drawings,
  goalRevisions,
  goals,
  importIssues,
  importRuns,
  packageFees,
  packages,
  projects,
  teamAssignments,
  users,
} from '@/db/schema';
import { runImport, currentTotals } from '@/lib/import';

const summary = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'data/test-import-summary.json'), 'utf8'),
);

describe('database creation', () => {
  it('created every table the model needs', async () => {
    const rows = (
      await db.execute<{ table_name: string }>(
        sql`select table_name from information_schema.tables
             where table_schema = 'public' and table_type = 'BASE TABLE'`,
      )
    ).rows;
    const names = rows.map((r) => r.table_name);
    for (const t of [
      'projects',
      'project_phases',
      'packages',
      'package_fees',
      'goals',
      'goal_revisions',
      'team_assignments',
      'design_deliverables',
      'drawings',
      'dependencies',
      'reschedule_history',
      'rag_overrides',
      'audit_log',
      'import_runs',
      'import_issues',
      'users',
      'disciplines',
      'critical_requirements',
      'app_settings',
    ]) {
      expect(names, `missing table ${t}`).toContain(t);
    }
  });

  it('seeded the reference disciplines', async () => {
    const rows = await db.select().from(disciplines);
    expect(rows.length).toBeGreaterThanOrEqual(10);
    expect(rows.map((r) => r.code)).toContain('AR');
    expect(rows.map((r) => r.code)).toContain('MEP');
  });
});

describe('Excel migration', () => {
  it('completed without errors and recorded a run', async () => {
    expect(summary.errors).toBe(0);
    expect(summary.status).toBe('SUCCESS');
    const runs = await db.select().from(importRuns);
    expect(runs.length).toBeGreaterThanOrEqual(1);
  });

  it('loaded the expected shape of data from both workbooks', async () => {
    const totals = await currentTotals();
    expect(totals.projects).toBeGreaterThan(60);
    expect(totals.goals).toBeGreaterThan(1500);
    expect(totals.deliverables).toBeGreaterThan(200);
    expect(totals.drawings).toBeGreaterThan(80);
    expect(totals.packages).toBeGreaterThan(20);
    expect(totals.dependencies).toBeGreaterThan(0);
  });

  it('kept the per-design-lead sheets out of the database (one record exists once)', () => {
    const skipped = summary.issues.filter((i: { code: string }) => i.code === 'SHEET_SKIPPED_LEADER_VIEW');
    expect(skipped.length).toBeGreaterThan(15);
    expect(summary.counts.sheetsSkippedLeaderView).toBeGreaterThan(15);
  });

  it('kept pivots and summaries out of the database', () => {
    expect(summary.counts.sheetsSkippedDerived).toBeGreaterThan(5);
  });

  it('did not silently discard rows: unmatched projects were created and logged', () => {
    const created = summary.issues.filter((i: { code: string }) => i.code === 'PROJECT_CREATED_FROM_GOAL_ROW');
    expect(created.length).toBeGreaterThan(0);
    expect(summary.issues.some((i: { code: string }) => i.code === 'GOAL_PROJECT_UNMATCHED')).toBe(false);
  });

  it('recorded every warning in the persisted import log', async () => {
    const rows = await db.select().from(importIssues);
    expect(rows.length).toBe(summary.issues.length);
  });

  it('normalised people into user rows and linked teams to goals', async () => {
    const [{ n: userCount }] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
    expect(Number(userCount)).toBeGreaterThan(50);
    const [{ n: teamCount }] = await db.select({ n: sql<number>`count(*)::int` }).from(teamAssignments);
    expect(Number(teamCount)).toBeGreaterThan(500);
  });

  it('preserved revised plans as revisions rather than overwriting history', async () => {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(goalRevisions);
    expect(Number(n)).toBeGreaterThan(0);
    const [rev] = await db.select().from(goalRevisions).limit(1);
    expect(rev.previousTargetQuantity).not.toBeNull();
    expect(rev.reason).toBeTruthy();
  });

  it('carried the commercial fee weighting across for the plan workbook', async () => {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(packageFees);
    expect(Number(n)).toBeGreaterThan(50);
  });

  it('carried critical requirements across', async () => {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(criticalRequirements);
    expect(Number(n)).toBeGreaterThan(20);
  });

  it('is idempotent — a second run updates instead of duplicating', async () => {
    const before = await currentTotals();
    const second = await runImport({
      goalsWorkbook: path.resolve(process.cwd(), process.env.EXCEL_GOALS_WORKBOOK!),
      projectPlanWorkbooks: [path.resolve(process.cwd(), process.env.EXCEL_PROJECT_PLAN_WORKBOOKS!)],
      deriveDependencies: true,
      actor: { id: null, label: 'idempotency test' },
    });
    expect(second.errors).toBe(0);
    const after = await currentTotals();
    expect(after).toEqual(before);
  });
});

describe('duplicate prevention', () => {
  it('has no duplicate project codes', async () => {
    const dups = await db
      .select({ code: projects.projectCode, n: sql<number>`count(*)::int` })
      .from(projects)
      .groupBy(projects.projectCode)
      .having(sql`count(*) > 1`);
    expect(dups).toEqual([]);
  });

  it('has no duplicate goal codes', async () => {
    const dups = await db
      .select({ code: goals.goalCode, n: sql<number>`count(*)::int` })
      .from(goals)
      .groupBy(goals.goalCode)
      .having(sql`count(*) > 1`);
    expect(dups).toEqual([]);
  });

  it('has no duplicate deliverable codes', async () => {
    const dups = await db
      .select({ code: deliverables.deliverableCode, n: sql<number>`count(*)::int` })
      .from(deliverables)
      .groupBy(deliverables.deliverableCode)
      .having(sql`count(*) > 1`);
    expect(dups).toEqual([]);
  });

  it('has no duplicate drawing within a project + batch', async () => {
    const dups = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(drawings)
      .groupBy(drawings.projectId, drawings.drawingCode, drawings.batchCode)
      .having(sql`count(*) > 1`);
    expect(dups).toEqual([]);
  });

  it('has no duplicate dependency links', async () => {
    const dups = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(dependencies)
      .groupBy(
        dependencies.predecessorType,
        dependencies.predecessorId,
        dependencies.successorType,
        dependencies.successorId,
      )
      .having(sql`count(*) > 1`);
    expect(dups).toEqual([]);
  });
});

describe('binary completion is enforced in the stored data', () => {
  it('no drawing or deliverable holds anything other than COMPLETED / NOT_COMPLETED', async () => {
    const dw = await db.selectDistinct({ s: drawings.completionStatus }).from(drawings);
    const dl = await db.selectDistinct({ s: deliverables.completionStatus }).from(deliverables);
    const gl = await db.selectDistinct({ s: goals.completionStatus }).from(goals);
    for (const set of [dw, dl, gl]) {
      for (const row of set) expect(['COMPLETED', 'NOT_COMPLETED']).toContain(row.s);
    }
  });

  it('has no percentage-shaped column on any delivery table', async () => {
    const cols = (
      await db.execute<{ table_name: string; column_name: string }>(
        sql`select table_name, column_name from information_schema.columns
             where table_schema = 'public'
               and table_name in ('drawings', 'design_deliverables', 'goals',
                                  'fy26_packages', 'fy26_package_dependencies')`,
      )
    ).rows;
    expect(cols.length).toBeGreaterThan(20);
    const offenders = cols
      .filter((c) => /percent|progress/i.test(c.column_name))
      .map((c) => `${c.table_name}.${c.column_name}`);
    expect(offenders, offenders.join(', ')).toEqual([]);
  });

  it('stores completion as a two-value text column, not a database enum', async () => {
    const cols = (
      await db.execute<{ table_name: string; data_type: string }>(
        sql`select table_name, data_type from information_schema.columns
             where table_schema = 'public' and column_name = 'completion_status'`,
      )
    ).rows;
    // goals, design_deliverables, drawings, the two FY26 tables and the
    // drawing revision history (a revision is RELEASED or NOT RELEASED). The
    // assertion is that EVERY completion column is a plain two-value text
    // column — never a database enum, never a numeric percentage — so the list
    // is checked by name rather than by count alone.
    expect(cols.map((c) => c.table_name).sort()).toEqual([
      'design_deliverables',
      'drawing_revisions',
      'drawings',
      'fy26_package_dependencies',
      'fy26_packages',
      'goals',
    ]);
    for (const c of cols) expect(c.data_type).toBe('text');
  });

  it('keeps every date as timestamptz so no reader has to guess a timezone', async () => {
    const cols = (
      await db.execute<{ table_name: string; column_name: string; data_type: string }>(
        sql`select table_name, column_name, data_type from information_schema.columns
             where table_schema = 'public'
               and (column_name like '%_date' or column_name like '%_at' or column_name = 'timestamp')`,
      )
    ).rows;
    expect(cols.length).toBeGreaterThan(30);
    const wrong = cols
      .filter((c) => c.data_type !== 'timestamp with time zone')
      .map((c) => `${c.table_name}.${c.column_name} is ${c.data_type}`);
    expect(wrong, wrong.join('; ')).toEqual([]);
  });

  it('indexed every column the list screens filter on', async () => {
    const idx = (
      await db.execute<{ indexname: string }>(
        sql`select indexname from pg_indexes where schemaname = 'public'`,
      )
    ).rows.map((r) => r.indexname);
    for (const expected of [
      'goals_project_ix',
      'goals_period_ix',
      'goals_completion_ix',
      'goals_expected_ix',
      'deliverables_project_ix',
      'deliverables_completion_ix',
      'deliverables_expected_ix',
      'drawings_project_ix',
      'drawings_completion_ix',
      'audit_time_ix',
      'reschedule_changed_ix',
    ]) {
      expect(idx, `missing index ${expected}`).toContain(expected);
    }
  });

  it('every completed record has an actual date, and none of the open ones do', async () => {
    const [{ n: badCompleted }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(deliverables)
      .where(and(eq(deliverables.completionStatus, 'COMPLETED'), isNull(deliverables.actualReleaseDate)));
    expect(Number(badCompleted)).toBe(0);
    const [{ n: badOpen }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(deliverables)
      .where(and(eq(deliverables.completionStatus, 'NOT_COMPLETED'), sql`${deliverables.actualReleaseDate} is not null`));
    expect(Number(badOpen)).toBe(0);
  });
});

describe('Violet Hill pilot', () => {
  it('exists as an ordinary project row with packages, deliverables and drawings', async () => {
    const [vh] = await db.select().from(projects).where(eq(projects.projectCode, 'VIOLET-HILL')).limit(1);
    expect(vh).toBeTruthy();
    const pk = await db.select().from(packages).where(eq(packages.projectId, vh.id));
    const dl = await db.select().from(deliverables).where(eq(deliverables.projectId, vh.id));
    const dw = await db.select().from(drawings).where(eq(drawings.projectId, vh.id));
    expect(pk.length).toBeGreaterThan(20);
    expect(dl.length).toBeGreaterThan(150);
    expect(dw.length).toBeGreaterThan(80);
    expect(pk.every((p) => p.baselineReleaseDate !== null)).toBe(true);
  });

  it('mapped the batch numbering onto the same packages as the fee schedule', async () => {
    const [vh] = await db.select().from(projects).where(eq(projects.projectCode, 'VIOLET-HILL')).limit(1);
    const pk = await db.select().from(packages).where(eq(packages.projectId, vh.id));
    const grading = pk.find((p) => /infra - grading/i.test(p.packageName));
    expect(grading).toBeTruthy();
    expect(grading!.packageCode).toBe('MP 01');
    expect(grading!.durationDays).toBe(30); // duration comes from the batch sheet
    const fees = await db.select().from(packageFees).where(eq(packageFees.packageId, grading!.id));
    expect(fees.length).toBeGreaterThan(0);
  });

  it('contains no project-specific hard-coded logic anywhere in src/', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
      }
    };
    walk(path.resolve(process.cwd(), 'src'));
    expect(files.length).toBeGreaterThan(20);

    // Any comparison of a project name/code to a literal would be a branch on
    // one particular project. The Schedule screen is allowed to *default* its
    // dropdown to a project code, which is data selection, not business logic.
    const offenders: string[] = [];
    const pattern =
      /(project(?:Name|Code)?\s*={2,3}\s*['"`])|(['"`](?:violet\s*hill|atr|itqe|poarr)['"`]\s*={2,3})|(switch\s*\(\s*project)/gi;
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const line of text.split('\n')) {
        if (pattern.test(line)) {
          if (/projectCode === 'VIOLET-HILL'/.test(line) && /schedule\/page\.tsx$/.test(file)) continue;
          offenders.push(`${path.relative(process.cwd(), file)}: ${line.trim()}`);
        }
        pattern.lastIndex = 0;
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
