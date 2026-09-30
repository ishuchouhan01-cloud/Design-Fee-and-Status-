/**
 * Drawing Register import — manifest-driven, previewed before it is applied.
 *
 *   preview  parse → plan → diff against the database → validation report.
 *            Writes only the batch row and its issues; no drawing data.
 *   apply    the same, then every write in ONE transaction. Refused unless the
 *            plan matches the manifest's validation targets exactly. The
 *            transaction re-counts what it wrote and rolls back on any
 *            difference, so a partial import cannot be left behind.
 */
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { drawingImportBatches, drawings } from '@/db/schema';
import { recordAudit, type Actor } from '@/lib/audit';
import { newId } from '@/lib/ids';
import { applyManifestProjects } from './projects';
import { applyPlan, computeActions, countBatchDrawings, loadReferences, relinkWithoutPlan, writeIssues, type ApplyStats } from './apply';
import { loadManifest, type DrawingManifest } from './manifest';
import { parseSources } from './parse';
import { buildPlan, validatePlan, type ImportPlan, type PlanIssue } from './plan';

export { loadManifest } from './manifest';
export { buildPlan, validatePlan } from './plan';
export { parseSources } from './parse';

export interface DrawingImportOptions {
  manifestPath?: string;
  /** An in-memory manifest (the Import Centre builds one per upload) … */
  manifest?: DrawingManifest;
  /** … and the folder its files are in. */
  sourceFolder?: string;
  apply: boolean;
  actor: Actor;
  /** Recorded on the import run (Import Centre history). */
  meta?: { fileType?: string; fileNames?: string[]; projectId?: string | null };
}

export interface DrawingImportResult {
  batchId: string;
  mode: 'PREVIEW' | 'APPLIED';
  manifest: string;
  valid: boolean;
  validation: string[];
  counts: ImportPlan['counts'];
  changes: { create: number; update: number; unchanged: number; promoted: number; protectedFields: number; expectedMoves: number; releases: number };
  applied?: ApplyStats;
  issueCounts: Record<string, number>;
  issues: PlanIssue[];
  sheetsRead: { workbook: string; sheet: string; rows: number }[];
  excluded: { file: string; reason: string }[];
  durationMs: number;
}

