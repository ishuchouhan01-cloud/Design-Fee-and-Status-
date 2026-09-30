import { z } from 'zod';
import { fail, ok, requirePermission } from '@/lib/api';
import { CENTRE_FILE_TYPES, inspectWorkbook, savedMapping, uploadPath } from '@/lib/import/centre';

export const dynamic = 'force-dynamic';

const schema = z.object({ uploadId: z.string().min(1), fileType: z.enum(CENTRE_FILE_TYPES), projectId: z.string().nullish() }).strict();

/** The column mapping for a chosen file type and project (the remembered one when there is one). */
export async function POST(req: Request) {
  try {
    await requirePermission(req, 'import.centre');
    const input = schema.parse(await req.json());
    const up = uploadPath(input.uploadId);
    const saved = await savedMapping(input.projectId, input.fileType);
    return ok({ inspection: inspectWorkbook(up.file, up.fileName, input.fileType, saved), remembered: Boolean(saved) });
  } catch (e) {
    return fail(e);
  }
}
