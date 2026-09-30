import { z } from 'zod';
import {
  COMPLETION_STATUSES,
  DEPENDENCY_TYPES,
  ENTITY_TYPES,
  PRIORITIES,
  RAG,
  RESCHEDULE_SCOPES,
  ROLES,
} from './domain';

export const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date')
  .transform((v) => {
    const [y, m, d] = v.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  });

export const optionalDateString = z.union([dateString, z.literal('').transform(() => null), z.null()]).optional();

/**
 * Completion is binary. This schema is the single gate in front of every write
 * path, which is what makes "no IN PROGRESS, no percentage" enforceable rather
 * than aspirational.
 */
export const completionStatusSchema = z.enum(COMPLETION_STATUSES);

/** `reason` is metadata for the audit trail, accepted on every update path. */
const reasonField = { reason: z.string().max(500).optional() };

export const deliverableUpdateSchema = z
  .object({
    ...reasonField,
    completionStatus: completionStatusSchema.optional(),
    currentExpectedReleaseDate: optionalDateString,
    actualReleaseDate: optionalDateString,
    revision: z.string().max(32).optional(),
    remarks: z.string().max(2000).optional(),
    ownerId: z.string().nullable().optional(),
  })
  .strict();

/**
 * PATCH /api/drawings/:id. Metadata edits go to the drawing service; the
 * special fields are routed, never written directly:
 *   completionStatus           → Mark as Released / withdraw release
 *   currentExpectedReleaseDate → the reschedule engine (history + audit)
 *   revision                   → a new revision row
 */
export const drawingUpdateSchema = z
  .object({
    ...reasonField,
    completionStatus: completionStatusSchema.optional(),
    currentExpectedReleaseDate: optionalDateString,
    actualReleaseDate: optionalDateString,
    revision: z.string().trim().min(1).max(32).optional(),
    remarks: z.string().max(2000).nullable().optional(),
    drawingName: z.string().trim().min(1).max(400).optional(),
    drawingNumber: z.string().trim().min(1).max(80).optional(),
    location: z.string().max(120).nullable().optional(),
    areaOfWorks: z.string().max(200).nullable().optional(),
    phaseId: z.string().nullable().optional(),
    disciplineId: z.string().nullable().optional(),
    packageId: z.string().nullable().optional(),
    batchCode: z.string().max(80).nullable().optional(),
    batch: z.string().max(80).nullable().optional(),
    responsibleUserId: z.string().nullable().optional(),
    responsibleText: z.string().max(200).nullable().optional(),
  })
  .strict();

export const goalUpdateSchema = z
  .object({
    ...reasonField,
    goalDescription: z.string().min(1).max(600).optional(),
    plannedQuantity: z.number().int().min(0).max(100000).optional(),
    plannedValue: z.number().min(0).max(1_000_000).optional(),
    currentExpectedDate: optionalDateString,
    actualCompletionDate: optionalDateString,
    completionStatus: completionStatusSchema.optional(),
    priority: z.enum(PRIORITIES).optional(),
    remarks: z.string().max(2000).optional(),
    designLeadId: z.string().nullable().optional(),
    disciplineId: z.string().nullable().optional(),
  })
  .strict();

export const goalCreateSchema = z.object({
  projectId: z.string().min(1),
  phaseId: z.string().nullable().optional(),
  disciplineId: z.string().nullable().optional(),
  designLeadId: z.string().nullable().optional(),
  goalDescription: z.string().min(1).max(600),
  fiscalYear: z.string().min(3).max(16),
  quarter: z.number().int().min(1).max(4),
  plannedQuantity: z.number().int().min(0).default(0),
  plannedValue: z.number().min(0).default(0),
  priority: z.enum(PRIORITIES).default('MEDIUM'),
  remarks: z.string().max(2000).optional(),
});

export const bulkActionSchema = z.object({
  entityType: z.enum(ENTITY_TYPES),
  ids: z.array(z.string().min(1)).min(1).max(5000),
  action: z.enum([
    'MARK_COMPLETED',
    'MARK_NOT_COMPLETED',
    'CHANGE_EXPECTED_DATE',
    'CHANGE_OWNER',
    'ADD_REMARK',
    'CHANGE_REVISION',
  ]),
  actualReleaseDate: optionalDateString,
  expectedDate: optionalDateString,
  ownerId: z.string().nullable().optional(),
  remark: z.string().max(2000).optional(),
  revision: z.string().max(32).optional(),
  reason: z.string().max(500).optional(),
});

