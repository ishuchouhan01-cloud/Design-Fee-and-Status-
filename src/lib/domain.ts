/**
 * Domain vocabulary. Deliberately narrow.
 *
 * RULE (non-negotiable): individual drawings and individual design
 * deliverables have exactly two completion states. There is no
 * "In Progress", no "Partially Complete" and no per-item percentage.
 * Percentages exist only as derived aggregates (see metrics.ts).
 */

export const COMPLETION_STATUSES = ['COMPLETED', 'NOT_COMPLETED'] as const;
export type CompletionStatus = (typeof COMPLETION_STATUSES)[number];

export function isCompletionStatus(v: unknown): v is CompletionStatus {
  return typeof v === 'string' && (COMPLETION_STATUSES as readonly string[]).includes(v);
}

/** Schedule status is computed, never stored, and never mixed with completion. */
export const SCHEDULE_STATUSES = [
  'ON_TRACK',
  'DUE_SOON',
  'RESCHEDULED',
  'DELAYED',
  'COMPLETED_ON_TIME',
  'COMPLETED_LATE',
  'NOT_SCHEDULED',
] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];

export const SCHEDULE_STATUS_LABEL: Record<ScheduleStatus, string> = {
  ON_TRACK: 'On track',
  DUE_SOON: 'Due soon',
  RESCHEDULED: 'Rescheduled',
  DELAYED: 'Delayed',
  COMPLETED_ON_TIME: 'Completed on time',
  COMPLETED_LATE: 'Completed late',
  NOT_SCHEDULED: 'No date set',
};

export const RAG = ['GREEN', 'AMBER', 'RED', 'GREY'] as const;
export type Rag = (typeof RAG)[number];

export const ROLES = ['ADMIN', 'MANAGER', 'EDITOR', 'VIEWER'] as const;
export type Role = (typeof ROLES)[number];

export const PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const ENTITY_TYPES = ['GOAL', 'DELIVERABLE', 'DRAWING', 'PACKAGE'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const DEPENDENCY_TYPES = ['FS', 'SS', 'FF'] as const;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];

export const DEPENDENCY_TYPE_LABEL: Record<DependencyType, string> = {
  FS: 'Finish → Start',
  SS: 'Start → Start',
  FF: 'Finish → Finish',
};

export const RESCHEDULE_SCOPES = [
  'ITEM',
  'SELECTION',
  'PACKAGE',
  'DISCIPLINE',
  'GOAL',
  'PROJECT',
] as const;
export type RescheduleScope = (typeof RESCHEDULE_SCOPES)[number];

