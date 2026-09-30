/**
 * Programme (Gantt) data. Three bars per row — baseline, current expected and
 * actual — plus the links between rows. Deliberately not a CPM engine.
 */
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { deliverables, dependencies, drawings, packages } from '@/db/schema';
import { addDays, diffDays } from '@/lib/periods';
import { assessSchedule } from '@/lib/schedule';
import type { EntityType, ScheduleStatus } from '@/lib/domain';

export interface GanttBar {
  entityType: EntityType;
  entityId: string;
  code: string;
  label: string;
  group: string;
  baselineStart: Date | null;
  baselineFinish: Date | null;
  expectedStart: Date | null;
  expectedFinish: Date | null;
  actualFinish: Date | null;
  completionStatus: string;
  scheduleStatus: ScheduleStatus;
  slipDays: number;
  rescheduleCount: number;
  durationDays: number;
}

export interface GanttLink {
  predecessorType: EntityType;
  predecessorId: string;
  successorType: EntityType;
  successorId: string;
  dependencyType: string;
  lagDays: number;
}

export interface GanttData {
  bars: GanttBar[];
  links: GanttLink[];
  windowStart: Date | null;
  windowEnd: Date | null;
}

export async function buildGantt(opts: {
  projectId: string;
  include?: ('PACKAGE' | 'DELIVERABLE' | 'DRAWING')[];
  limit?: number;
}): Promise<GanttData> {
  const include = opts.include ?? ['PACKAGE', 'DELIVERABLE'];
  const limit = opts.limit ?? 250;
  const bars: GanttBar[] = [];

  if (include.includes('PACKAGE')) {
    const rows = await db.select().from(packages).where(eq(packages.projectId, opts.projectId));
    for (const p of rows) {
      const duration = p.durationDays ?? 15;
      const a = assessSchedule({
        completionStatus: p.actualReleaseDate ? 'COMPLETED' : 'NOT_COMPLETED',
        baselineDate: p.baselineReleaseDate,
        expectedDate: p.currentExpectedReleaseDate,
        actualDate: p.actualReleaseDate,
        rescheduleCount: p.rescheduleCount,
      });
      bars.push({
        entityType: 'PACKAGE',
        entityId: p.id,
        code: p.packageCode,
        label: p.packageName,
        group: p.packageGroup ?? 'Packages',
        baselineStart: p.baselineStartDate ?? (p.baselineReleaseDate ? addDays(p.baselineReleaseDate, -duration) : null),
        baselineFinish: p.baselineReleaseDate,
        expectedStart: p.currentExpectedReleaseDate ? addDays(p.currentExpectedReleaseDate, -duration) : null,
        expectedFinish: p.currentExpectedReleaseDate,
        actualFinish: p.actualReleaseDate,
        completionStatus: p.actualReleaseDate ? 'COMPLETED' : 'NOT_COMPLETED',
        scheduleStatus: a.status,
        slipDays: a.slipDays,
        rescheduleCount: p.rescheduleCount,
        durationDays: duration,
      });
    }
  }

  if (include.includes('DELIVERABLE')) {
    const rows = await db
      .select()
      .from(deliverables)
      .where(eq(deliverables.projectId, opts.projectId))
      .limit(limit);
    for (const d of rows) {
      const a = assessSchedule({
        completionStatus: d.completionStatus,
        baselineDate: d.baselineReleaseDate,
        expectedDate: d.currentExpectedReleaseDate,
        actualDate: d.actualReleaseDate,
        rescheduleCount: d.rescheduleCount,
      });
      bars.push({
        entityType: 'DELIVERABLE',
        entityId: d.id,
        code: d.deliverableCode,
        label: d.deliverableDescription,
        group: 'Design deliverables',
        baselineStart: d.baselineReleaseDate,
        baselineFinish: d.baselineReleaseDate,
        expectedStart: d.currentExpectedReleaseDate,
        expectedFinish: d.currentExpectedReleaseDate,
        actualFinish: d.actualReleaseDate,
        completionStatus: d.completionStatus,
        scheduleStatus: a.status,
        slipDays: a.slipDays,
        rescheduleCount: d.rescheduleCount,
        durationDays: 0,
      });
    }
  }

  if (include.includes('DRAWING')) {
    const rows = await db.select().from(drawings).where(eq(drawings.projectId, opts.projectId)).limit(limit);
    for (const d of rows) {
      const a = assessSchedule({
        completionStatus: d.completionStatus,
        baselineDate: d.baselineReleaseDate,
        expectedDate: d.currentExpectedReleaseDate,
        actualDate: d.actualReleaseDate,
        rescheduleCount: d.rescheduleCount,
      });
      bars.push({
        entityType: 'DRAWING',
        entityId: d.id,
        code: d.drawingCode,
        label: d.drawingName,
        group: 'Drawings',
        baselineStart: d.baselineReleaseDate,
        baselineFinish: d.baselineReleaseDate,
        expectedStart: d.currentExpectedReleaseDate,
        expectedFinish: d.currentExpectedReleaseDate,
        actualFinish: d.actualReleaseDate,
        completionStatus: d.completionStatus,
        scheduleStatus: a.status,
        slipDays: a.slipDays,
        rescheduleCount: d.rescheduleCount,
        durationDays: 0,
      });
    }
  }

  const ids = bars.map((b) => b.entityId);
  const links: GanttLink[] = ids.length
    ? (
        await db
          .select()
          .from(dependencies)
          .where(inArray(dependencies.predecessorId, ids))
      )
        .filter((l) => ids.includes(l.successorId))
        .map((l) => ({
          predecessorType: l.predecessorType as EntityType,
          predecessorId: l.predecessorId,
          successorType: l.successorType as EntityType,
          successorId: l.successorId,
          dependencyType: l.dependencyType,
          lagDays: l.lagDays,
        }))
    : [];

  const allDates = bars
    .flatMap((b) => [b.baselineStart, b.baselineFinish, b.expectedStart, b.expectedFinish, b.actualFinish])
    .filter((d): d is Date => Boolean(d));
  const windowStart = allDates.length ? new Date(Math.min(...allDates.map((d) => d.getTime()))) : null;
  const windowEnd = allDates.length ? new Date(Math.max(...allDates.map((d) => d.getTime()))) : null;

  bars.sort(
    (a, b) =>
      (a.baselineFinish?.getTime() ?? a.expectedFinish?.getTime() ?? 0) -
      (b.baselineFinish?.getTime() ?? b.expectedFinish?.getTime() ?? 0),
  );

  return { bars, links, windowStart, windowEnd };
}

export { diffDays };