export const rescheduleSchema = z.object({
  entityType: z.enum(ENTITY_TYPES),
  ids: z.array(z.string().min(1)).min(1).max(5000),
  newExpectedDate: optionalDateString,
  shiftDays: z.number().int().min(-3650).max(3650).nullable().optional(),
  reason: z.string().min(3, 'A reason is required for every reschedule').max(500),
  scope: z.enum(RESCHEDULE_SCOPES).default('ITEM'),
  projectId: z.string().nullable().optional(),
  packageId: z.string().nullable().optional(),
  disciplineId: z.string().nullable().optional(),
  goalId: z.string().nullable().optional(),
  options: z
    .object({
      preserveCompletedDates: z.boolean().default(true),
      recalculateDependents: z.boolean().default(true),
      updateForecast: z.boolean().default(true),
      recordHistory: z.boolean().default(true),
    })
    .partial()
    .optional(),
  confirm: z.boolean().default(false),
});

export const dependencySchema = z.object({
  predecessorType: z.enum(ENTITY_TYPES),
  predecessorId: z.string().min(1),
  successorType: z.enum(ENTITY_TYPES),
  successorId: z.string().min(1),
  dependencyType: z.enum(DEPENDENCY_TYPES).default('FS'),
  lagDays: z.number().int().min(-365).max(365).default(0),
});

export const ragOverrideSchema = z.object({
  entityType: z.enum(['PROJECT', 'GOAL']),
  entityId: z.string().min(1),
  overrideRag: z.enum(RAG),
  reason: z.string().min(3).max(500),
});

export const userSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  role: z.enum(ROLES),
  active: z.boolean().default(true),
});

/**
 * Guard rails that exist purely to make the forbidden things in spec §43
 * impossible to express through the API surface.
 */
export const REJECTED_FIELDS = [
  'completionPercent',
  'percentComplete',
  'progressPercent',
  'baselineReleaseDate',
  'baselineTargetDate',
  'forecast',
] as const;

