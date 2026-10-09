import { z } from 'zod';
import { fail, ok, requirePermission, requireProject, RouteForbiddenError } from '@/lib/api';
import { grantProjectAdmin } from '@/lib/members/service';
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
    // Only into the person's projects with Import / Export; the Project List changes every project (Account Admin).
    if (input.fileType === 'PROJECT_LIST' && !ctx.user.principal.accountAdmin && ctx.user.principal.kind === 'member') throw new RouteForbiddenError('The Project List is for Account Admins.');
    if (input.projectId) await requireProject(ctx, 'importExport', input.projectId);
    else if (input.newProject) {
      if (input.newProject.parentProjectId) await requireProject(ctx, 'importExport', input.newProject.parentProjectId);
      else if (ctx.user.principal.kind === 'member' && !ctx.user.principal.accountAdmin) throw new RouteForbiddenError('Choose the project it is part of — a new top-level project is for Account Admins.');
    }
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
    // A new-project import makes the importer its Project Admin.
    if (input.apply && input.newProject && result.project?.id && ctx.user.member && !ctx.user.principal.accountAdmin) {
      await grantProjectAdmin(ctx.user.member.id, result.project.id, ctx.actor);
    }
    return ok({ ...result, issues: result.issues.slice(0, 500), issueTotal: result.issues.length });
  } catch (e) {
    return fail(e);
  }
}
