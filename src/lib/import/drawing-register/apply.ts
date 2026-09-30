/**
 * Writes an import plan to the database — or, in preview, works out exactly
 * what it would write without writing any drawing data.
 *
 * Rules the writer enforces (Stage 2 decisions):
 *   - one drawing per project + drawing number; a not-yet-numbered drawing is
 *     found again by its source key, and is promoted — not duplicated — when
 *     the source later gives it a number;
 *   - a field listed in `user_edited_fields` is never overwritten; a differing
 *     source value is logged as FIELD_PROTECTED_USER_EDIT;
 *   - a baseline is set once and never changed;
 *   - an expected-date change goes through the reschedule engine's write path
 *     (`writeRescheduleChange`), so it leaves history and audit; released
 *     drawings are never moved;
 *   - an actual release date is only ever filled from the source when empty,
 *     never replaced, and never invented;
 *   - revision rows are only ever added;
 *   - historical snapshots never overwrite the current record.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { sourceDating } from '@/lib/updated-on';
import { db, type DbLike } from '@/db';
import {
  disciplines,
  drawingConflicts,
  drawingImportBatches,
  drawingImportIssues,
  drawingLocationPhaseMap,
  drawingRevisions,
  drawingSnapshots,
  drawings,
  packageFees,
  dfsWbsNodes,
  importRunChanges,
  packages,
  projectPhases,
  projects,
} from '@/db/schema';
import { recordAudit, type Actor } from '@/lib/audit';
import { parseEditedFields } from '@/lib/domain';
import { newId } from '@/lib/ids';
import { diffDays } from '@/lib/periods';
import { recordRescheduleHistory, writeRescheduleChange } from '@/lib/reschedule';
import { manifestProjectCodes, type DrawingManifest } from './manifest';
import { packageCodeForBatch } from './design-fee';
import {
  headingResolver,
  normTitle,
  numberKey,
  planMoves,
  type ImportPlan,
  type PlanIssue,
  type PlannedDrawing,
} from './plan';

type DrawingRow = typeof drawings.$inferSelect;

export interface ReferenceIds {
  projectId: Map<string, string>;
  phaseId: Map<string, string>; // `${projectCode}|${phaseCode}`
  disciplineId: Map<string, string>;
  disciplineCode: Map<string, string>; // id → code
  /** `${projectCode}|${packageCode}` → package id (existing packages). */
  packageId: Map<string, string>;
}

export async function loadReferences(manifest: DrawingManifest, tx: DbLike = db): Promise<ReferenceIds> {
  const codes = manifestProjectCodes(manifest);
  const prj = await tx.select().from(projects).where(inArray(projects.projectCode, codes));
  const projectId = new Map(prj.map((p) => [p.projectCode, p.id]));
  const missing = codes.filter((c) => !projectId.has(c));
  if (missing.length) throw new Error(`Projects not found for drawing import: ${missing.join(', ')}`);
  const ph = prj.length ? await tx.select().from(projectPhases).where(inArray(projectPhases.projectId, prj.map((p) => p.id))) : [];
  const codeOf = new Map(prj.map((p) => [p.id, p.projectCode]));
  const phaseId = new Map(ph.map((x) => [`${codeOf.get(x.projectId)}|${x.code}`, x.id]));
  const ds = await tx.select().from(disciplines);
  const pk = prj.length ? await tx.select().from(packages).where(inArray(packages.projectId, prj.map((p) => p.id))) : [];
  return {
    projectId,
    phaseId,
    disciplineId: new Map(ds.map((d) => [d.code, d.id])),
    disciplineCode: new Map(ds.map((d) => [d.id, d.code])),
    // By the code in the database and by the code the source gave (a code changed in Edit Mode).
    packageId: new Map(pk.flatMap((x) => [[`${codeOf.get(x.projectId)}|${x.sourceCode ?? x.packageCode}`, x.id] as [string, string], [`${codeOf.get(x.projectId)}|${x.packageCode}`, x.id] as [string, string]])),
  };
}

/** A package not in the database yet (preview) is compared by a stable placeholder. */
function packageIdOf(d: PlannedDrawing, ref: ReferenceIds): string | null {
  if (!d.packageCode) return null;
  return ref.packageId.get(`${d.projectCode}|${d.packageCode}`) ?? `new:${d.packageCode}`;
}

// ---------------------------------------------------------------------------
// Diff: what the import would do to each drawing
// ---------------------------------------------------------------------------

export interface FieldChange {
  field: keyof DrawingRow;
  from: unknown;
  to: unknown;
}

export interface DrawingAction {
  planned: PlannedDrawing;
  existing: DrawingRow | null;
  kind: 'CREATE' | 'UPDATE' | 'UNCHANGED';
  promoted: boolean;
  changes: FieldChange[];
  protectedChanges: FieldChange[];
  expectedMove: { from: Date | null; to: Date } | null;
  release: { actual: Date | null } | null;
  newRevision: string | null;
  notes: PlanIssue[];
}

function same(a: unknown, b: unknown) {
  if (a instanceof Date || b instanceof Date) {
    const x = a instanceof Date ? a.getTime() : a == null ? null : new Date(a as string).getTime();
    const y = b instanceof Date ? b.getTime() : b == null ? null : new Date(b as string).getTime();
    return x === y;
  }
  return (a ?? null) === (b ?? null);
}