export function rejectForbiddenFields(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return;
  for (const key of Object.keys(payload as Record<string, unknown>)) {
    if ((REJECTED_FIELDS as readonly string[]).includes(key)) {
      throw new Error(
        `Field "${key}" cannot be set through the API: per-item percentages do not exist, and baseline dates are immutable.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Design Goals FY 26
//
// `baselineReleaseDate` is already in REJECTED_FIELDS above, so the FY26
// baseline is protected by the same guard as every other baseline. There is no
// billing-date field here, by design: the source workbooks contain billing
// amounts and a single release date, and a billing date is never derived.
// ---------------------------------------------------------------------------

const billingAmount = z.number().min(0).max(100_000);

export const fy26PackageUpdateSchema = z
  .object({
    ...reasonField,
    packageDescription: z.string().min(1).max(600).optional(),
    fy26PhaseId: z.string().nullable().optional(),
    disciplineId: z.string().nullable().optional(),
    responsibleUserId: z.string().nullable().optional(),
    currentExpectedReleaseDate: optionalDateString,
    actualReleaseDate: optionalDateString,
    planBillingCr: billingAmount.nullable().optional(),
    actualBillingCr: billingAmount.nullable().optional(),
    plannedPackageQuantity: z.number().int().min(0).max(100_000).nullable().optional(),
    actualPackageQuantity: z.number().int().min(0).max(100_000).nullable().optional(),
    remarks: z.string().max(2000).nullable().optional(),
    completionStatus: completionStatusSchema.optional(),
  })
  .strict();

export const fy26DependencyCreateSchema = z
  .object({
    ...reasonField,
    fy26PackageId: z.string().min(1),
    stepLabel: z.string().max(60).nullable().optional(),
    description: z.string().min(1).max(600),
    targetDate: optionalDateString,
    responsibleText: z.string().max(400).nullable().optional(),
    remarks: z.string().max(2000).nullable().optional(),
    completionStatus: completionStatusSchema.optional(),
  })
  .strict();

export const fy26DependencyUpdateSchema = z
  .object({
    ...reasonField,
    stepLabel: z.string().max(60).nullable().optional(),
    description: z.string().min(1).max(600).optional(),
    targetDate: optionalDateString,
    responsibleText: z.string().max(400).nullable().optional(),
    remarks: z.string().max(2000).nullable().optional(),
    completionStatus: completionStatusSchema.optional(),
    sequence: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();

export const fy26ListFiltersSchema = z
  .object({
    search: z.string().max(200).optional(),
    projectId: z.string().optional(),
    phaseId: z.string().optional(),
    disciplineId: z.string().optional(),
    responsibleId: z.string().optional(),
    completionStatus: completionStatusSchema.optional(),
    hasDependencies: z.enum(['YES', 'NO']).optional(),
    releaseFrom: optionalDateString,
    releaseTo: optionalDateString,
    sort: z.string().max(40).optional(),
    dir: z.enum(['asc', 'desc']).optional(),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(5).max(200).optional(),
  })
  .strict();

export type Fy26PackageUpdate = z.infer<typeof fy26PackageUpdateSchema>;
export type Fy26DependencyCreate = z.infer<typeof fy26DependencyCreateSchema>;
export type Fy26DependencyUpdate = z.infer<typeof fy26DependencyUpdateSchema>;
export type Fy26ListFilters = z.infer<typeof fy26ListFiltersSchema>;

// ---------------------------------------------------------------------------
// Drawing Register / Drawing Control
// ---------------------------------------------------------------------------

export const drawingCreateSchema = z
  .object({
    projectId: z.string().min(1),
    /** Omit for a planned drawing that has no number yet. */
    drawingNumber: z.string().trim().min(1).max(80).nullable().optional(),
    drawingName: z.string().trim().min(1).max(400),
    phaseId: z.string().nullable().optional(),
    disciplineId: z.string().nullable().optional(),
    packageId: z.string().nullable().optional(),
    location: z.string().max(120).nullable().optional(),
    batchCode: z.string().max(80).nullable().optional(),
    batch: z.string().max(80).nullable().optional(),
    revision: z.string().trim().max(32).nullable().optional(),
    /** Becomes the baseline as well: a new drawing's first plan is its baseline. */
    expectedReleaseDate: optionalDateString,
    responsibleUserId: z.string().nullable().optional(),
    responsibleText: z.string().max(200).nullable().optional(),
    remarks: z.string().max(2000).nullable().optional(),
  })
  .strict();

export const drawingReleaseSchema = z
  .object({
    actualReleaseDate: dateString,
    revision: z.string().trim().min(1).max(32).optional(),
    remarks: z.string().max(2000).optional(),
  })
  .strict();

export const drawingUnreleaseSchema = z
  .object({ reason: z.string().trim().min(3, 'A reason is required to withdraw a release').max(500) })
  .strict();

export const drawingRevisionCreateSchema = z
  .object({
    revision: z.string().trim().min(1).max(32),
    expectedReleaseDate: optionalDateString,
    remarks: z.string().max(2000).optional(),
  })
  .strict();

export const drawingRevisionUpdateSchema = z
  .object({
    expectedReleaseDate: optionalDateString,
    remarks: z.string().max(2000).nullable().optional(),
  })
  .strict();

export const drawingDependencyCreateSchema = z
  .object({
    department: z.string().trim().min(1).max(120),
    ownerUserId: z.string().nullable().optional(),
    ownerText: z.string().max(200).nullable().optional(),
    description: z.string().trim().min(1).max(2000),
    targetDate: optionalDateString,
    remarks: z.string().max(2000).nullable().optional(),
  })
  .strict();

export const drawingDependencyUpdateSchema = z
  .object({
    department: z.string().trim().min(1).max(120).optional(),
    ownerUserId: z.string().nullable().optional(),
    ownerText: z.string().max(200).nullable().optional(),
    description: z.string().trim().min(1).max(2000).optional(),
    targetDate: optionalDateString,
    closureDate: optionalDateString,
    status: z.enum(['OPEN', 'CLOSED']).optional(),
    remarks: z.string().max(2000).nullable().optional(),
  })
  .strict();

export const drawingConflictActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('RESOLVE'), candidateIndex: z.number().int().min(0), note: z.string().trim().min(3).max(1000) }),
  z.object({ action: z.literal('DISMISS'), note: z.string().trim().min(3).max(1000) }),
]);

export const drawingImportSchema = z.object({ apply: z.boolean().default(false) }).strict();
