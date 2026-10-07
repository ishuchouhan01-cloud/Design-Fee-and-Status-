/**
 * Design Goals & Delivery Control System — database schema (Drizzle ORM,
 * PostgreSQL).
 *
 * Type choices
 * ------------
 *   text                    ids and codes (application-generated, see ids.ts)
 *   text + Zod enum         status/role "enums" — validated in the domain
 *                           layer rather than in the database, so adding a
 *                           value never needs a migration
 *   integer                 counts and quantities
 *   double precision        billing values and fee percentages (Cr.)
 *   timestamptz             every date, surfaced to the application as a Date
 *   boolean                 flags
 *
 * There are no JSON columns, array columns or database-native enums, which is
 * what let the same model run on SQLite during the pilot and keeps it portable
 * to any other SQL engine later. All queries go through the Drizzle query
 * builder in `src/lib/repo/*` and `src/lib/services/*`; the only files that
 * know which engine is in use are this one, `src/db/index.ts` and
 * `drizzle.config.ts`.
 */
import {
  type AnyPgColumn,
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/** `timestamptz` everywhere, surfaced to the application as a JS Date. */
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
/**
 * A "when did this happen" column, defaulted by the server.
 *
 * The column name is explicit because four tables call their timestamp
 * something other than created_at (`changed_at`, `timestamp`, `started_at`),
 * and the column should match the field rather than all being created_at.
 */
const now = (name = 'created_at') => ts(name).notNull().defaultNow();

// ---------------------------------------------------------------------------
// Reference / master data
// ---------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    role: text('role').notNull().default('VIEWER'), // ADMIN | MANAGER | EDITOR | VIEWER
    active: boolean('active').notNull().default(true),
    createdAt: now(),
    updatedAt: ts('updated_at'),
  },
  (t) => [uniqueIndex('users_email_uq').on(t.email), index('users_role_ix').on(t.role)],
);

export const disciplines = pgTable(
  'disciplines',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    category: text('category').notNull().default('DESIGN'),
    sortOrder: integer('sort_order').notNull().default(100),
    active: boolean('active').notNull().default(true),
    /** The fee discipline (AR | ST | MEP | LS) whose Design Fee this discipline's
     *  drawings are billed under in DFS (PHE → MEP, Master Planning → AR). Null:
     *  the discipline is its own group. Data, editable, never inferred. */
    dfsGroup: text('dfs_group'),
  },
  (t) => [uniqueIndex('disciplines_code_uq').on(t.code)],
);

export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(),
    projectCode: text('project_code').notNull(),
    projectName: text('project_name').notNull(),
    portfolio: text('portfolio').notNull().default('Ongoing'),
    phase: text('phase'),
    description: text('description'),
    location: text('location'),
    active: boolean('active').notNull().default(true),
    onHold: boolean('on_hold').notNull().default(false),
    /** Full name from the Project List ("Pursuit of a Radical Rhapsody"). The
     *  code is for search only; screens show this, else project_name. */
    displayName: text('display_name'),
    /** A project can group child products / towers (PoRR → Residential, Tower 08 …).
     *  A child keeps its own id, so every drawing, goal and history link survives. */
    parentProjectId: text('parent_project_id').references((): AnyPgColumn => projects.id, { onDelete: 'set null' }),
    displayOrder: integer('display_order'),
    /** Archived (soft delete) from Project Drawing Status: hidden, never removed. */
    archivedAt: ts('archived_at'),
    archivedByLabel: text('archived_by_label'),
    createdImportBatchId: text('created_import_batch_id'),
    createdAt: now(),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    uniqueIndex('projects_code_uq').on(t.projectCode),
    index('projects_parent_ix').on(t.parentProjectId),
    index('projects_portfolio_ix').on(t.portfolio),
    index('projects_active_ix').on(t.active),
  ],
);

export const projectPhases = pgTable(
  'project_phases',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    sequence: integer('sequence').notNull().default(100),
    active: boolean('active').notNull().default(true),
  },
  (t) => [
    uniqueIndex('project_phases_uq').on(t.projectId, t.code),
    index('project_phases_project_ix').on(t.projectId),
  ],
);

export const criticalRequirements = pgTable(
  'critical_requirements',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    phaseLabel: text('phase_label'),
    requirement: text('requirement').notNull(),
  },
  (t) => [index('critical_requirements_project_ix').on(t.projectId)],
);

// ---------------------------------------------------------------------------
// DFS WBS — the base DFS hierarchy above packages
// ---------------------------------------------------------------------------

/**
 * One node of a project's base-DFS tree above the package level: Phase,
 * Tower, Product, Block, Villa or another source-defined group. `parent_id`
 * preserves the source tree; packages hang off a node through
 * `packages.wbs_node_id`, disciplines and drawings off the package. Nodes come
 * only from the base DFS (Design Fee sheet) — never from drawing or batch codes.
 * `node_key` is the node's stable path in the source (section / label chain),
 * so a re-import updates the same row.
 */
export const dfsWbsNodes = pgTable(
  'dfs_wbs_nodes',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    parentId: text('parent_id').references((): AnyPgColumn => dfsWbsNodes.id, { onDelete: 'set null' }),
    nodeType: text('node_type').notNull(), // PHASE | TOWER | PRODUCT | BLOCK | VILLA | GROUP
    name: text('name').notNull(),
    code: text('code'),
    /** The heading exactly as the source wrote it (e.g. "GFC | Tower—01"). */
    sourceLabel: text('source_label'),
    nodeKey: text('node_key').notNull(),
    sequence: integer('sequence').notNull().default(0),
    sourceWorkbook: text('source_workbook'),
    sourceSheet: text('source_sheet'),
    sourceRow: integer('source_row'),
    importBatchId: text('import_batch_id'),
    /** The import run that created this row (for "Undo this import"). */
    createdImportBatchId: text('created_import_batch_id'),
    userEditedFields: text('user_edited_fields').notNull().default(''),
    createdAt: now(),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    uniqueIndex('dfs_wbs_nodes_uq').on(t.projectId, t.nodeKey),
    index('dfs_wbs_nodes_parent_ix').on(t.parentId),
    index('dfs_wbs_nodes_project_ix').on(t.projectId),
  ],
);

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