function plannedValues(d: PlannedDrawing, ref: ReferenceIds) {
  return {
    drawingName: d.drawingName,
    drawingNumber: d.drawingNumber,
    partialNumber: d.partialNumber,
    disciplineId: ref.disciplineId.get(d.discipline) ?? null,
    phaseId: d.phaseCode ? (ref.phaseId.get(`${d.projectCode}|${d.phaseCode}`) ?? null) : null,
    location: d.location,
    areaOfWorks: d.areaOfWorks,
    batchCode: d.batchCode,
    batch: d.batch,
    packageId: packageIdOf(d, ref),
    collection: d.collection,
    versionCount: d.versionCount,
    tags: d.tags,
    accDiscipline: d.accDiscipline,
    accCreatedAt: d.accCreatedAt,
    planPeriodLabel: d.planPeriodLabel,
    // "Updated On" as the source gives it (never the time this import ran).
    ...sourceDating(d.actualReleaseDate, d.releaseEvidence, d.sourceRevisionDate),
    // Responsible Person only when the source has it; a person's edit is kept (user_edited_fields).
    ...(d.responsibleText ? { responsibleText: d.responsibleText } : {}),
    sourceWorkbook: d.ref.workbook,
    sourceSheet: d.ref.sheet,
    sourceRow: d.ref.row,
  } satisfies Partial<DrawingRow>;
}

/** Fields the importer never writes into a user-protected column. Source
 *  traceability columns are not user-editable, so always refresh. */