export const AUDIT_ACTIONS = [
  'CREATE',
  'UPDATE',
  'DELETE',
  'COMPLETE',
  'UNCOMPLETE',
  'RESCHEDULE',
  'BULK_UPDATE',
  'IMPORT',
  'EXPORT',
  'BACKUP',
  'RESTORE',
  'RAG_OVERRIDE',
  'PERMISSION',
  // Drawing Register / Drawing Control
  'CREATE_DRAWING',
  'UPDATE_DRAWING',
  'RELEASE_DRAWING',
  'UNRELEASE_DRAWING',
  'DELETE_DRAWING',
  'CREATE_REVISION',
  'UPDATE_REVISION',
  'ADD_DEPENDENCY',
  'UPDATE_DEPENDENCY',
  'DELETE_DEPENDENCY',
  'RESCHEDULE_DRAWING',
  'RESOLVE_CONFLICT',
  'UNDO_IMPORT',
  // Project Drawing Status (Edit Mode)
  'ARCHIVE',
  // Members (personal sign-in)
  'ADD_MEMBER',
  'UPDATE_MEMBER',
  'SET_ACCESS',
  'REMOVE_MEMBER',
  'DEACTIVATE_MEMBER',
  'REACTIVATE_MEMBER',
  'RESET_PASSWORD',
  'INVITE_CREATED',
  'INVITE_USED',
  'END_SESSION',
  'EMERGENCY_SIGN_IN',
  'MERGE',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const ENTITY_LABEL: Record<EntityType, string> = {
  GOAL: 'Goal',
  DELIVERABLE: 'Design deliverable',
  DRAWING: 'Drawing',
  PACKAGE: 'Package',
};

// ---------------------------------------------------------------------------
// Design Goals FY 26
//
// Kept out of ENTITY_TYPES on purpose: that union drives the reschedule engine
// and the schedulable-entity registry in `repo/entities.ts`, and FY26 packages
// are not part of the reschedule graph. `audit_log.entity_type` is plain text,
// so these two values need no migration.
// ---------------------------------------------------------------------------

export const FY26_ENTITY_TYPES = ['FY26_PACKAGE', 'FY26_DEPENDENCY'] as const;
export type Fy26EntityType = (typeof FY26_ENTITY_TYPES)[number];

export const FY26_ENTITY_LABEL: Record<Fy26EntityType, string> = {
  FY26_PACKAGE: 'FY26 package',
  FY26_DEPENDENCY: 'FY26 dependency',
};

export const FY26_SCOPE_LEVELS = ['PROJECT', 'PHASE', 'PACKAGE_SCOPE'] as const;
export type Fy26ScopeLevel = (typeof FY26_SCOPE_LEVELS)[number];

export const FY26_IMPORT_STATUSES = ['PREVIEW', 'APPLIED', 'DISCARDED', 'FAILED'] as const;
export type Fy26ImportStatus = (typeof FY26_IMPORT_STATUSES)[number];

/** Row classes in a FY26 Goals sheet. Only PACKAGE and DEPENDENCY are stored. */
export const FY26_ROW_CLASSES = [
  'TITLE',
  'HEADER',
  'PROJECT',
  'PHASE',
  'DISCIPLINE',
  'PACKAGE',
  'DEPENDENCY',
  'TEMPLATE',
  'EMPTY_STEP',
  'SPLIT_CONTINUATION',
  'SPACER',
  'UNMAPPED',
] as const;
export type Fy26RowClass = (typeof FY26_ROW_CLASSES)[number];

export const FY26_ISSUE_CODES = [
  'TEMPLATE_ROW_SKIPPED',
  'EMPTY_STEP_MARKER',
  'HIDDEN_SHEET_SKIPPED',
  'DUPLICATE_SHEET_SKIPPED',
  'PACKAGE_ROW_SPLIT_MERGED',
  'PHASE_CONFLICT_ON_SPLIT_ROW',
  'SOURCE_DATA_AMBIGUITY',
  'MISSING_RELEASE_DATE',
  'MISSING_RESPONSIBLE',
  'UNRESOLVED_USER',
  'NON_DATE_RELEASE_VALUE',
  'FIELD_PROTECTED_USER_EDIT',
  'UNMAPPED_SCOPE_LABEL',
  'DUPLICATE_NATURAL_KEY',
  'FORMULA_NOT_EVALUATED',
] as const;
export type Fy26IssueCode = (typeof FY26_ISSUE_CODES)[number];

// ---------------------------------------------------------------------------
// Drawing Register / Drawing Control
//
// Release status is the stored binary completion value shown with drawing
// words: COMPLETED → RELEASED, NOT_COMPLETED → NOT RELEASED. It is a separate
// axis from schedule status, and a released drawing without an actual date is
// a data-quality fact ("Release date: Not recorded"), never a schedule status.
// ---------------------------------------------------------------------------

export const RELEASE_STATUS_LABEL: Record<CompletionStatus, string> = {
  COMPLETED: 'RELEASED',
  NOT_COMPLETED: 'NOT RELEASED',
};

export const DRAWING_NUMBER_STATUSES = ['NUMBERED', 'NOT_YET_NUMBERED'] as const;
export type DrawingNumberStatus = (typeof DRAWING_NUMBER_STATUSES)[number];

export const DRAWING_DEPENDENCY_STATUSES = ['OPEN', 'CLOSED'] as const;
export type DrawingDependencyStatus = (typeof DRAWING_DEPENDENCY_STATUSES)[number];

export const DRAWING_CONFLICT_TYPES = ['NUMBER_TITLE_CONFLICT', 'ACC_ONLY_NUMBER'] as const;
export type DrawingConflictType = (typeof DRAWING_CONFLICT_TYPES)[number];

export const DRAWING_CONFLICT_STATUSES = ['OPEN', 'RESOLVED', 'DISMISSED'] as const;

/**
 * Drawing fields a user can edit in Drawing Control. Editing one records it in
 * `drawings.user_edited_fields`, and no importer overwrites it afterwards.
 */
export const DRAWING_PROTECTABLE_FIELDS = [
  'drawingCode',
  'drawingNumber',
  'numberStatus',
  'drawingName',
  'phaseId',
  'packageId',
  'disciplineId',
  'location',
  'areaOfWorks',
  'batchCode',
  'batch',
  'revision',
  'responsibleUserId',
  'responsibleText',
  'remarks',
  'completionStatus',
  'actualReleaseDate',
  'currentExpectedReleaseDate',
] as const;
export type DrawingProtectableField = (typeof DRAWING_PROTECTABLE_FIELDS)[number];

export function parseEditedFields(v: string | null | undefined): Set<string> {
  return new Set((v ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

export function mergeEditedFields(existing: string | null | undefined, fields: Iterable<string>): string {
  const set = parseEditedFields(existing);
  for (const f of fields) if ((DRAWING_PROTECTABLE_FIELDS as readonly string[]).includes(f)) set.add(f);
  return [...set].sort().join(',');
}