export const packages = pgTable(
  'packages',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    phaseId: text('phase_id').references(() => projectPhases.id),
    packageCode: text('package_code').notNull(),
    packageName: text('package_name').notNull(),
    packageGroup: text('package_group'),
    sequence: integer('sequence').notNull().default(100),
    durationDays: integer('duration_days'),
    baselineStartDate: ts('baseline_start_date'),
    baselineReleaseDate: ts('baseline_release_date'),
    currentExpectedReleaseDate: ts('current_expected_release_date'),
    actualReleaseDate: ts('actual_release_date'),
    remarks: text('remarks'),
    rescheduleCount: integer('reschedule_count').notNull().default(0),
    // Source traceability for packages imported from a Design Fee sheet (additive).
    sourceWorkbook: text('source_workbook'),
    sourceSheet: text('source_sheet'),
    sourceRow: integer('source_row'),
    importBatchId: text('import_batch_id'),
    /** The import run that created this row (for "Undo this import"). */
    createdImportBatchId: text('created_import_batch_id'),
    /** Parent node in the base-DFS tree (additive; null for packages without a DFS). */
    wbsNodeId: text('wbs_node_id').references(() => dfsWbsNodes.id, { onDelete: 'set null' }),
    /** Responsible Person: a user where the name matches, else the name as given. */
    responsibleUserId: text('responsible_user_id').references(() => users.id),
    responsibleText: text('responsible_text'),
    /** The code the source gave the package; an import finds the package by it
     *  even after the code is changed in Edit Mode. */
    sourceCode: text('source_code'),
    /** Fields a person changed; an import never overwrites them. */
    userEditedFields: text('user_edited_fields').notNull().default(''),
    /** Archived (soft delete): hidden everywhere, never removed. */
    archivedAt: ts('archived_at'),
    archivedByLabel: text('archived_by_label'),
    /** One fee for the whole package (Design Fee sheets with a Total Fee /
     *  Balance column set): Total (Cr.), Billed ("Billed till Dec'yy"), and the
     *  source's Released Till Date and Balance kept for reconciliation. Null when
     *  the fee is per discipline (package_fees). Never split over disciplines. */
    feeValue: doublePrecision('fee_value'),
    billedToDateValue: doublePrecision('billed_to_date_value'),
    releasedToDateValue: doublePrecision('released_to_date_value'),
    balanceValue: doublePrecision('balance_value'),
    createdAt: now(),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    index('packages_wbs_node_ix').on(t.wbsNodeId),
    uniqueIndex('packages_uq').on(t.projectId, t.packageCode),
    index('packages_project_ix').on(t.projectId),
  ],
);

export const packageFees = pgTable(
  'package_fees',
  {
    id: text('id').primaryKey(),
    packageId: text('package_id').notNull().references(() => packages.id, { onDelete: 'cascade' }),
    disciplineId: text('discipline_id').notNull().references(() => disciplines.id),
    feePercent: doublePrecision('fee_percent'),
    /** Billing SCOPE for this package + discipline (Cr.). Never overwritten by actuals. */
    feeValue: doublePrecision('fee_value'),
    /** Billing recorded in the source to date ("Billed YTD"), kept for
     *  reconciliation against the DFS-derived Actual. Never used as completion. */
    billedToDateValue: doublePrecision('billed_to_date_value'),
    /** APPLICABLE | NA. NA is explicit and distinct from complete. */
    applicability: text('applicability').notNull().default('APPLICABLE'),
    sourceWorkbook: text('source_workbook'),
    sourceSheet: text('source_sheet'),
    sourceRow: integer('source_row'),
    userEditedFields: text('user_edited_fields').notNull().default(''),
    /** The import run that created this row (for "Undo this import"). */
    createdImportBatchId: text('created_import_batch_id'),
    updatedAt: ts('updated_at'),
  },
  (t) => [uniqueIndex('package_fees_uq').on(t.packageId, t.disciplineId)],
);

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

