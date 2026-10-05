import { z } from 'zod';
import { fail, ok, requirePermission } from '@/lib/api';
import { CENTRE_FILE_TYPES, runCentreImport, uploadPath } from '@/lib/import/centre';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const letters = z.string().regex(/^[A-Za-z]{1,3}$/);
const schema = z
  .object({
    uploadId: z.string().min(1),
    fileType: z.enum(CENTRE_FILE_TYPES),
    projectId: z.string().nullish(),
    newProject: z
      .object({ fullName: z.string().trim().min(2).max(200), shortCode: z.string().trim().max(40).nullish(), parentProjectId: z.string().nullish() })
      .nullish(),
    mapping: z
      .object({
        columns: z.record(z.string(), z.record(z.string(), letters)).optional(),
        disciplines: z.record(z.string(), z.string().min(1).max(10)).optional(),
        feeSheet: z.string().max(100).nullish(),
        feeLayout: z.enum(['AUTO', 'PACKAGE_TOTAL', 'DISCIPLINE_BLOCKS']).nullish(),
      })
      .nullish(),
    apply: z.boolean(),
    confirmed: z.boolean().optional(),
  })
  .strict();

/** Dry run (`apply: false`) or import (`apply: true`, after the user confirms the dry run). */
export async function POST(req: Request) {
  try {
    const ctx = await requirePermission(req, 'import.centre');
    const input = schema.parse(await req.json());
    if (input.apply && !input.confirmed) throw new Error('Confirm the dry run before importing.');
    const up = uploadPath(input.uploadId);
    const result = await runCentreImport({
      file: up.file,
      fileName: up.fileName,
      fileType: input.fileType,
      projectId: input.projectId ?? null,
      newProject: input.newProject ?? null,
      mapping: input.mapping ?? null,
      apply: input.apply,
      actor: ctx.actor,
    });
    return ok({ ...result, issues: result.issues.slice(0, 500), issueTotal: result.issues.length });
  } catch (e) {
    return fail(e);
  }
}