export async function runDrawingImport(opts: DrawingImportOptions): Promise<DrawingImportResult> {
  const t0 = Date.now();
  const loaded = opts.manifest
    ? { manifest: opts.manifest, sourceFolder: opts.sourceFolder ?? '.', path: `upload:${opts.manifest.name}` }
    : loadManifest(opts.manifestPath);
  const { manifest, sourceFolder, path: manifestPath } = loaded;
  const sources = parseSources(manifest, sourceFolder);
  const plan = buildPlan(manifest, sources);
  const validation = validatePlan(manifest, plan);
  const valid = validation.length === 0;

  const ref = await loadReferences(manifest);
  const existing = await db.select().from(drawings).where(inArray(drawings.projectId, [...ref.projectId.values()]));
  const actions = computeActions(plan, existing, ref);
  const issues: PlanIssue[] = [...plan.issues];
  const changes = {
    create: actions.filter((a) => a.kind === 'CREATE').length,
    update: actions.filter((a) => a.kind === 'UPDATE').length,
    unchanged: actions.filter((a) => a.kind === 'UNCHANGED').length,
    promoted: actions.filter((a) => a.promoted).length,
    protectedFields: actions.reduce((n, a) => n + a.protectedChanges.length, 0),
    expectedMoves: actions.filter((a) => a.expectedMove).length,
    releases: actions.filter((a) => a.release).length,
  };

  const [batch] = await db
    .insert(drawingImportBatches)
    .values({
      id: newId('dib_'),
      manifest: manifest.name,
      status: 'PREVIEW',
      startedById: opts.actor.id,
      startedByLabel: opts.actor.label,
      fileType: opts.meta?.fileType ?? 'MANIFEST',
      fileNames: (opts.meta?.fileNames ?? [...manifest.planWorkbooks.map((w) => w.file), ...manifest.designFees.map((d) => d.file)]).join(', '),
      projectId: opts.meta?.projectId ?? null,
    })
    .returning();

  const base = {
    batchId: batch.id,
    manifest: manifestPath,
    valid,
    validation,
    counts: plan.counts,
    changes,
    sheetsRead: sources.sheetsRead,
    excluded: manifest.excluded,
  };
  const tally = (list: PlanIssue[]) => {
    const m: Record<string, number> = {};
    for (const i of list) m[i.code] = (m[i.code] ?? 0) + 1;
    return m;
  };

  if (!opts.apply) {
    // Preview-level notes on existing drawings (protected fields etc.).
    for (const a of actions) {
      for (const p of a.protectedChanges) {
        issues.push({
          severity: 'INFO',
          code: 'FIELD_PROTECTED_USER_EDIT',
          projectCode: a.planned.projectCode,
          drawingNumber: a.existing?.drawingCode ?? null,
          message: `${String(p.field)} was edited by a user and will be kept.`,
        });
      }
      issues.push(...a.notes);
    }
    await writeIssues(db, batch.id, issues);
    await db
      .update(drawingImportBatches)
      .set({
        finishedAt: new Date(),
        summaryJson: JSON.stringify({ ...base, issueCounts: tally(issues) }),
        conflictCount: plan.conflicts.length,
        warningCount: issues.filter((i) => i.severity === 'WARNING').length,
        errorCount: issues.filter((i) => i.severity === 'ERROR').length + validation.length,
      })
      .where(eq(drawingImportBatches.id, batch.id));
    return { ...base, mode: 'PREVIEW', issueCounts: tally(issues), issues, durationMs: Date.now() - t0 };
  }

  if (!valid) {
    await db
      .update(drawingImportBatches)
      .set({ status: 'FAILED', finishedAt: new Date(), summaryJson: JSON.stringify({ ...base, error: 'Validation failed' }), errorCount: validation.length })
      .where(eq(drawingImportBatches.id, batch.id));
    throw new Error(`Drawing import refused — the source does not match the validation targets:\n  ${validation.join('\n  ')}`);
  }

  let applied: ApplyStats;
  try {
    applied = await db.transaction(async (tx) => {
      // The project hierarchy the source implies (group project, display names) — fills only what is empty.
      const hierarchy = await applyManifestProjects(tx, manifest, batch.id, opts.actor);
      const { actions: _applied, ...stats } = await applyPlan(tx, { batchId: batch.id, manifest, plan, ref, actor: opts.actor, issues });
      void _applied;
      // A base DFS imported on its own re-links the project's existing drawings.
      stats.relinked = await relinkWithoutPlan(tx, manifest, plan, ref, batch.id, issues);
      // Re-count inside the transaction: any difference rolls everything back.
      const got = await countBatchDrawings(tx, batch.id, ref);
      const diffs: string[] = [];
      for (const [code, want] of Object.entries(plan.counts.projects)) {
        const g = got[code] ?? { drawings: 0, released: 0, notYetNumbered: 0, actualDates: 0 };
        if (g.drawings !== want.drawings) diffs.push(`${code} drawings ${g.drawings} ≠ ${want.drawings}`);
        if (g.released < want.released) diffs.push(`${code} released ${g.released} < ${want.released}`);
        if (g.notYetNumbered > want.notYetNumbered) diffs.push(`${code} not-yet-numbered ${g.notYetNumbered} > ${want.notYetNumbered}`);
      }
      if (diffs.length) throw new Error(`Post-write validation failed; nothing was imported: ${diffs.join('; ')}`);
      await writeIssues(tx, batch.id, issues);
      await tx
        .update(drawingImportBatches)
        .set({
          status: 'APPLIED',
          finishedAt: new Date(),
          summaryJson: JSON.stringify({ ...base, applied: stats, hierarchy, database: got, issueCounts: tally(issues) }),
          createdCount: stats.created,
          updatedCount: stats.updated,
          protectedCount: stats.protectedFields,
          conflictCount: plan.conflicts.length,
          warningCount: issues.filter((i) => i.severity === 'WARNING').length,
          errorCount: 0,
        })
        .where(eq(drawingImportBatches.id, batch.id));
      await recordAudit(
        {
          actor: opts.actor,
          entityType: 'DRAWING_IMPORT',
          entityId: batch.id,
          entityLabel: manifest.name,
          action: 'IMPORT',
          newValue: JSON.stringify({ created: stats.created, updated: stats.updated, protected: stats.protectedFields, conflicts: plan.conflicts.length }),
          reason: 'Drawing Register import',
        },
        tx,
      );
      return stats;
    });
  } catch (err) {
    await db
      .update(drawingImportBatches)
      .set({
        status: 'FAILED',
        finishedAt: new Date(),
        summaryJson: JSON.stringify({ ...base, error: err instanceof Error ? err.message : String(err) }),
        errorCount: 1,
      })
      .where(eq(drawingImportBatches.id, batch.id));
    throw err;
  }

  return { ...base, mode: 'APPLIED', applied, issueCounts: tally(issues), issues, durationMs: Date.now() - t0 };
}