/** A field value as text (dates as ISO), for import_run_changes. */
export function textOf(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

const TRACE_FIELDS = new Set(['sourceDate', 'sourcePeriodLabel', 'sourcePeriodStart', 'sourcePeriodEnd', 'sourceWorkbook', 'sourceSheet', 'sourceRow', 'collection', 'versionCount', 'tags', 'accDiscipline', 'accCreatedAt', 'planPeriodLabel', 'partialNumber']);

export function computeActions(plan: ImportPlan, existing: DrawingRow[], ref: ReferenceIds): DrawingAction[] {
  const projectCodeOf = new Map([...ref.projectId].map(([code, id]) => [id, code]));
  const byCode = new Map<string, DrawingRow>();
  const byKey = new Map<string, DrawingRow>();
  for (const e of existing) {
    const pc = projectCodeOf.get(e.projectId)!;
    byCode.set(`${pc}|${e.drawingCode}`, e);
    if (e.sourceKey) byKey.set(`${pc}|${e.sourceKey}`, e);
  }
  const plannedKeys = new Set(plan.drawings.map((d) => `${d.projectCode}|${d.sourceKey}`));
  // Not-yet-numbered drawings whose key is gone from the source: candidates
  // for promotion when the source now lists the same drawing with a number.
  const orphanNyn = existing.filter(
    (e) => e.numberStatus === 'NOT_YET_NUMBERED' && e.sourceKey?.startsWith('NYN:') && !plannedKeys.has(`${projectCodeOf.get(e.projectId)}|${e.sourceKey}`),
  );
  const used = new Set<string>();
  const direct = (d: ImportPlan['drawings'][number]) =>
    (d.numberStatus === 'NUMBERED' ? byCode.get(`${d.projectCode}|${d.drawingCode}`) : undefined) ?? byKey.get(`${d.projectCode}|${d.sourceKey}`) ?? null;
  // Drawings written before the register importer carry no source key. One
  // that no code or key matches is adopted by a planned drawing of the same
  // project with the same title — only when that title is unique on both sides.
  const legacy = new Map<string, DrawingRow>();
  {
    const directIds = new Set(plan.drawings.map(direct).filter(Boolean).map((e) => e!.id));
    const tally = <T,>(xs: T[], k: (x: T) => string) => {
      const m = new Map<string, T[]>();
      for (const x of xs) m.set(k(x), [...(m.get(k(x)) ?? []), x]);
      return m;
    };
    const olds = tally(
      existing.filter((e) => !e.sourceKey && !directIds.has(e.id)),
      (e) => `${projectCodeOf.get(e.projectId)}|${normTitle(e.drawingName)}`,
    );
    const news = tally(
      plan.drawings.filter((d) => !direct(d)),
      (d) => `${d.projectCode}|${normTitle(d.drawingName)}`,
    );
    for (const [k, ds] of news) {
      const es = olds.get(k);
      if (ds.length === 1 && es?.length === 1 && normTitle(ds[0].drawingName)) legacy.set(`${ds[0].projectCode}|${ds[0].sourceKey}`, es[0]);
    }
  }

  return plan.drawings.map((d) => {
    let match = direct(d) ?? legacy.get(`${d.projectCode}|${d.sourceKey}`) ?? null;
    const adopted = !!match && !direct(d);
    let promoted = false;
    if (!match && d.numberStatus === 'NUMBERED') {
      const cands = orphanNyn.filter((e) => {
        if (used.has(e.id) || projectCodeOf.get(e.projectId) !== d.projectCode) return false;
        const [disc, batch, title] = e.sourceKey!.slice(4).split('|');
        return disc === d.discipline && batch === (d.batchCode ?? '') && title === normTitle(d.drawingName);
      });
      if (cands.length === 1) {
        match = cands[0];
        promoted = true;
        used.add(match.id);
      }
    }
    if (match) used.add(match.id);
    if (!match) {
      return { planned: d, existing: null, kind: 'CREATE', promoted: false, changes: [], protectedChanges: [], expectedMove: null, release: null, newRevision: null, notes: [] };
    }

    const edited = parseEditedFields(match.userEditedFields);
    const changes: FieldChange[] = [];
    const protectedChanges: FieldChange[] = [];
    const notes: PlanIssue[] = [];
    const consider = (field: keyof DrawingRow, to: unknown) => {
      const from = match![field];
      if (same(from, to)) return;
      if (edited.has(field as string) && !TRACE_FIELDS.has(field as string)) protectedChanges.push({ field, from, to });
      else changes.push({ field, from, to });
    };

    for (const [field, to] of Object.entries(plannedValues(d, ref))) consider(field as keyof DrawingRow, to);
    // A legacy code that is formula text ("=CONCATENATE(…)") was never a number.
    if (adopted && /^=/.test(match.drawingCode)) {
      consider('drawingCode', d.drawingCode);
      consider('numberStatus', d.numberStatus);
    }
    if (promoted || (match.numberStatus === 'NOT_YET_NUMBERED' && d.numberStatus === 'NUMBERED')) {
      consider('drawingCode', d.drawingCode);
      consider('numberStatus', 'NUMBERED');
    }
    if (!match.sourceKey || promoted) changes.push({ field: 'sourceKey', from: match.sourceKey, to: d.sourceKey });
    // Baseline: set once, never changed.
    if (!match.baselineReleaseDate && d.baselineReleaseDate) changes.push({ field: 'baselineReleaseDate', from: null, to: d.baselineReleaseDate });

    // Release status and actual date.
    let release: DrawingAction['release'] = null;
    if (match.completionStatus === 'NOT_COMPLETED' && d.released) {
      if (edited.has('completionStatus')) protectedChanges.push({ field: 'completionStatus', from: 'NOT_COMPLETED', to: 'COMPLETED' });
      else release = { actual: edited.has('actualReleaseDate') ? match.actualReleaseDate : d.actualReleaseDate };
    } else if (match.completionStatus === 'COMPLETED' && !d.released) {
      notes.push({
        severity: 'WARNING',
        code: 'SOURCE_SHOWS_NOT_RELEASED',
        projectCode: d.projectCode,
        drawingNumber: d.drawingNumber,
        message: `${match.drawingCode} is released in the database but not in the source. Kept as released — a release is never undone by an import.`,
      });
    } else if (match.completionStatus === 'COMPLETED' && d.actualReleaseDate) {
      if (!match.actualReleaseDate && !edited.has('actualReleaseDate')) changes.push({ field: 'actualReleaseDate', from: null, to: d.actualReleaseDate });
      else if (match.actualReleaseDate && !same(match.actualReleaseDate, d.actualReleaseDate) && !edited.has('actualReleaseDate') && !match.releasedById) {
        // The source's date wins over one an earlier import stored (nobody set it in Drawing Control).
        changes.push({ field: 'actualReleaseDate', from: match.actualReleaseDate, to: d.actualReleaseDate });
      } else if (match.actualReleaseDate && !same(match.actualReleaseDate, d.actualReleaseDate)) {
        notes.push({
          severity: 'INFO',
          code: 'ACTUAL_DATE_KEPT',
          projectCode: d.projectCode,
          drawingNumber: d.drawingNumber,
          message: `${match.drawingCode}: actual release date kept (${match.actualReleaseDate.toISOString().slice(0, 10)}); source says ${d.actualReleaseDate.toISOString().slice(0, 10)}.`,
        });
      }
    }
    if (d.released && d.releaseEvidence && !match.releaseEvidence && !match.actualReleaseDate) {
      changes.push({ field: 'releaseEvidence', from: null, to: d.releaseEvidence });
    }

    // Expected date: through the reschedule write path; released drawings never move.
    let expectedMove: DrawingAction['expectedMove'] = null;
    const stillOpen = match.completionStatus === 'NOT_COMPLETED' && !release;
    if (d.currentExpectedReleaseDate && !same(match.currentExpectedReleaseDate, d.currentExpectedReleaseDate)) {
      if (edited.has('currentExpectedReleaseDate')) {
        protectedChanges.push({ field: 'currentExpectedReleaseDate', from: match.currentExpectedReleaseDate, to: d.currentExpectedReleaseDate });
      } else if (stillOpen) {
        expectedMove = { from: match.currentExpectedReleaseDate, to: d.currentExpectedReleaseDate };
      }
    }

    // Revision: a changed revision adds a revision row; nothing is replaced.
    let newRevision: string | null = null;
    if (d.revision && d.revision !== match.revision) {
      if (edited.has('revision')) protectedChanges.push({ field: 'revision', from: match.revision, to: d.revision });
      else {
        newRevision = d.revision;
        changes.push({ field: 'revision', from: match.revision, to: d.revision });
      }
    }

    const kind = changes.length || release || expectedMove || newRevision ? 'UPDATE' : 'UNCHANGED';
    return { planned: d, existing: match, kind, promoted, changes, protectedChanges, expectedMove, release, newRevision, notes };
  });
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const IMPORT_LABEL = 'Drawing import (source snapshots)';

export interface ApplyStats {
  created: number;
  updated: number;
  unchanged: number;
  promoted: number;
  protectedFields: number;
  expectedMoves: number;
  releases: number;
  revisionsAdded: number;
  planMovesRecorded: number;
  snapshots: number;
  conflictsOpen: number;
  conflictsResolved: number;
  /** Existing drawings re-linked to a package by a base DFS imported on its own. */
  relinked?: number;
}

export async function applyPlan(
  tx: DbLike,
  args: {
    batchId: string;
    manifest: DrawingManifest;
    plan: ImportPlan;
    ref: ReferenceIds;
    actor: Actor;
    issues: PlanIssue[];
  },
): Promise<ApplyStats & { actions: DrawingAction[] }> {
  const { batchId, plan, ref, actor, issues } = args;
  const stamp = new Date();
  const stats: ApplyStats = {
    created: 0,
    updated: 0,
    unchanged: 0,
    promoted: 0,
    protectedFields: 0,
    expectedMoves: 0,
    releases: 0,
    revisionsAdded: 0,
    planMovesRecorded: 0,
    snapshots: 0,
    conflictsOpen: 0,
    conflictsResolved: 0,
  };

  // 1. The explicit location → phase map, as data.
  for (const { projectCode, entry } of plan.phaseMap) {
    const projectId = ref.projectId.get(projectCode)!;
    const phaseId = entry.phase ? (ref.phaseId.get(`${projectCode}|${entry.phase}`) ?? null) : null;
    if (entry.phase && !phaseId) throw new Error(`Phase map: phase "${entry.phase}" does not exist in ${projectCode}`);
    await tx
      .insert(drawingLocationPhaseMap)
      .values({
        id: newId('dlp_'),
        projectId,
        locationCode: entry.location,
        zoneCode: entry.zone ?? '',
        phaseId,
        rule: entry.rule,
        note: entry.note ?? null,
        updatedAt: stamp,
      })
      .onConflictDoUpdate({
        target: [drawingLocationPhaseMap.projectId, drawingLocationPhaseMap.locationCode, drawingLocationPhaseMap.zoneCode],
        set: { phaseId, rule: entry.rule, note: entry.note ?? null, updatedAt: stamp },
      });
  }

  // 1a. The base-DFS tree above packages (Tower / Product / Block / Villa /
  //     group headings), parents first, keyed on the source path so a
  //     re-import updates the same node. A name a user changed is kept.
  const nodeId = new Map<string, string>(); // `${projectCode}|${key}` → id
  for (const n of plan.wbsNodes ?? []) {
    const projectId = ref.projectId.get(n.projectCode)!;
    const parentId = n.parentKey ? (nodeId.get(`${n.projectCode}|${n.parentKey}`) ?? null) : null;
    const [row] = await tx
      .insert(dfsWbsNodes)
      .values({
        id: newId('wbs_'),
        projectId,
        parentId,
        nodeType: n.type,
        name: n.name,
        code: n.code,
        sourceLabel: n.sourceLabel,
        nodeKey: n.key,
        sequence: n.sequence,
        sourceWorkbook: n.ref.workbook,
        sourceSheet: n.ref.sheet,
        sourceRow: n.ref.row,
        importBatchId: batchId,
        createdImportBatchId: batchId,
        updatedAt: stamp,
      })
      .onConflictDoUpdate({
        target: [dfsWbsNodes.projectId, dfsWbsNodes.nodeKey],
        set: {
          parentId,
          nodeType: n.type,
          name: sql`case when position('name' in ${dfsWbsNodes.userEditedFields}) > 0 then ${dfsWbsNodes.name} else ${n.name} end`,
          code: n.code,
          sourceLabel: n.sourceLabel,
          sequence: n.sequence,
          sourceWorkbook: n.ref.workbook,
          sourceSheet: n.ref.sheet,
          sourceRow: n.ref.row,
          importBatchId: batchId,
          updatedAt: stamp,
        },
      })
      .returning({ id: dfsWbsNodes.id });
    nodeId.set(`${n.projectCode}|${n.key}`, row.id);
  }

  // 1b. Fee packages (existing `packages` table) and their per-discipline
  //     billing scope (existing `package_fees`). A field an admin changed
  //     (applicability) is kept.
  for (const p of plan.packages) {
    const projectId = ref.projectId.get(p.projectCode)!;
    const phaseId = p.phaseCode ? (ref.phaseId.get(`${p.projectCode}|${p.phaseCode}`) ?? null) : null;
    const wbsNodeId = p.nodeKey ? (nodeId.get(`${p.projectCode}|${p.nodeKey}`) ?? null) : null;
    // The package is found by the code its source gave it, so a code changed in
    // Edit Mode is still the same package. A field a person changed is kept.
    const [found] = await tx
      .select({ id: packages.id, edited: packages.userEditedFields, responsibleUserId: packages.responsibleUserId, responsibleText: packages.responsibleText })
      .from(packages)
      .where(and(eq(packages.projectId, projectId), sql`coalesce(${packages.sourceCode}, ${packages.packageCode}) = ${p.code}`))
      .limit(1);
    let row: { id: string };
    if (found) {
      const edited = new Set(found.edited.split(',').filter(Boolean));
      const set: Record<string, unknown> = {
        packageGroup: p.group,
        sequence: p.sequence,
        phaseId,
        wbsNodeId,
        sourceCode: p.code,
        sourceWorkbook: p.ref.workbook,
        sourceSheet: p.ref.sheet,
        sourceRow: p.ref.row,
        importBatchId: batchId,
        updatedAt: stamp,
      };
      if (!edited.has('packageName')) set.packageName = p.name;
      if (p.responsible && !edited.has('responsible')) set.responsibleText = p.responsible;
      await tx.update(packages).set(set as never).where(eq(packages.id, found.id));
      row = found;
    } else {
      [row] = await tx
        .insert(packages)
        .values({
          id: newId('pk_'),
          projectId,
          phaseId,
          packageCode: p.code,
          sourceCode: p.code,
          packageName: p.name,
          packageGroup: p.group,
          sequence: p.sequence,
          responsibleText: p.responsible,
          sourceWorkbook: p.ref.workbook,
          sourceSheet: p.ref.sheet,
          sourceRow: p.ref.row,
          importBatchId: batchId,
          createdImportBatchId: batchId,
          wbsNodeId,
          updatedAt: stamp,
        })
        .returning({ id: packages.id });
    }
    ref.packageId.set(`${p.projectCode}|${p.code}`, row.id);
    for (const f of p.fees) {
      const disciplineId = ref.disciplineId.get(f.discipline);
      if (!disciplineId) continue;
      await tx
        .insert(packageFees)
        .values({
          id: newId('pf_'),
          packageId: row.id,
          disciplineId,
          feePercent: f.percent,
          feeValue: f.fee,
          billedToDateValue: f.billedToDate,
          applicability: f.applicability,
          sourceWorkbook: p.ref.workbook,
          sourceSheet: p.ref.sheet,
          sourceRow: p.ref.row,
          createdImportBatchId: batchId,
          updatedAt: stamp,
        })
        .onConflictDoUpdate({
          target: [packageFees.packageId, packageFees.disciplineId],
          set: {
            feePercent: f.percent,
            // Amounts a person set in Edit Mode (Billing) are kept.
            feeValue: sql`case when position('feeValue' in ${packageFees.userEditedFields}) > 0 then ${packageFees.feeValue} else ${f.fee} end`,
            billedToDateValue: sql`case when position('billedToDateValue' in ${packageFees.userEditedFields}) > 0 then ${packageFees.billedToDateValue} else ${f.billedToDate} end`,
            applicability: sql`case when position('applicability' in ${packageFees.userEditedFields}) > 0 then ${packageFees.applicability} else ${f.applicability} end`,
            sourceWorkbook: p.ref.workbook,
            sourceSheet: p.ref.sheet,
            sourceRow: p.ref.row,
            updatedAt: stamp,
          },
        });
    }
  }
  // Headings no longer in the base DFS (and holding no package) are removed.
  const dfsProjects = [...new Set((plan.wbsNodes ?? []).map((n) => ref.projectId.get(n.projectCode)!))];
  if (dfsProjects.length) {
    const keep = [...nodeId.values()];
    await tx.execute(sql`
      delete from dfs_wbs_nodes w
      where w.project_id in (${sql.join(dfsProjects.map((x) => sql`${x}`), sql`, `)})
        and w.id not in (${sql.join(keep.map((x) => sql`${x}`), sql`, `)})
        and not exists (select 1 from packages p where p.wbs_node_id = w.id)
        and not exists (select 1 from dfs_wbs_nodes c where c.parent_id = w.id)`);
  }
  const existing = await tx.select().from(drawings).where(inArray(drawings.projectId, [...ref.projectId.values()]));
  const actions = computeActions(plan, existing, ref);

  // 2. Drawings.
  const idFor = new Map<string, string>(); // `${projectCode}|${sourceKey}` → drawing id
  const toInsert: (typeof drawings.$inferInsert)[] = [];
  const revisionRows: (typeof drawingRevisions.$inferInsert)[] = [];
  const created: { id: string; d: PlannedDrawing }[] = [];

  for (const a of actions) {
    const d = a.planned;
    const projectId = ref.projectId.get(d.projectCode)!;
    if (a.kind === 'CREATE') {
      const id = newId('dw_');
      idFor.set(`${d.projectCode}|${d.sourceKey}`, id);
      const moves = planMoves(d);
      toInsert.push({
        id,
        projectId,
        ...plannedValues(d, ref),
        drawingCode: d.drawingCode,
        revision: d.revision,
        numberStatus: d.numberStatus,
        sourceKey: d.sourceKey,
        baselineReleaseDate: d.baselineReleaseDate,
        currentExpectedReleaseDate: d.currentExpectedReleaseDate,
        actualReleaseDate: d.actualReleaseDate,
        completionStatus: d.released ? 'COMPLETED' : 'NOT_COMPLETED',
        releaseEvidence: d.releaseEvidence,
        rescheduleCount: moves.length,
        isManual: false,
        importBatchId: batchId,
        createdImportBatchId: batchId,
        userEditedFields: '',
        updatedAt: stamp,
      });
      created.push({ id, d });
      stats.created++;
    } else {
      const e = a.existing!;
      idFor.set(`${d.projectCode}|${d.sourceKey}`, e.id);
      if (a.kind === 'UNCHANGED') stats.unchanged++;
      else stats.updated++;
      if (a.promoted) stats.promoted++;
    }
    for (const r of a.planned.revisions) {
      revisionRows.push({
        id: newId('drv_'),
        drawingId: idFor.get(`${d.projectCode}|${d.sourceKey}`)!,
        revision: r.revision,
        sequence: r.sequence,
        expectedReleaseDate: r.expectedReleaseDate,
        actualReleaseDate: r.actualReleaseDate,
        completionStatus: r.released ? 'COMPLETED' : 'NOT_COMPLETED',
        releaseEvidence: r.releaseEvidence,
        remarks: null,
        source: r.source,
        sourceWorkbook: r.ref.workbook,
        sourceSheet: r.ref.sheet,
        sourceRow: r.ref.row,
        snapshotLabel: r.snapshotLabel,
        createdById: actor.id,
        createdByLabel: IMPORT_LABEL,
        createdImportBatchId: batchId,
        updatedAt: stamp,
      });
    }
  }
  for (const part of chunks(toInsert, 500)) await tx.insert(drawings).values(part);

  // Plan moves between source snapshots → reschedule history (created drawings only;
  // the history of an existing drawing was written when it was created).
  for (const { id, d } of created) {
    const moves = planMoves(d);
    for (const m of moves) {
      await recordRescheduleHistory(
        tx,
        {
          entityType: 'DRAWING',
          entityId: id,
          code: d.drawingCode,
          label: d.drawingName,
          projectId: ref.projectId.get(d.projectCode)!,
          oldDate: m.from.date,
          newDate: m.to.date,
          shiftDays: diffDays(m.to.date, m.from.date),
          cascaded: false,
        },
        {
          reason: `Plan moved between source snapshots: ${m.from.label} (${m.from.snapshotLabel}) → ${m.to.label} (${m.to.snapshotLabel})`,
          scope: 'IMPORT',
          batchId,
          actor: { id: actor.id, label: IMPORT_LABEL },
          impactedRecords: 1,
          stamp: m.to.snapshotDate ?? stamp,
        },
      );
      stats.planMovesRecorded++;
    }
  }

  // Updates on existing drawings.
  for (const a of actions.filter((x) => x.kind === 'UPDATE')) {
    const e = a.existing!;
    const d = a.planned;
    const label = `${e.drawingCode} — ${e.drawingName}`;
    const patch: Record<string, unknown> = {};
    for (const c of a.changes) patch[c.field] = c.to;
    if (a.release) {
      patch.completionStatus = 'COMPLETED';
      patch.actualReleaseDate = e.actualReleaseDate ?? a.release.actual ?? null;
      patch.releaseEvidence = d.releaseEvidence;
    }
    if (Object.keys(patch).length) {
      await tx.update(drawings).set({ ...patch, updatedAt: stamp } as never).where(eq(drawings.id, e.id));
      // What "Undo this import" may put back (only while nobody has changed the field since).
      const undo = Object.keys(patch)
        .filter((f) => !TRACE_FIELDS.has(f))
        .map((f) => ({
          id: newId('irc_'),
          batchId,
          entityType: 'DRAWING',
          entityId: e.id,
          field: f,
          oldValue: textOf((e as Record<string, unknown>)[f]),
          newValue: textOf(patch[f]),
        }));
      if (undo.length) await tx.insert(importRunChanges).values(undo);
      for (const c of a.changes) {
        await recordAudit(
          {
            actor,
            entityType: 'DRAWING',
            entityId: e.id,
            entityLabel: label,
            action: c.field === 'revision' ? 'CREATE_REVISION' : 'UPDATE_DRAWING',
            field: c.field,
            oldValue: c.from instanceof Date ? c.from.toISOString() : c.from == null ? null : String(c.from),
            newValue: c.to instanceof Date ? c.to.toISOString() : c.to == null ? null : String(c.to),
            reason: `Drawing import ${batchId}`,
            projectId: e.projectId,
          },
          tx,
        );
      }
      if (a.release) {
        stats.releases++;
        await recordAudit(
          {
            actor,
            entityType: 'DRAWING',
            entityId: e.id,
            entityLabel: label,
            action: 'RELEASE_DRAWING',
            field: 'completionStatus',
            oldValue: 'NOT_COMPLETED',
            newValue: 'COMPLETED',
            reason: `Source shows released (${d.releaseEvidence ?? 'no evidence text'}) — drawing import ${batchId}`,
            projectId: e.projectId,
          },
          tx,
        );
      }
    }
    if (a.expectedMove) {
      stats.expectedMoves++;
      await writeRescheduleChange(
        tx,
        {
          entityType: 'DRAWING',
          entityId: e.id,
          code: e.drawingCode,
          label: e.drawingName,
          projectId: e.projectId,
          oldDate: a.expectedMove.from,
          newDate: a.expectedMove.to,
          shiftDays: a.expectedMove.from ? diffDays(a.expectedMove.to, a.expectedMove.from) : 0,
          cascaded: false,
        },
        {
          reason: `Source plan changed: ${d.planPeriodLabel ?? 'new plan'} (${d.ref.workbook})`,
          scope: 'IMPORT',
          batchId,
          actor,
          impactedRecords: 1,
          stamp,
          recordHistory: true,
          markUserEdited: false,
        },
      );
    }
    if (a.newRevision) stats.revisionsAdded++;
  }

  // Protected fields: logged, never written.
  for (const a of actions) {
    for (const p of a.protectedChanges) {
      stats.protectedFields++;
      issues.push({
        severity: 'INFO',
        code: 'FIELD_PROTECTED_USER_EDIT',
        projectCode: a.planned.projectCode,
        drawingNumber: a.existing?.drawingCode ?? a.planned.drawingNumber,
        workbook: a.planned.ref.workbook,
        sheet: a.planned.ref.sheet,
        rowNumber: a.planned.ref.row,
        message: `${String(p.field)} was edited by a user — database value kept (${fmt(p.from)}); source has ${fmt(p.to)}.`,
      });
    }
    issues.push(...a.notes);
    if (a.promoted) {
      issues.push({
        severity: 'INFO',
        code: 'NUMBER_ASSIGNED_IN_SOURCE',
        projectCode: a.planned.projectCode,
        drawingNumber: a.planned.drawingNumber,
        message: `A not-yet-numbered drawing now has number ${a.planned.drawingNumber} in the source — the existing record was updated, not duplicated.`,
      });
    }
  }

  // Revision history: only ever added to.
  let revisionsInserted = 0;
  for (const part of chunks(revisionRows, 500)) {
    const res = await tx.insert(drawingRevisions).values(part).onConflictDoNothing().returning({ id: drawingRevisions.id });
    revisionsInserted += res.length;
  }
  stats.revisionsAdded = revisionsInserted;

  // Stamp every current drawing with this batch (used for validation).
  const currentIds = [...idFor.values()];
  for (const part of chunks(currentIds, 2000)) {
    await tx.update(drawings).set({ importBatchId: batchId }).where(inArray(drawings.id, part));
  }

  // 3. Conflicts — held back, never silently merged. An admin's resolution stands.
  const existingConflicts = await tx
    .select()
    .from(drawingConflicts)
    .where(inArray(drawingConflicts.projectId, [...ref.projectId.values()]));
  const conflictByKey = new Map(existingConflicts.map((c) => [`${c.projectId}|${c.conflictType}|${c.drawingNumber}`, c]));
  const resolvedDrawing = new Map<string, string>(); // `${projectCode}|NO:number` → drawing id
  for (const c of plan.conflicts) {
    const projectId = ref.projectId.get(c.projectCode)!;
    const prior = conflictByKey.get(`${projectId}|${c.conflictType}|${c.drawingNumber}`);
    if (prior?.status === 'RESOLVED' && prior.resolvedDrawingId) {
      resolvedDrawing.set(`${c.projectCode}|${numberKey(c.drawingNumber)}`, prior.resolvedDrawingId);
      stats.conflictsResolved++;
    } else if (prior?.status !== 'DISMISSED') stats.conflictsOpen++;
    await tx
      .insert(drawingConflicts)
      .values({
        id: newId('dcf_'),
        projectId,
        conflictType: c.conflictType,
        drawingNumber: c.drawingNumber,
        status: 'OPEN',
        candidateCount: c.candidates.length,
        candidates: JSON.stringify(c.candidates),
        message: c.message,
        importBatchId: batchId,
        updatedAt: stamp,
      })
      .onConflictDoUpdate({
        target: [drawingConflicts.projectId, drawingConflicts.conflictType, drawingConflicts.drawingNumber],
        set: {
          candidateCount: c.candidates.length,
          candidates: JSON.stringify(c.candidates),
          message: c.message,
          importBatchId: batchId,
          updatedAt: stamp,
        },
      });
  }

  // 4. Snapshots: every source row, current and historical.
  const snapRows = plan.snapshots.map((s) => {
    const drawingId = s.drawingKey
      ? (idFor.get(`${s.projectCode}|${s.drawingKey}`) ?? null)
      : s.drawingNumber
        ? (resolvedDrawing.get(`${s.projectCode}|${numberKey(s.drawingNumber)}`) ?? null)
        : null;
    return {
      id: newId('dsn_'),
      projectId: ref.projectId.get(s.projectCode)!,
      drawingId,
      snapshotRole: s.snapshotRole,
      sourceKind: s.sourceKind,
      snapshotLabel: s.snapshotLabel,
      snapshotDate: s.snapshotDate,
      planYear: s.planYear,
      sourceWorkbook: s.ref.workbook,
      sourceSheet: s.ref.sheet,
      sourceRow: s.ref.row,
      disciplineCode: s.disciplineCode,
      section: s.section,
      location: s.location,
      batchCode: s.batchCode,
      batch: s.batch,
      drawingNumber: s.drawingNumber,
      numberKind: s.numberKind,
      partialNumber: s.partialNumber,
      title: s.title,
      revision: s.revision,
      released: s.released,
      issuedBeforeYear: s.issuedBeforeYear,
      issuedQuarter: s.issuedQuarter,
      plannedQuarter: s.plannedQuarter,
      explicitDateText: s.explicitDateText,
      inAcc: s.inAcc,
      collection: s.collection,
      versionCount: s.versionCount,
      tags: s.tags,
      accDiscipline: s.accDiscipline,
      accReleaseDate: s.accReleaseDate,
      accCreatedAt: s.accCreatedAt,
      importBatchId: batchId,
      createdImportBatchId: batchId,
    };
  });
  for (const part of chunks(snapRows, 500)) {
    await tx
      .insert(drawingSnapshots)
      .values(part)
      .onConflictDoUpdate({
        target: [drawingSnapshots.sourceWorkbook, drawingSnapshots.sourceSheet, drawingSnapshots.sourceRow],
        set: {
          drawingId: sql`excluded.drawing_id`,
          snapshotRole: sql`excluded.snapshot_role`,
          snapshotLabel: sql`excluded.snapshot_label`,
          title: sql`excluded.title`,
          drawingNumber: sql`excluded.drawing_number`,
          revision: sql`excluded.revision`,
          released: sql`excluded.released`,
          location: sql`excluded.location`,
          batchCode: sql`excluded.batch_code`,
          batch: sql`excluded.batch`,
          importBatchId: sql`excluded.import_batch_id`,
        },
      });
    stats.snapshots += part.length;
  }

  return { ...stats, actions };
}

function fmt(v: unknown) {
  if (v == null || v === '') return '(blank)';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return `"${String(v)}"`;
}

export async function writeIssues(tx: DbLike, batchId: string, issues: PlanIssue[]) {
  const rows = issues.map((i) => ({
    id: newId('dii_'),
    batchId,
    severity: i.severity,
    code: i.code,
    projectCode: i.projectCode,
    drawingNumber: i.drawingNumber ?? null,
    workbook: i.workbook ?? null,
    sheet: i.sheet ?? null,
    rowNumber: i.rowNumber ?? null,
    message: i.message,
    payload: i.payload === undefined ? null : JSON.stringify(i.payload),
  }));
  for (const part of chunks(rows, 1000)) await tx.insert(drawingImportIssues).values(part);
}

/** Post-write validation inside the transaction: the database must now hold
 *  exactly the planned current drawings for this batch. */
export async function countBatchDrawings(tx: DbLike, batchId: string, ref: ReferenceIds) {
  const rows = await tx
    .select({
      projectId: drawings.projectId,
      n: sql<number>`count(*)::int`,
      released: sql<number>`count(*) filter (where ${drawings.completionStatus} = 'COMPLETED')::int`,
      nyn: sql<number>`count(*) filter (where ${drawings.numberStatus} = 'NOT_YET_NUMBERED')::int`,
      actual: sql<number>`count(${drawings.actualReleaseDate})::int`,
    })
    .from(drawings)
    .where(eq(drawings.importBatchId, batchId))
    .groupBy(drawings.projectId);
  const codeOf = new Map([...ref.projectId].map(([c, id]) => [id, c]));
  return Object.fromEntries(rows.map((r) => [codeOf.get(r.projectId)!, { drawings: r.n, released: r.released, notYetNumbered: r.nyn, actualDates: r.actual }]));
}

export { drawingImportBatches, and };

/**
 * A base DFS (Design Fee sheet) imported without drawing sources rebuilds a
 * project's packages; this re-links the project's EXISTING drawings to them by
 * the same stable rules the full import uses — the stored batch code, else the
 * stored drawing-list heading — and never touches a package a user set. Every
 * change is recorded so "Undo this import" can put it back.
 */
export async function relinkWithoutPlan(
  tx: DbLike,
  manifest: DrawingManifest,
  plan: ImportPlan,
  ref: ReferenceIds,
  batchId: string,
  issues: PlanIssue[],
): Promise<number> {
  let changed = 0;
  const withPlan = new Set(plan.drawings.map((d) => d.projectCode));
  for (const fee of manifest.designFees ?? []) {
    if (withPlan.has(fee.projectCode)) continue;
    const projectId = ref.projectId.get(fee.projectCode);
    if (!projectId) continue;
    const codes = plan.packages.filter((p) => p.projectCode === fee.projectCode).map((p) => p.code);
    if (!codes.length) continue;
    const codeSet = new Set(codes);
    const resolve = headingResolver(codes);
    const rows = await tx.select().from(drawings).where(eq(drawings.projectId, projectId));
    const unmatched = new Map<string, number>();
    for (const d of rows) {
      if (parseEditedFields(d.userEditedFields).has('packageId')) continue;
      let code = packageCodeForBatch(d.batchCode, codeSet);
      if (!code && !/-NA$/i.test(d.batchCode ?? '') && d.areaOfWorks) code = resolve([d.areaOfWorks]).code ?? null;
      const target = code ? (ref.packageId.get(`${fee.projectCode}|${code}`) ?? null) : null;
      if (!code) unmatched.set((d.batchCode ?? '(no batch)').replace(/\d+$/, 'n'), (unmatched.get((d.batchCode ?? '(no batch)').replace(/\d+$/, 'n')) ?? 0) + 1);
      if (!target || target === d.packageId) continue;
      await tx.update(drawings).set({ packageId: target, updatedAt: new Date() }).where(eq(drawings.id, d.id));
      await tx.insert(importRunChanges).values({ id: newId('irc_'), batchId, entityType: 'DRAWING', entityId: d.id, field: 'packageId', oldValue: d.packageId, newValue: target });
      changed++;
    }
    for (const [pattern, n] of unmatched) {
      issues.push({
        severity: 'WARNING',
        code: 'BATCH_WITHOUT_FEE_PACKAGE',
        projectCode: fee.projectCode,
        workbook: fee.file,
        message: `${n} existing drawing(s) in batch ${pattern} match no package of the base DFS — listed directly under the discipline.`,
        payload: { pattern, drawings: n },
      });
    }
  }
  return changed;
}