export const goals = pgTable(
  'goals',
  {
    id: text('id').primaryKey(),
    goalCode: text('goal_code').notNull(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    phaseId: text('phase_id').references(() => projectPhases.id),
    disciplineId: text('discipline_id').references(() => disciplines.id),
    designLeadId: text('design_lead_id').references(() => users.id),

    goalDescription: text('goal_description').notNull(),
    fiscalYear: text('fiscal_year').notNull(),
    quarter: integer('quarter').notNull(),
    periodStart: ts('period_start').notNull(),
    periodEnd: ts('period_end').notNull(),

    plannedQuantity: integer('planned_quantity').notNull().default(0),
    plannedValue: doublePrecision('planned_value').notNull().default(0),
    reportedActualQuantity: integer('reported_actual_quantity').notNull().default(0),
    reportedActualValue: doublePrecision('reported_actual_value').notNull().default(0),

    baselineTargetDate: ts('baseline_target_date').notNull(),
    currentExpectedDate: ts('current_expected_date').notNull(),
    actualCompletionDate: ts('actual_completion_date'),

    completionStatus: text('completion_status').notNull().default('NOT_COMPLETED'),
    priority: text('priority').notNull().default('MEDIUM'),
    remarks: text('remarks'),
    sourceSheet: text('source_sheet'),
    sourceRow: integer('source_row'),
    isBaselineRevision: boolean('is_baseline_revision').notNull().default(false),
    rescheduleCount: integer('reschedule_count').notNull().default(0),

    createdAt: now(),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    uniqueIndex('goals_code_uq').on(t.goalCode),
    index('goals_project_ix').on(t.projectId),
    index('goals_period_ix').on(t.fiscalYear, t.quarter),
    index('goals_discipline_ix').on(t.disciplineId),
    index('goals_lead_ix').on(t.designLeadId),
    index('goals_completion_ix').on(t.completionStatus),
    index('goals_expected_ix').on(t.currentExpectedDate),
  ],
);

export const teamAssignments = pgTable(
  'team_assignments',
  {
    id: text('id').primaryKey(),
    goalId: text('goal_id').notNull().references(() => goals.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id),
    personName: text('person_name').notNull(),
    roleOnGoal: text('role_on_goal').notNull(),
  },
  (t) => [index('team_assignments_goal_ix').on(t.goalId)],
);

export const goalRevisions = pgTable(
  'goal_revisions',
  {
    id: text('id').primaryKey(),
    goalId: text('goal_id').notNull().references(() => goals.id, { onDelete: 'cascade' }),
    previousExpectedDate: ts('previous_expected_date'),
    newExpectedDate: ts('new_expected_date'),
    previousTargetQuantity: integer('previous_target_quantity'),
    newTargetQuantity: integer('new_target_quantity'),
    previousTargetValue: doublePrecision('previous_target_value'),
    newTargetValue: doublePrecision('new_target_value'),
    reason: text('reason'),
    changedById: text('changed_by_id').references(() => users.id),
    changedAt: now('changed_at'),
    impactSummary: text('impact_summary'),
  },
  (t) => [index('goal_revisions_goal_ix').on(t.goalId)],
);

// ---------------------------------------------------------------------------
// Deliverables & drawings — BINARY completion only
// ---------------------------------------------------------------------------

export const deliverables = pgTable(
  'design_deliverables',
  {
    id: text('id').primaryKey(),
    deliverableCode: text('deliverable_code').notNull(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    phaseId: text('phase_id').references(() => projectPhases.id),
    goalId: text('goal_id').references(() => goals.id),
    packageId: text('package_id').references(() => packages.id),
    disciplineId: text('discipline_id').references(() => disciplines.id),

    deliverableDescription: text('deliverable_description').notNull(),
    baselineReleaseDate: ts('baseline_release_date').notNull(),
    currentExpectedReleaseDate: ts('current_expected_release_date').notNull(),
    actualReleaseDate: ts('actual_release_date'),
    completionStatus: text('completion_status').notNull().default('NOT_COMPLETED'),
    ownerId: text('owner_id').references(() => users.id),
    revision: text('revision'),
    remarks: text('remarks'),
    fiscalYear: text('fiscal_year'),
    quarter: integer('quarter'),
    sourceSheet: text('source_sheet'),
    rescheduleCount: integer('reschedule_count').notNull().default(0),

    createdAt: now(),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    uniqueIndex('deliverables_code_uq').on(t.deliverableCode),
    index('deliverables_project_ix').on(t.projectId),
    index('deliverables_package_ix').on(t.packageId),
    index('deliverables_goal_ix').on(t.goalId),
    index('deliverables_completion_ix').on(t.completionStatus),
    index('deliverables_expected_ix').on(t.currentExpectedReleaseDate),
    index('deliverables_discipline_ix').on(t.disciplineId),
  ],
);

export const drawings = pgTable(
  'drawings',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    phaseId: text('phase_id').references(() => projectPhases.id),
    packageId: text('package_id').references(() => packages.id),
    disciplineId: text('discipline_id').references(() => disciplines.id),

    drawingCode: text('drawing_code').notNull(),
    drawingNumber: text('drawing_number'),
    drawingName: text('drawing_name').notNull(),
    areaOfWorks: text('area_of_works'),
    location: text('location'),
    stageCode: text('stage_code'),
    batchCode: text('batch_code'),
    batch: text('batch'),
    issueType: text('issue_type'),
    revision: text('revision'),

    baselineReleaseDate: ts('baseline_release_date'),
    currentExpectedReleaseDate: ts('current_expected_release_date'),
    actualReleaseDate: ts('actual_release_date'),
    completionStatus: text('completion_status').notNull().default('NOT_COMPLETED'),
    remarks: text('remarks'),
    planPeriodLabel: text('plan_period_label'),
    rescheduleCount: integer('reschedule_count').notNull().default(0),

    // --- Drawing Register / Drawing Control (additive, Stage 2) -------------
    /** NUMBERED | NOT_YET_NUMBERED. A not-yet-numbered drawing keeps its
     *  record when a number is assigned later — the number is an update, not
     *  a new drawing. */
    numberStatus: text('number_status').notNull().default('NUMBERED'),
    /** A bare sheet number from the source (e.g. `4101`) when the full
     *  drawing number has not been assigned yet. */
    partialNumber: text('partial_number'),
    /** Import identity: `NO:<number>` or `NYN:<disc>|<batch>|<title>|<partial>`.
     *  Kept when a number is assigned so a re-import finds the same record. */
    sourceKey: text('source_key'),
    responsibleUserId: text('responsible_user_id').references(() => users.id),
    responsibleText: text('responsible_text'),
    /** ACC (Autodesk Construction Cloud) export fields — T09 only today. */
    collection: text('collection'),
    versionCount: integer('version_count'),
    tags: text('tags'),
    accDiscipline: text('acc_discipline'),
    /** ACC bulk-upload timestamp. Kept for traceability; NEVER a release date. */
    accCreatedAt: ts('acc_created_at'),
    /** Why the drawing is known to be released when no actual date exists,
     *  e.g. "Issued before 01-Jan-2026". Evidence, not a date. */
    releaseEvidence: text('release_evidence'),
    releasedById: text('released_by_id').references(() => users.id),
    releasedByLabel: text('released_by_label'),
    releasedAt: ts('released_at'),
    /** Created through "+ Add Drawing" rather than imported. */
    isManual: boolean('is_manual').notNull().default(false),
    sourceWorkbook: text('source_workbook'),
    sourceSheet: text('source_sheet'),
    sourceRow: integer('source_row'),
    importBatchId: text('import_batch_id'),
    /** The import run that created this row (for "Undo this import"). */
    createdImportBatchId: text('created_import_batch_id'),
    /** Comma-delimited field names a user has edited; importers never
     *  overwrite a field listed here. */
    userEditedFields: text('user_edited_fields').notNull().default(''),

    /**
     * "Updated On", from the source: the drawing's own date in the workbook
     * (release / issue date, date of receipt, Autodesk Construction Cloud
     * release date, a revision-date column). Written by imports only.
     */
    sourceDate: ts('source_date'),
    /** When the source gives only a period ("Quarter 2, 2026", "2025", "Before 01-Jan-2026"). */
    sourcePeriodLabel: text('source_period_label'),
    /** The period's first and last day, for sorting and filtering. */
    sourcePeriodStart: ts('source_period_start'),
    sourcePeriodEnd: ts('source_period_end'),
    /** The last time a person changed the drawing in Drawing Control. Never set by an import. */
    editedAt: ts('edited_at'),
    /** Archived (soft delete): hidden everywhere, never removed. */
    archivedAt: ts('archived_at'),
    archivedByLabel: text('archived_by_label'),

    createdAt: now(),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    index('drawings_updated_on_ix').on(t.editedAt, t.sourceDate, t.sourcePeriodEnd),
    // Kept so the migration stays additive. Identity is now project + number
    // (drawings_project_code_uq), which is strictly tighter.
    uniqueIndex('drawings_uq').on(t.projectId, t.drawingCode, t.batchCode),
    uniqueIndex('drawings_project_code_uq').on(t.projectId, t.drawingCode),
    uniqueIndex('drawings_source_key_uq').on(t.projectId, t.sourceKey),
    index('drawings_project_ix').on(t.projectId),
    index('drawings_package_ix').on(t.packageId),
    index('drawings_completion_ix').on(t.completionStatus),
    index('drawings_expected_ix').on(t.currentExpectedReleaseDate),
    index('drawings_discipline_ix').on(t.disciplineId),
    index('drawings_phase_ix').on(t.phaseId),
    index('drawings_number_status_ix').on(t.numberStatus),
    index('drawings_responsible_ix').on(t.responsibleUserId),
    index('drawings_batch_ix').on(t.batchCode),
  ],
);

/**
 * Every revision a drawing has had. `drawings.revision` is the latest; rows
 * here are never overwritten or deleted by an import. Releasing a revision
 * stamps released-by / released-at / actual date on its row.
 */
export const drawingRevisions = pgTable(
  'drawing_revisions',
  {
    id: text('id').primaryKey(),
    drawingId: text('drawing_id').notNull().references(() => drawings.id, { onDelete: 'cascade' }),
    revision: text('revision'),
    sequence: integer('sequence').notNull().default(0),
    expectedReleaseDate: ts('expected_release_date'),
    actualReleaseDate: ts('actual_release_date'),
    completionStatus: text('completion_status').notNull().default('NOT_COMPLETED'),
    releaseEvidence: text('release_evidence'),
    releasedById: text('released_by_id').references(() => users.id),
    releasedByLabel: text('released_by_label'),
    releasedAt: ts('released_at'),
    remarks: text('remarks'),
    /** The import run that created this row (for "Undo this import"). */
    createdImportBatchId: text('created_import_batch_id'),
    /** IMPORT | ACC | MANUAL */
    source: text('source').notNull().default('MANUAL'),
    sourceWorkbook: text('source_workbook'),
    sourceSheet: text('source_sheet'),
    sourceRow: integer('source_row'),
    snapshotLabel: text('snapshot_label'),
    createdById: text('created_by_id').references(() => users.id),
    createdByLabel: text('created_by_label'),
    createdAt: now(),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    uniqueIndex('drawing_revisions_uq').on(t.drawingId, t.revision),
    index('drawing_revisions_drawing_ix').on(t.drawingId),
  ],
);

/**
 * Department / task dependencies for operational drawing coordination
 * ("Percolation pit location & size" from PHE, target, closure, status).
 *
 * NOT the same thing as `dependencies`, which holds FS/SS/FF scheduling links
 * for the reschedule engine. The two are deliberately separate tables.
 */
export const drawingDependencies = pgTable(
  'drawing_dependencies',
  {
    id: text('id').primaryKey(),
    drawingId: text('drawing_id').notNull().references(() => drawings.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    department: text('department').notNull(),
    ownerUserId: text('owner_user_id').references(() => users.id),
    ownerText: text('owner_text'),
    description: text('description').notNull(),
    targetDate: ts('target_date'),
    closureDate: ts('closure_date'),
    status: text('status').notNull().default('OPEN'), // OPEN | CLOSED
    remarks: text('remarks'),
    isManual: boolean('is_manual').notNull().default(true),
    source: text('source').notNull().default('MANUAL'),
    userEditedFields: text('user_edited_fields').notNull().default(''),
    createdById: text('created_by_id').references(() => users.id),
    createdByLabel: text('created_by_label'),
    createdAt: now(),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    index('drawing_dependencies_drawing_ix').on(t.drawingId),
    index('drawing_dependencies_project_ix').on(t.projectId),
    index('drawing_dependencies_status_ix').on(t.status),
  ],
);

export const drawingImportBatches = pgTable('drawing_import_batches', {
  id: text('id').primaryKey(),
  manifest: text('manifest').notNull(),
  status: text('status').notNull().default('PREVIEW'), // PREVIEW | APPLIED | FAILED
  startedAt: now('started_at'),
  finishedAt: ts('finished_at'),
  summaryJson: text('summary_json').notNull().default('{}'),
  createdCount: integer('created_count').notNull().default(0),
  updatedCount: integer('updated_count').notNull().default(0),
  protectedCount: integer('protected_count').notNull().default(0),
  conflictCount: integer('conflict_count').notNull().default(0),
  warningCount: integer('warning_count').notNull().default(0),
  errorCount: integer('error_count').notNull().default(0),
  startedById: text('started_by_id').references(() => users.id),
  startedByLabel: text('started_by_label'),
  /** Import Centre runs: what was imported and whether it was undone. */
  fileType: text('file_type'), // PLAN | DESIGN_FEE | ACC | PROJECT_LIST | MANIFEST
  fileNames: text('file_names'),
  projectId: text('project_id'),
  undoneAt: ts('undone_at'),
  undoneByLabel: text('undone_by_label'),
});

/**
 * Field changes an import made to EXISTING rows that "Undo this import" may put
 * back (release updates from an Autodesk Construction Cloud export). Created
 * rows are tracked by `created_import_batch_id` on the row itself.
 */
export const importRunChanges = pgTable(
  'import_run_changes',
  {
    id: text('id').primaryKey(),
    batchId: text('batch_id').notNull().references(() => drawingImportBatches.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    field: text('field').notNull(),
    oldValue: text('old_value'),
    newValue: text('new_value'),
    createdAt: now(),
  },
  (t) => [index('import_run_changes_batch_ix').on(t.batchId)],
);

/** The column mapping a user confirmed in the Import Centre, remembered per project and file type. */
export const importMappings = pgTable(
  'import_mappings',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    fileType: text('file_type').notNull(),
    /** JSON text: sheet name pattern → { column role → column letter }. */
    mapping: text('mapping').notNull().default('{}'),
    updatedByLabel: text('updated_by_label'),
    updatedAt: ts('updated_at'),
  },
  (t) => [uniqueIndex('import_mappings_uq').on(t.projectId, t.fileType)],
);

export const drawingImportIssues = pgTable(
  'drawing_import_issues',
  {
    id: text('id').primaryKey(),
    batchId: text('batch_id').notNull().references(() => drawingImportBatches.id, { onDelete: 'cascade' }),
    severity: text('severity').notNull(), // INFO | WARNING | ERROR
    code: text('code').notNull(),
    projectCode: text('project_code'),
    drawingNumber: text('drawing_number'),
    workbook: text('workbook'),
    sheet: text('sheet'),
    rowNumber: integer('row_number'),
    message: text('message').notNull(),
    payload: text('payload'),
  },
  (t) => [
    index('drawing_import_issues_batch_ix').on(t.batchId),
    index('drawing_import_issues_code_ix').on(t.code),
  ],
);

/**
 * Source rows the importer could not turn into a drawing without a human
 * decision: the same number with different titles, or an ACC number that is
 * not in the register. Held here (not imported) until an admin resolves them.
 */
export const drawingConflicts = pgTable(
  'drawing_conflicts',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    conflictType: text('conflict_type').notNull(), // NUMBER_TITLE_CONFLICT | ACC_ONLY_NUMBER
    drawingNumber: text('drawing_number').notNull(),
    status: text('status').notNull().default('OPEN'), // OPEN | RESOLVED | DISMISSED
    candidateCount: integer('candidate_count').notNull().default(0),
    /** JSON array of the conflicting source rows (text, like import payloads). */
    candidates: text('candidates').notNull().default('[]'),
    message: text('message'),
    resolutionNote: text('resolution_note'),
    resolvedDrawingId: text('resolved_drawing_id').references(() => drawings.id, { onDelete: 'set null' }),
    resolvedById: text('resolved_by_id').references(() => users.id),
    resolvedByLabel: text('resolved_by_label'),
    resolvedAt: ts('resolved_at'),
    importBatchId: text('import_batch_id').references(() => drawingImportBatches.id, { onDelete: 'set null' }),
    createdAt: now(),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    uniqueIndex('drawing_conflicts_uq').on(t.projectId, t.conflictType, t.drawingNumber),
    index('drawing_conflicts_status_ix').on(t.status),
  ],
);

/**
 * One row per source-workbook row, current and historical. The yearly 03YPlan
 * snapshots are history: they are preserved here and never overwrite the
 * current drawing record.
 */
export const drawingSnapshots = pgTable(
  'drawing_snapshots',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    drawingId: text('drawing_id').references(() => drawings.id, { onDelete: 'set null' }),
    snapshotRole: text('snapshot_role').notNull(), // CURRENT | HISTORICAL
    sourceKind: text('source_kind').notNull(), // PLAN | REGISTER | ACC
    snapshotLabel: text('snapshot_label').notNull(),
    snapshotDate: ts('snapshot_date'),
    planYear: integer('plan_year'),
    sourceWorkbook: text('source_workbook').notNull(),
    sourceSheet: text('source_sheet').notNull(),
    sourceRow: integer('source_row').notNull(),
    disciplineCode: text('discipline_code'),
    section: text('section'),
    location: text('location'),
    batchCode: text('batch_code'),
    batch: text('batch'),
    drawingNumber: text('drawing_number'),
    numberKind: text('number_kind'),
    partialNumber: text('partial_number'),
    title: text('title'),
    revision: text('revision'),
    released: boolean('released').notNull().default(false),
    issuedBeforeYear: boolean('issued_before_year').notNull().default(false),
    issuedQuarter: integer('issued_quarter'),
    plannedQuarter: integer('planned_quarter'),
    explicitDateText: text('explicit_date_text'),
    inAcc: text('in_acc'),
    collection: text('collection'),
    versionCount: integer('version_count'),
    tags: text('tags'),
    accDiscipline: text('acc_discipline'),
    accReleaseDate: ts('acc_release_date'),
    accCreatedAt: ts('acc_created_at'),
    importBatchId: text('import_batch_id').references(() => drawingImportBatches.id, { onDelete: 'set null' }),
    /** The import run that created this row (for "Undo this import"). */
    createdImportBatchId: text('created_import_batch_id'),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex('drawing_snapshots_source_uq').on(t.sourceWorkbook, t.sourceSheet, t.sourceRow),
    index('drawing_snapshots_drawing_ix').on(t.drawingId),
    index('drawing_snapshots_project_ix').on(t.projectId, t.snapshotRole),
    index('drawing_snapshots_number_ix').on(t.projectId, t.drawingNumber),
  ],
);