/** Human-readable report for the CLI and the import screen. */
export function formatDrawingImportSummary(r: DrawingImportResult): string {
  const L: string[] = [];
  const pad = (s: string | number, n: number) => String(s).padStart(n);
  L.push(`Drawing import — ${r.mode}  (batch ${r.batchId}, ${(r.durationMs / 1000).toFixed(1)}s)`);
  L.push(`Manifest : ${r.manifest}`);
  L.push('');
  L.push('Project        Drawings  Released  NotRel  NotYetNo  Conflicts  ACC-only  ActualDates');
  for (const [code, c] of [...Object.entries(r.counts.projects), ['TOTAL', r.counts.total] as const]) {
    L.push(
      `${String(code).padEnd(14)}${pad(c.drawings, 9)}${pad(c.released, 10)}${pad(c.notReleased, 8)}${pad(c.notYetNumbered, 10)}${pad(c.numberConflicts, 11)}${pad(c.accOnlyConflicts, 10)}${pad(c.actualDates, 13)}`,
    );
  }
  L.push('');
  L.push('Historical snapshot rows:');
  for (const [wb, n] of Object.entries(r.counts.historicalSnapshotRows)) L.push(`  ${pad(n, 6)}  ${wb}`);
  L.push(`Current snapshot rows: ${r.counts.currentSnapshotRows}   revisions: ${r.counts.revisions}   plan moves: ${r.counts.planMoves}`);
  L.push('');
  L.push('Base DFS (Design Fee → WBS headings / packages / package_fees) and drawings linked to it:');
  for (const [code, n] of Object.entries(r.counts.packages)) {
    const f = r.counts.fees[code];
    const fmt = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k} ${v.toFixed(4)}`).join(' · ');
    L.push(`  ${code}: ${r.counts.wbsNodes?.[code] ?? 0} WBS headings · ${n} packages · ${r.counts.packageLinkedDrawings[code] ?? 0} drawings linked`);
    if (f) {
      L.push(`      scope imported (Cr.)  ${fmt(f.packageFees)}`);
      L.push(`      repeated-code rows    ${fmt(f.duplicateFees)}`);
      L.push(`      not drawing packages  ${fmt(f.feesOutsidePackages)}   (design concepts, post-construction)`);
      L.push(`      sheet total           ${fmt(f.sheetTotal)}`);
    }
  }
  L.push('');
  const c = r.changes;
  L.push(`Against the database: create ${c.create} · update ${c.update} · unchanged ${c.unchanged} · promoted ${c.promoted} · protected fields ${c.protectedFields} · expected-date moves ${c.expectedMoves} · releases ${c.releases}`);
  if (r.applied) {
    const a = r.applied;
    L.push(`Applied: created ${a.created} · updated ${a.updated} · unchanged ${a.unchanged} · revisions added ${a.revisionsAdded} · plan moves recorded ${a.planMovesRecorded} · snapshots ${a.snapshots} · conflicts open ${a.conflictsOpen} / resolved ${a.conflictsResolved}`);
  }
  L.push('');
  L.push('Issues:');
  for (const [code, n] of Object.entries(r.issueCounts).sort((x, y) => y[1] - x[1])) L.push(`  ${pad(n, 6)}  ${code}`);
  if (r.excluded.length) {
    L.push('');
    L.push('Not imported (by decision):');
    for (const e of r.excluded) L.push(`  ${e.file} — ${e.reason}`);
  }
  L.push('');
  L.push(r.valid ? 'VALIDATION: all targets matched.' : `VALIDATION FAILED:\n  ${r.validation.join('\n  ')}`);
  return L.join('\n');
}
