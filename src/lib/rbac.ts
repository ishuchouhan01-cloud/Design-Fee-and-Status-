/**
 * Authorization, kept entirely separate from business logic: services take an
 * already-authorized actor; route handlers call `assertCan` before invoking a
 * service. No permission check is buried inside a domain function.
 */
import type { Role } from './domain';

export const PERMISSIONS = [
  'project.read',
  'project.write',
  'goal.read',
  'goal.write',
  'goal.reschedule',
  'deliverable.read',
  'deliverable.write',
  'deliverable.complete',
  'drawing.read',
  'drawing.write',
  'drawing.complete',
  'drawing.reschedule',
  'drawing.admin',
  'schedule.reschedule',
  'bulk.update',
  'rag.override',
  'export.run',
  'import.run',
  'import.centre',
  'backup.run',
  'audit.read',
  'user.manage',
  'fy26.read',
  'fy26.write',
  'fy26.import',
  'billing.read',
  'billing.write',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const VIEWER: Permission[] = [
  'project.read',
  'goal.read',
  'deliverable.read',
  'drawing.read',
  'audit.read',
  'export.run',
  'fy26.read',
];

const EDITOR: Permission[] = [
  ...VIEWER,
  'goal.write',
  'deliverable.write',
  'deliverable.complete',
  'drawing.write',
  'drawing.complete',
  'drawing.reschedule',
  'bulk.update',
  'fy26.write',
];

const MANAGER: Permission[] = [
  ...EDITOR,
  'project.write',
  'goal.reschedule',
  'schedule.reschedule',
  'rag.override',
  'backup.run',
  'import.centre',
  'billing.read',
  'billing.write',
];

const ADMIN: Permission[] = [...MANAGER, 'import.run', 'user.manage', 'fy26.import', 'drawing.admin'];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  VIEWER,
  EDITOR,
  MANAGER,
  ADMIN,
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

const ROLE_NAME: Record<string, string> = { ADMIN: 'Administrator', MANAGER: 'Manager', EDITOR: 'Editor', VIEWER: 'Viewer' };

export class ForbiddenError extends Error {
  status = 403;
  permission: Permission;
  constructor(permission: Permission, role: Role) {
    super(`Your role (${ROLE_NAME[role] ?? role}) does not allow this action.`);
    this.permission = permission;
    this.name = 'ForbiddenError';
  }
}

/**
 * The permission needed to move an entity's current-expected date. Drawings
 * use their own `drawing.reschedule` (Editors and above), so Drawing Control
 * can manage drawing schedules without the Manager-level
 * `schedule.reschedule`.
 */
export function reschedulePermissionFor(entityType: string): Permission {
  if (entityType === 'GOAL') return 'goal.reschedule';
  if (entityType === 'DRAWING') return 'drawing.reschedule';
  return 'schedule.reschedule';
}

export function assertCan(role: Role, permission: Permission): void {
  if (!can(role, permission)) throw new ForbiddenError(permission, role);
}

export const ROLE_DESCRIPTION: Record<Role, string> = {
  ADMIN: 'Full control, including imports and user management.',
  MANAGER: 'View and edit operational data, reschedule, override the status colour, run imports, backups and reporting.',
  EDITOR: 'Update permitted operational data — completion, dates, revisions, remarks.',
  VIEWER: 'Can view everything and export; cannot change anything.',
};
