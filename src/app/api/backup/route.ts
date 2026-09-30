import { fail, ok, requirePermission } from '@/lib/api';
import { backupTargetInfo, createBackup, listBackups } from '@/lib/services/backup';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requirePermission(req, 'backup.run');
    return ok({ info: backupTargetInfo(), backups: listBackups() });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await requirePermission(req, 'backup.run');
    let label: string | undefined;
    try {
      const body = await req.json();
      label = body?.label;
    } catch {
      /* body is optional */
    }
    const file = await createBackup(ctx.actor, label);
    return ok({ created: file, backups: listBackups() }, 201);
  } catch (e) {
    return fail(e);
  }
}