/**
 * Explicit location → phase mapping for drawings, like `fy26_scope_map`.
 * `zone_code` ('' = any) lets a multi-tower location be split by the zone
 * token in the drawing number (`S-T4V-…` → T4). `phase_id` NULL means "no
 * phase can be established" and the importer raises UNMAPPED_DRAWING_LOCATION.
 */
export const drawingLocationPhaseMap = pgTable(
  'drawing_location_phase_map',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    locationCode: text('location_code').notNull(),
    zoneCode: text('zone_code').notNull().default(''),
    phaseId: text('phase_id').references(() => projectPhases.id, { onDelete: 'set null' }),
    rule: text('rule').notNull(), // EXACT | GOALS_PHASE | PROJECT_SINGLE_PHASE | NO_PHASE | MULTI_PHASE
    note: text('note'),
    createdAt: now(),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    uniqueIndex('drawing_location_phase_map_uq').on(t.projectId, t.locationCode, t.zoneCode),
  ],
);

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export const dependencies = pgTable(
  'dependencies',
  {
    id: text('id').primaryKey(),
    predecessorType: text('predecessor_type').notNull(),
    predecessorId: text('predecessor_id').notNull(),
    successorType: text('successor_type').notNull(),
    successorId: text('successor_id').notNull(),
    dependencyType: text('dependency_type').notNull().default('FS'), // FS | SS | FF
    lagDays: integer('lag_days').notNull().default(0),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex('dependencies_uq').on(t.predecessorType, t.predecessorId, t.successorType, t.successorId),
    index('dependencies_pred_ix').on(t.predecessorType, t.predecessorId),
    index('dependencies_succ_ix').on(t.successorType, t.successorId),
  ],
);

