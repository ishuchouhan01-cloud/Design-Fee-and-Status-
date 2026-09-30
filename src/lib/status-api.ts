/** Shared by the Edit Mode endpoints (/api/status/*). */
import { requirePermission, type ApiContext } from './api';
import type { Permission } from './rbac';

export class EditModeOffError extends Error {
  status = 409;
}

/** The permission, and Edit Mode switched on for a signed-in session. */
export async function requireEdit(req: Request, permission: Permission): Promise<ApiContext> {
  const ctx = await requirePermission(req, permission);
  if (ctx.user.sessionId && !ctx.user.editMode) throw new EditModeOffError('Turn on Edit Mode to make changes.');
  return ctx;
}
