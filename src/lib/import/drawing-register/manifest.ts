/**
 * The drawing-source manifest.
 *
 * Everything project-specific about a drawing import — which workbook is the
 * current register and which are history, which project each belongs to, the
 * explicit location → phase map and the validation targets — lives in a JSON
 * manifest under `data/drawing-sources/`, never in code. The importer is the
 * same for every project; only the manifest changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const PHASE_RULES = [
  'EXACT',
  'ZONE',
  'VARIANT',
  'GOALS_PHASE',
  'PROJECT_SINGLE_PHASE',
  'MULTI_PHASE',
  'NO_MATCHING_PHASE',
  'NO_PHASE_DEFINED',
] as const;
export type PhaseRule = (typeof PHASE_RULES)[number];

/** Rules whose `phase: null` is an expected outcome rather than a gap. */
export const SILENT_NULL_RULES: readonly PhaseRule[] = ['NO_PHASE_DEFINED'];

const colLetter = z.string().regex(/^[A-Z]{1,3}$/);

/** Node types of the base-DFS tree above packages. */
export const WBS_NODE_TYPES = ['PHASE', 'TOWER', 'PRODUCT', 'BLOCK', 'VILLA', 'GROUP'] as const;
export type WbsNodeType = (typeof WBS_NODE_TYPES)[number];

/**
 * How a base-DFS heading is typed when the manifest gives no rule of its own.
 * Plain construction vocabulary, not project data; the first match wins and
 * anything else is a GROUP.
 */
export const DEFAULT_WBS_NODE_TYPES: { pattern: string; type: WbsNodeType }[] = [
  { pattern: '^phase\\b', type: 'PHASE' },
  { pattern: '^towers?\\b', type: 'TOWER' },
  { pattern: '\\bblocks?\\s*[-—–]?\\s*([0-9]|[a-z](\\b|,))', type: 'BLOCK' },
  { pattern: '^villas?\\b', type: 'VILLA' },
  { pattern: '\\b(individual homes?|products?)\\b', type: 'PRODUCT' },
];

const dfsHierarchy = z
  .object({
    /** Regex removed from the start of a heading to give the node name
     *  (the source label is kept as-is on the node). */
    labelPrefix: z.string().optional(),
    nodeTypes: z.array(z.object({ pattern: z.string().min(1), type: z.enum(WBS_NODE_TYPES) })).default([]),
    /** When a drawing's batch code names no base-DFS package, try the
     *  drawing-list heading it sits under (logged as an issue). */
    resolveUnlinkedByHeading: z.boolean().default(true),
  })
  .default({ nodeTypes: [], resolveUnlinkedByHeading: true });

/** How a Design Fee sheet's fees are read (design-fee.ts). */
export const FEE_LAYOUT_CHOICES = ['AUTO', 'DISCIPLINE_BLOCKS', 'PACKAGE_TOTAL'] as const;
export type FeeLayoutChoice = (typeof FEE_LAYOUT_CHOICES)[number];

const planWorkbook = z.object({
  file: z.string().min(1),
  projectCode: z.string().min(1),
  role: z.enum(['CURRENT', 'HISTORICAL']),
  label: z.string().min(1),
  snapshotDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  planYear: z.number().int().min(2000).max(2100),
  usage: z.string().optional(),
  /** Import Centre: column letters a user confirmed, per sheet name ('*' = every sheet). */
  columns: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  /** Import Centre: discipline per sheet, when the sheet name does not say. */
  disciplines: z.record(z.string(), z.string()).optional(),
});

const registerSheet = z.object({
  name: z.string().min(1),
  discipline: z.string().min(1),
  firstDataRow: z.number().int().min(1),
  columns: z.object({
    number: colLetter,
    title: colLetter,
    location: colLetter,
    batchCode: colLetter,
    batch: colLetter,
    revision: colLetter,
  }),
});

const phaseMapEntry = z.object({
  location: z.string().min(1),
  zone: z.string().optional(),
  phase: z.string().nullable(),
  rule: z.enum(PHASE_RULES),
  note: z.string().optional(),
});

const projectTargets = z.object({
  drawings: z.number().int(),
  released: z.number().int(),
  notReleased: z.number().int(),
  notYetNumbered: z.number().int(),
  numberConflicts: z.number().int(),
  accOnlyConflicts: z.number().int().optional(),
  actualDates: z.number().int(),
});

