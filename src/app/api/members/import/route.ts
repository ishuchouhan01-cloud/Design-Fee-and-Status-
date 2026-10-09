import { context, fail, ok } from '@/lib/api';
import { adminCtx } from '@/lib/members/api-ctx';
import { importMembers, MemberRuleError } from '@/lib/members/service';

export const dynamic = 'force-dynamic';

const MAX = 5 * 1024 * 1024;

/** Import members from Excel / CSV into one project: a dry run (apply=0) first, then apply=1 after confirmation. */
export async function POST(req: Request) {
  try {
    const ctx = adminCtx(await context(req), req);
    const form = await req.formData();
    const file = form.get('file');
    const projectId = String(form.get('projectId') ?? '');
    const apply = String(form.get('apply') ?? '') === '1';
    if (!(file instanceof File)) throw new MemberRuleError('Choose an Excel (.xlsx) or CSV file.');
    if (!/\.(xlsx|csv)$/i.test(file.name)) throw new MemberRuleError('Only .xlsx or .csv files can be imported.');
    if (file.size > MAX) throw new MemberRuleError('The file is larger than 5 MB.');
    const buf = Buffer.from(await file.arrayBuffer());
    if (/\.xlsx$/i.test(file.name) && buf.includes(Buffer.from('vbaProject.bin'))) throw new MemberRuleError('Workbooks with macros are not accepted.');
    return ok(await importMembers(ctx, projectId, buf, apply));
  } catch (e) {
    return fail(e);
  }
}
