import { context, fail } from '@/lib/api';
import { membersTemplate } from '@/lib/members/service';

export const dynamic = 'force-dynamic';

/** The members import template (Forma's own Members export is accepted as well). */
export async function GET(req: Request) {
  try {
    await context(req);
    return new Response(new Uint8Array(membersTemplate()), {
      headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="members-template.xlsx"' },
    });
  } catch (e) {
    return fail(e);
  }
}