export const rescheduleHistory = pgTable(
  'reschedule_history',
  {
    id: text('id').primaryKey(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    entityLabel: text('entity_label'),
    oldDate: ts('old_date'),
    newDate: ts('new_date'),
    daysShift: integer('days_shift').notNull().default(0),
    reason: text('reason'),
    scope: text('scope').notNull().default('ITEM'),
    batchId: text('batch_id'),
    cascaded: boolean('cascaded').notNull().default(false),
    changedById: text('changed_by_id').references(() => users.id),
    changedByLabel: text('changed_by_label'),
    changedAt: now('changed_at'),
    impactedRecords: integer('impacted_records').notNull().default(1),
    projectId: text('project_id'),
  },
  (t) => [
    index('reschedule_entity_ix').on(t.entityType, t.entityId),
    index('reschedule_changed_ix').on(t.changedAt),
    index('reschedule_batch_ix').on(t.batchId),
    index('reschedule_project_ix').on(t.projectId),
  ],
);

export const ragOverrides = pgTable(
  'rag_overrides',
  {
    id: text('id').primaryKey(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    projectId: text('project_id'),
    calculatedRag: text('calculated_rag').notNull(),
    overrideRag: text('override_rag').notNull(),
    reason: text('reason'),
    userId: text('user_id').references(() => users.id),
    userLabel: text('user_label'),
    createdAt: now(),
    active: boolean('active').notNull().default(true),
  },
  (t) => [index('rag_overrides_entity_ix').on(t.entityType, t.entityId)],
);

// ---------------------------------------------------------------------------
// Audit + import bookkeeping
// ---------------------------------------------------------------------------

export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => users.id),
    userLabel: text('user_label'),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    entityLabel: text('entity_label'),
    action: text('action').notNull(),
    field: text('field'),
    oldValue: text('old_value'),
    newValue: text('new_value'),
    reason: text('reason'),
    projectId: text('project_id'),
    timestamp: now('timestamp'),
  },
  (t) => [
    index('audit_entity_ix').on(t.entityType, t.entityId),
    index('audit_time_ix').on(t.timestamp),
    index('audit_action_ix').on(t.action),
    index('audit_project_ix').on(t.projectId),
  ],
);

