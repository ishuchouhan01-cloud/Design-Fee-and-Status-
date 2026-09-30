import { fail, requirePermission, searchParams } from '@/lib/api';
import { CENTRE_FILE_TYPES, templateWorkbook, type CentreFileType } from '@/lib/import/centre';

export const dynamic = 'force-dynamic';

const NAME: Record<CentreFileType, string> = {
  PLAN: 'drawing-register-template.xlsx',
  DESIGN_FEE: 'design-fee-template.xlsx',
  ACC: 'autodesk-construction-cloud-release-template.xlsx',
  PROJECT_LIST: 'project-list-template.xlsx',
};

/** A blank Excel template per file type. */
export async function GET(req: Request) {
  try {
    await requirePermission(req, 'import.centre');
    const t = searchParams(req).get('type') as CentreFileType;
    if (!CENTRE_FILE_TYPES.includes(t)) throw new Error('Unknown template.');
    return new Response(new Uint8Array(templateWorkbook(t)), {
      headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${NAME[t]}"` },
    });
  } catch (e) {
    return fail(e);
  }
}