export const manifestSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  sourceDir: z.string().min(1),
  planSheetPattern: z.string().min(1),
  planWorkbooks: z.array(planWorkbook).default([]),
  register: z
    .object({
      file: z.string().min(1),
      projectCode: z.string().min(1),
      label: z.string().min(1),
      sheets: z.array(registerSheet).min(1),
      acc: z
        .object({
          sheet: z.string().min(1),
          label: z.string().min(1),
          headerRow: z.number().int().min(1),
          columns: z.object({
            number: colLetter,
            title: colLetter,
            collection: colLetter,
            versions: colLetter,
            releaseDate: colLetter,
            createdAt: colLetter,
            discipline: colLetter,
            tags: colLetter,
          }),
        })
        .optional(),
    })
    .optional(),
  /** Design Fee sheets: the fee packages (billing Scope) drawings link to.
   *  layout: AUTO (one fee per package when the sheet has a Total Fee / Balance
   *  column set, else per discipline), or pinned to DISCIPLINE_BLOCKS /
   *  PACKAGE_TOTAL for a source whose fees are kept that way. */
  designFees: z
    .array(
      z.object({
        file: z.string().min(1),
        projectCode: z.string().min(1),
        sheet: z.string().min(1),
        label: z.string().min(1),
        layout: z.enum(FEE_LAYOUT_CHOICES).default('AUTO'),
      }),
    )
    .default([]),
  packageLinking: z.string().optional(),
  /** Project names and hierarchy the source implies: a group project (created
   *  when it does not exist) and the display names of the projects below it.
   *  Only fills what is empty — a Project List import always wins. */
  projects: z
    .array(z.object({ code: z.string().min(1), name: z.string().min(1), parent: z.string().min(1).optional(), order: z.number().int().optional() }))
    .default([]),
  /** How the base DFS (Design Fee sheet) headings become the WBS tree. */
  dfsHierarchy,
  excluded: z.array(z.object({ file: z.string(), reason: z.string() })).default([]),
  phaseMap: z.record(z.string(), z.array(phaseMapEntry)),
  expected: z
    .object({
      projects: z.record(z.string(), projectTargets),
      total: projectTargets,
      historicalSnapshotRows: z.record(z.string(), z.number().int()),
      packages: z.record(z.string(), z.number().int()).optional(),
      packageLinkedDrawings: z.record(z.string(), z.number().int()).optional(),
      wbsNodes: z.record(z.string(), z.number().int()).optional(),
    })
    .optional(),
});

export type DrawingManifest = z.infer<typeof manifestSchema>;
export type PlanWorkbookSpec = z.infer<typeof planWorkbook>;
export type RegisterSheetSpec = z.infer<typeof registerSheet>;
export type PhaseMapEntry = z.infer<typeof phaseMapEntry>;
export type ProjectTargets = z.infer<typeof projectTargets>;

export const DEFAULT_MANIFEST = 'data/drawing-sources/poarr.json';

export interface LoadedManifest {
  path: string;
  /** Folder holding the workbooks (manifest dir + sourceDir). */
  sourceFolder: string;
  manifest: DrawingManifest;
}

export function loadManifest(manifestPath = process.env.DRAWING_MANIFEST ?? DEFAULT_MANIFEST): LoadedManifest {
  const abs = path.resolve(process.cwd(), manifestPath);
  if (!fs.existsSync(abs)) throw new Error(`Drawing manifest not found: ${abs}`);
  const manifest = manifestSchema.parse(JSON.parse(fs.readFileSync(abs, 'utf8')));
  return { path: abs, sourceFolder: path.resolve(path.dirname(abs), manifest.sourceDir), manifest };
}

/** Project codes the manifest touches, in first-seen order. */
export function manifestProjectCodes(m: DrawingManifest): string[] {
  const out: string[] = [];
  for (const w of m.planWorkbooks) if (!out.includes(w.projectCode)) out.push(w.projectCode);
  if (m.register && !out.includes(m.register.projectCode)) out.push(m.register.projectCode);
  for (const d of m.designFees ?? []) if (!out.includes(d.projectCode)) out.push(d.projectCode);
  return out;
}
