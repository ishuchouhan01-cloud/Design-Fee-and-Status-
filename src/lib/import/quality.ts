/**
 * Data-quality scan (spec §31). Runs after every import and is also exposed on
 * the Settings screen so the checks stay visible rather than being a one-off
 * migration artefact.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { deliverables, drawings, goals, projects } from '@/db/schema';
import type { ImportLogger } from './logger';

export interface QualityFinding {
  code: string;
  severity: 'INFO' | 'WARNING' | 'ERROR';
  message: string;
  count: number;
  sample?: string[];
}

export async function runDataQualityChecks(): Promise<QualityFinding[]> {
  const findings: QualityFinding[] = [];

  const dupProjects = await db
    .select({ name: sql<string>`upper(trim(${projects.projectName}))`, n: sql<number>`count(*)::int` })
    .from(projects)
    .groupBy(sql`upper(trim(${projects.projectName}))`)
    .having(sql`count(*) > 1`);
  if (dupProjects.length) {
    findings.push({
      code: 'DUPLICATE_PROJECT_NAME',
      severity: 'WARNING',
      message: 'Projects whose names differ only by case or spacing',
      count: dupProjects.length,
      sample: dupProjects.slice(0, 10).map((r) => `${r.name} ×${r.n}`),
    });
  }

  const dupGoals = await db
    .select({
      key: sql<string>`${goals.projectId} || '|' || coalesce(${goals.phaseId},'') || '|' || coalesce(${goals.disciplineId},'') || '|' || ${goals.fiscalYear} || '|' || ${goals.quarter} || '|' || upper(trim(${goals.goalDescription}))`,
      n: sql<number>`count(*)::int`,
    })
    .from(goals)
    .groupBy(
      sql`${goals.projectId}, coalesce(${goals.phaseId},''), coalesce(${goals.disciplineId},''), ${goals.fiscalYear}, ${goals.quarter}, upper(trim(${goals.goalDescription}))`,
    )
    .having(sql`count(*) > 1`);
  if (dupGoals.length) {
    findings.push({
      code: 'DUPLICATE_GOAL',
      severity: 'WARNING',
      message: 'Goals identical on project, phase, discipline, period and description',
      count: dupGoals.length,
      sample: dupGoals.slice(0, 10).map((r) => `${r.key} ×${r.n}`),
    });
  }

  const dupDrawings = await db
    .select({
      key: sql<string>`${drawings.projectId} || '|' || upper(trim(${drawings.drawingCode}))`,
      n: sql<number>`count(*)::int`,
    })
    .from(drawings)
    .groupBy(sql`${drawings.projectId}, upper(trim(${drawings.drawingCode}))`)
    .having(sql`count(*) > 1`);
  if (dupDrawings.length) {
    findings.push({
      code: 'DUPLICATE_DRAWING_CODE',
      severity: 'WARNING',
      message: 'Same drawing number appearing more than once in a project (usually a re-issue in a different batch)',
      count: dupDrawings.length,
      sample: dupDrawings.slice(0, 10).map((r) => `${r.key} ×${r.n}`),
    });
  }

  const noDate = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(drawings)
    .where(isNull(drawings.baselineReleaseDate));
  if (Number(noDate[0]?.n ?? 0) > 0) {
    const sample = await db
      .select({ code: drawings.drawingCode })
      .from(drawings)
      .where(isNull(drawings.baselineReleaseDate))
      .limit(10);
    findings.push({
      code: 'DRAWING_NO_BASELINE_DATE',
      severity: 'INFO',
      message: 'Drawings with no planned release quarter in the source register (baseline not set)',
      count: Number(noDate[0].n),
      sample: sample.map((s) => s.code),
    });
  }

  // A released drawing with no actual date is legitimate when the source gives
  // release evidence instead of a date ("Issued before 01-Jan-2026"): it is
  // reported as INFO under a drawing-specific code. Only a release with neither
  // a date nor evidence is a WARNING.
  const [releasedNoDate] = await db
    .select({
      withEvidence: sql<number>`count(*) filter (where ${drawings.releaseEvidence} is not null)::int`,
      withoutEvidence: sql<number>`count(*) filter (where ${drawings.releaseEvidence} is null)::int`,
    })
    .from(drawings)
    .where(and(eq(drawings.completionStatus, 'COMPLETED'), isNull(drawings.actualReleaseDate)));
  if (Number(releasedNoDate?.withEvidence ?? 0) > 0) {
    findings.push({
      code: 'DRAWING_RELEASED_DATE_NOT_RECORDED',
      severity: 'INFO',
      message: 'Released drawings whose source gives release evidence (e.g. "Issued before 01-Jan-2026") but no actual release date',
      count: Number(releasedNoDate.withEvidence),
    });
  }
  if (Number(releasedNoDate?.withoutEvidence ?? 0) > 0) {
    const sample = await db
      .select({ code: drawings.drawingCode })
      .from(drawings)
      .where(and(eq(drawings.completionStatus, 'COMPLETED'), isNull(drawings.actualReleaseDate), isNull(drawings.releaseEvidence)))
      .limit(10);
    findings.push({
      code: 'DRAWING_RELEASED_NO_DATE_NO_EVIDENCE',
      severity: 'WARNING',
      message: 'Released drawings with neither an actual release date nor release evidence',
      count: Number(releasedNoDate.withoutEvidence),
      sample: sample.map((r) => r.code),
    });
  }

  const deliverableNoPackage = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(deliverables)
    .where(isNull(deliverables.packageId));
  if (Number(deliverableNoPackage[0]?.n ?? 0) > 0) {
    findings.push({
      code: 'DELIVERABLE_NO_PACKAGE',
      severity: 'INFO',
      message: 'Design deliverables not attached to a package (unit-level interior design records, or rows outside a batch block)',
      count: Number(deliverableNoPackage[0].n),
    });
  }

  const goalNoDiscipline = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(goals)
    .where(isNull(goals.disciplineId));
  if (Number(goalNoDiscipline[0]?.n ?? 0) > 0) {
    findings.push({
      code: 'GOAL_NO_DISCIPLINE',
      severity: 'WARNING',
      message: 'Goals with no recognised discipline',
      count: Number(goalNoDiscipline[0].n),
    });
  }

  const revised = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(goals)
    .where(eq(goals.isBaselineRevision, true));
  if (Number(revised[0]?.n ?? 0) > 0) {
    findings.push({
      code: 'REVISED_PLAN_GOALS',
      severity: 'INFO',
      message: 'Goals whose plan came from a revised-plan sheet. Both the original commitment and the revision are retained.',
      count: Number(revised[0].n),
    });
  }

  const inconsistentDates = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(drawings)
    .where(sql`${drawings.actualReleaseDate} is not null and ${drawings.completionStatus} = 'NOT_COMPLETED'`);
  if (Number(inconsistentDates[0]?.n ?? 0) > 0) {
    findings.push({
      code: 'DRAWING_ACTUAL_DATE_WITHOUT_RELEASE',
      severity: 'WARNING',
      message: 'Drawings carrying an actual release date while still NOT RELEASED',
      count: Number(inconsistentDates[0].n),
    });
  }

  return findings;
}

export async function logDataQuality(log: ImportLogger) {
  const findings = await runDataQualityChecks();
  for (const f of findings) {
    log.add({
      severity: f.severity,
      code: `DQ_${f.code}`,
      message: `${f.message} — ${f.count} case(s)${f.sample?.length ? `; e.g. ${f.sample.slice(0, 5).join(', ')}` : ''}`,
    });
  }
  return findings;
}