export const importRuns = pgTable('import_runs', {
  id: text('id').primaryKey(),
  workbook: text('workbook').notNull(),
  startedAt: now('started_at'),
  finishedAt: ts('finished_at'),
  status: text('status').notNull().default('RUNNING'),
  summaryJson: text('summary_json').notNull().default('{}'),
  createdCount: integer('created_count').notNull().default(0),
  updatedCount: integer('updated_count').notNull().default(0),
  skippedCount: integer('skipped_count').notNull().default(0),
  warningCount: integer('warning_count').notNull().default(0),
  errorCount: integer('error_count').notNull().default(0),
});

export const importIssues = pgTable(
  'import_issues',
  {
    id: text('id').primaryKey(),
    importRunId: text('import_run_id').notNull().references(() => importRuns.id, { onDelete: 'cascade' }),
    severity: text('severity').notNull(),
    workbook: text('workbook'),
    sheet: text('sheet'),
    rowNumber: integer('row_number'),
    code: text('code').notNull(),
    message: text('message').notNull(),
    payload: text('payload'),
  },
  (t) => [
    index('import_issues_run_ix').on(t.importRunId),
    index('import_issues_sev_ix').on(t.severity),
  ],
);

export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: ts('updated_at'),
});

// ---------------------------------------------------------------------------
// DESIGN GOALS FY 26
//
// A self-contained module. It never writes to the tables above: the FY26
// hierarchy (project -> phase -> package -> dependency) lives in its own
// tables and *links* to the existing `projects` rows through nullable FKs.
// That is deliberate — the two models disagree about where the project/phase
// boundary sits (the legacy model calls `ITQE-Ph1` a project; FY26 calls it a
// phase of `ITQE`), and `projects.id` is referenced by six tables, so renaming
// or re-parenting production rows would break Projects, Goals, Design
// Delivery, Drawings, Schedule, Gantt, Audit and both legacy importers.
//
// There is deliberately NO billing-date column anywhere below: the source
// workbooks contain billing *amounts* and a single release date, and a billing
// date is never derived from either.
// ---------------------------------------------------------------------------

/**
 * The explicit normalisation layer. Every distinct column-B label from the
 * workbooks maps here to a resolved project/phase. A label that is absent is
 * rejected to `fy26_import_issues` rather than guessed — banner nesting in the
 * source is not a reliable project/phase signal (it would make `Blue in Green`
 * a phase of `OTF`, and `TR Mills Chamarajpet` a phase of `KIADB - Mys`).
 */
export const fy26ScopeMap = pgTable(
  'fy26_scope_map',
  {
    id: text('id').primaryKey(),
    sourceLabel: text('source_label').notNull(),
    sourceWorkbook: text('source_workbook').notNull(),
    level: text('level').notNull(), // PROJECT | PHASE | PACKAGE_SCOPE
    projectName: text('project_name').notNull(),
    phaseName: text('phase_name'),
    legacyProjectCode: text('legacy_project_code'),
    confirmed: boolean('confirmed').notNull().default(false),
    notes: text('notes'),
    createdAt: now(),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    uniqueIndex('fy26_scope_map_label_uq').on(t.sourceLabel),
    index('fy26_scope_map_project_ix').on(t.projectName),
  ],
);

