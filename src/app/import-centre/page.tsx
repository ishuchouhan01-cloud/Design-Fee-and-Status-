/**
 * Import — bring a workbook into the system (Administrator and Manager only).
 */
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { ImportCentre } from '@/components/import-centre';
import { PageHeader } from '@/components/ui';
import { db } from '@/db';
import { projects } from '@/db/schema';
import { getCurrentUser } from '@/lib/auth';
import { importHistory } from '@/lib/import/centre';
import { IMPORT_FILE_TYPE_LABEL, NAV_LABEL, projectLabel } from '@/lib/labels';
import { can } from '@/lib/rbac';

export const dynamic = 'force-dynamic';

export default async function ImportCentrePage() {
  const user = await getCurrentUser((await headers()) as unknown as Headers);
  if (!can(user.role, 'import.centre')) notFound();
  const [all, runs] = await Promise.all([db.select().from(projects), importHistory()]);
  const options = all
    .map((p) => ({ id: p.id, name: projectLabel(p), parentId: p.parentProjectId }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <PageHeader
        title={NAV_LABEL.importCentre}
        description="Upload an Excel workbook, check how it will be read, run a dry run, then import. Manual edits, rescheduled dates and baselines are never overwritten."
        crumbs={[{ label: NAV_LABEL.dashboard, href: '/' }, { label: NAV_LABEL.importCentre }]}
      />
      <ImportCentre projects={options} fileTypes={IMPORT_FILE_TYPE_LABEL} initialRuns={JSON.parse(JSON.stringify(runs))} />
    </>
  );
}