export const fy26Projects = pgTable(
  'fy26_projects',
  {
    id: text('id').primaryKey(),
    projectKey: text('project_key').notNull(),
    projectName: text('project_name').notNull(),
    projectCode: text('project_code'),
    /** The existing `projects` row this FY26 project corresponds to, if any. */
    legacyProjectId: text('legacy_project_id').references(() => projects.id, { onDelete: 'set null' }),
    sortOrder: integer('sort_order').notNull().default(100),
    active: boolean('active').notNull().default(true),
    createdAt: now(),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    uniqueIndex('fy26_projects_key_uq').on(t.projectKey),
    index('fy26_projects_legacy_ix').on(t.legacyProjectId),
  ],
);

export const fy26Phases = pgTable(
  'fy26_phases',
  {
    id: text('id').primaryKey(),
    fy26ProjectId: text('fy26_project_id').notNull().references(() => fy26Projects.id, { onDelete: 'cascade' }),
    phaseKey: text('phase_key').notNull(),
    phaseName: text('phase_name').notNull(),
    /** Verbatim column-B label, e.g. `ITQE-Ph1`, `Violet Hill [21.76a]`. */
    sourceLabel: text('source_label').notNull(),
    /** The legacy `projects` row for THIS phase — the FY26 phase `OTR/PH01`
     *  corresponds to the legacy project `OTR-PH01`. */
    legacyProjectId: text('legacy_project_id').references(() => projects.id, { onDelete: 'set null' }),
    sequence: integer('sequence').notNull().default(100),
    createdAt: now(),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    uniqueIndex('fy26_phases_uq').on(t.fy26ProjectId, t.phaseKey),
    index('fy26_phases_project_ix').on(t.fy26ProjectId),
  ],
);

export const fy26ImportBatches = pgTable('fy26_import_batches', {
  id: text('id').primaryKey(),
  status: text('status').notNull().default('PREVIEW'), // PREVIEW | APPLIED | DISCARDED | FAILED
  sourceFolder: text('source_folder').notNull(),
  workbookCount: integer('workbook_count').notNull().default(0),
  startedAt: now('started_at'),
  finishedAt: ts('finished_at'),
  previewJson: text('preview_json').notNull().default('{}'),
  createdCount: integer('created_count').notNull().default(0),
  updatedCount: integer('updated_count').notNull().default(0),
  skippedCount: integer('skipped_count').notNull().default(0),
  protectedCount: integer('protected_count').notNull().default(0),
  warningCount: integer('warning_count').notNull().default(0),
  errorCount: integer('error_count').notNull().default(0),
  startedById: text('started_by_id').references(() => users.id),
  appliedById: text('applied_by_id').references(() => users.id),
  appliedAt: ts('applied_at'),
});

export const fy26Packages = pgTable(
  'fy26_packages',
  {
    id: text('id').primaryKey(),
    naturalKey: text('natural_key').notNull(),
    fy26ProjectId: text('fy26_project_id').notNull().references(() => fy26Projects.id, { onDelete: 'cascade' }),
    fy26PhaseId: text('fy26_phase_id').references(() => fy26Phases.id, { onDelete: 'set null' }),
    disciplineId: text('discipline_id').references(() => disciplines.id),

    packageDescription: text('package_description').notNull(),
    /** Verbatim column B on the package row: `OWC`, `UGT, WTP`, `OTF [V35]`. */
    sourceScopeLabel: text('source_scope_label'),
    responsibleUserId: text('responsible_user_id').references(() => users.id),
    responsibleSourceText: text('responsible_source_text'),

    /** Set once, on first import. Never writable afterwards. */
    baselineReleaseDate: ts('baseline_release_date'),
    currentExpectedReleaseDate: ts('current_expected_release_date'),
    /** Not present in the source — always null on import, never invented. */
    actualReleaseDate: ts('actual_release_date'),

    planBillingCr: doublePrecision('plan_billing_cr'),
    actualBillingCr: doublePrecision('actual_billing_cr'),
    plannedPackageQuantity: integer('planned_package_quantity'),
    actualPackageQuantity: integer('actual_package_quantity'),

    remarks: text('remarks'),
    completionStatus: text('completion_status').notNull().default('NOT_COMPLETED'),
    revisionCount: integer('revision_count').notNull().default(0),
    /** Comma-delimited field names a user has edited; the importer never
     *  overwrites a field listed here. */
    userEditedFields: text('user_edited_fields').notNull().default(''),

    sourceWorkbook: text('source_workbook').notNull(),
    sourceSheet: text('source_sheet').notNull(),
    sourceRow: integer('source_row').notNull(),
    importBatchId: text('import_batch_id').references(() => fy26ImportBatches.id, { onDelete: 'set null' }),

    createdAt: now(),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    uniqueIndex('fy26_packages_natural_uq').on(t.naturalKey),
    index('fy26_packages_project_ix').on(t.fy26ProjectId),
    index('fy26_packages_phase_ix').on(t.fy26PhaseId),
    index('fy26_packages_discipline_ix').on(t.disciplineId),
    index('fy26_packages_responsible_ix').on(t.responsibleUserId),
    index('fy26_packages_completion_ix').on(t.completionStatus),
    index('fy26_packages_expected_ix').on(t.currentExpectedReleaseDate),
  ],
);

/**
 * The task/dependency rows that follow a package in the workbooks.
 *
 * Not to be confused with `dependencies`, which is the *scheduling-link* table
 * (predecessor/successor, FS/SS/FF, lag) used by the reschedule engine.
 *
 * `stepLabel` is nullable on purpose: 65 genuine dependency rows in the source
 * carry no `Step N` marker at all, only a description, date, owner and remark.
 */
export const fy26PackageDependencies = pgTable(
  'fy26_package_dependencies',
  {
    id: text('id').primaryKey(),
    naturalKey: text('natural_key').notNull(),
    fy26PackageId: text('fy26_package_id').notNull().references(() => fy26Packages.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull().default(100),
    stepLabel: text('step_label'),
    description: text('description').notNull(),
    targetDate: ts('target_date'),
    /** Free text. Every value in the source names several people. */
    responsibleText: text('responsible_text'),
    remarks: text('remarks'),
    completionStatus: text('completion_status').notNull().default('NOT_COMPLETED'),
    userEditedFields: text('user_edited_fields').notNull().default(''),
    /** Added through "+ Add Dependency" rather than imported; never removed by an import. */
    isManual: boolean('is_manual').notNull().default(false),

    sourceWorkbook: text('source_workbook'),
    sourceSheet: text('source_sheet'),
    sourceRow: integer('source_row'),
    importBatchId: text('import_batch_id').references(() => fy26ImportBatches.id, { onDelete: 'set null' }),

    createdAt: now(),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    uniqueIndex('fy26_dependencies_natural_uq').on(t.fy26PackageId, t.naturalKey),
    index('fy26_dependencies_package_ix').on(t.fy26PackageId),
    index('fy26_dependencies_completion_ix').on(t.completionStatus),
    index('fy26_dependencies_target_ix').on(t.targetDate),
  ],
);

export const fy26PackageRevisions = pgTable(
  'fy26_package_revisions',
  {
    id: text('id').primaryKey(),
    fy26PackageId: text('fy26_package_id').notNull().references(() => fy26Packages.id, { onDelete: 'cascade' }),
    previousExpectedDate: ts('previous_expected_date'),
    newExpectedDate: ts('new_expected_date'),
    previousPlanBillingCr: doublePrecision('previous_plan_billing_cr'),
    newPlanBillingCr: doublePrecision('new_plan_billing_cr'),
    previousPlannedQuantity: integer('previous_planned_quantity'),
    newPlannedQuantity: integer('new_planned_quantity'),
    reason: text('reason'),
    changedById: text('changed_by_id').references(() => users.id),
    changedAt: now('changed_at'),
  },
  (t) => [index('fy26_package_revisions_pkg_ix').on(t.fy26PackageId)],
);

export const fy26ImportIssues = pgTable(
  'fy26_import_issues',
  {
    id: text('id').primaryKey(),
    batchId: text('batch_id').notNull().references(() => fy26ImportBatches.id, { onDelete: 'cascade' }),
    severity: text('severity').notNull(), // INFO | WARNING | ERROR
    code: text('code').notNull(),
    workbook: text('workbook'),
    sheet: text('sheet'),
    rowNumber: integer('row_number'),
    sourceLabel: text('source_label'),
    message: text('message').notNull(),
    payload: text('payload'),
  },
  (t) => [
    index('fy26_import_issues_batch_ix').on(t.batchId),
    index('fy26_import_issues_sev_ix').on(t.severity),
    index('fy26_import_issues_code_ix').on(t.code),
  ],
);

export type Project = typeof projects.$inferSelect;
export type Goal = typeof goals.$inferSelect;
export type Deliverable = typeof deliverables.$inferSelect;
export type Drawing = typeof drawings.$inferSelect;
export type DrawingRevision = typeof drawingRevisions.$inferSelect;
export type DrawingDependency = typeof drawingDependencies.$inferSelect;
export type DrawingSnapshot = typeof drawingSnapshots.$inferSelect;
export type DrawingConflict = typeof drawingConflicts.$inferSelect;
export type Package = typeof packages.$inferSelect;
export type Discipline = typeof disciplines.$inferSelect;
export type User = typeof users.$inferSelect;
export type Fy26Project = typeof fy26Projects.$inferSelect;
export type Fy26Phase = typeof fy26Phases.$inferSelect;
export type Fy26Package = typeof fy26Packages.$inferSelect;
export type Fy26Dependency = typeof fy26PackageDependencies.$inferSelect;
export type Fy26ScopeMapRow = typeof fy26ScopeMap.$inferSelect;
export type Fy26ImportBatch = typeof fy26ImportBatches.$inferSelect;
export type Fy26ImportIssue = typeof fy26ImportIssues.$inferSelect;

// ---------------------------------------------------------------------------
// PROJECT DRAWING STATUS — sign-in, package dependencies
// ---------------------------------------------------------------------------

/** The password of each sign-in role (Admin, Super Admin), as a bcrypt hash. Viewer has none. */
export const loginAccounts = pgTable('login_accounts', {
  role: text('role').primaryKey(), // ADMIN | SUPER_ADMIN | VIEWER (optional)
  passwordHash: text('password_hash').notNull(),
  updatedAt: ts('updated_at'),
});

/** Signed-in sessions. The cookie holds a random token; only its SHA-256 is stored. */
export const loginSessions = pgTable(
  'login_sessions',
  {
    id: text('id').primaryKey(),
    tokenHash: text('token_hash').notNull(),
    loginRole: text('login_role').notNull(), // VIEWER | ADMIN | SUPER_ADMIN
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    editMode: boolean('edit_mode').notNull().default(false),
    ip: text('ip'),
    createdAt: now(),
    expiresAt: ts('expires_at').notNull(),
    lastSeenAt: ts('last_seen_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [uniqueIndex('login_sessions_token_uq').on(t.tokenHash), index('login_sessions_user_ix').on(t.userId)],
);

/** Password attempts, for rate limiting (per role and address). */
export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: text('id').primaryKey(),
    key: text('key').notNull(),
    success: boolean('success').notNull(),
    at: now('at'),
  },
  (t) => [index('login_attempts_key_ix').on(t.key, t.at)],
);

/** Dependencies under a package (the drawing dependencies' shape, one level up). */
export const packageDependencies = pgTable(
  'package_dependencies',
  {
    id: text('id').primaryKey(),
    packageId: text('package_id')
      .notNull()
      .references(() => packages.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    department: text('department').notNull(),
    ownerUserId: text('owner_user_id').references(() => users.id),
    ownerText: text('owner_text'),
    description: text('description').notNull(),
    targetDate: ts('target_date'),
    closureDate: ts('closure_date'),
    status: text('status').notNull().default('OPEN'), // OPEN | CLOSED
    remarks: text('remarks'),
    createdById: text('created_by_id').references(() => users.id),
    createdByLabel: text('created_by_label'),
    createdAt: now(),
    updatedAt: ts('updated_at'),
  },
  (t) => [index('package_dependencies_package_ix').on(t.packageId)],
);
