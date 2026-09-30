import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { DrawingDetailView } from '@/components/drawing-detail';
import { Note, PageHeader } from '@/components/ui';
import { getCurrentUser, ROLE_LABEL } from '@/lib/auth';
import { can } from '@/lib/rbac';
import { listPackages } from '@/lib/services/reference';
import { activeUsers, drawingReference, getDrawingDetail } from '@/lib/services/drawing-register';

export const dynamic = 'force-dynamic';

/** Drawing detail in DRAWING CONTROL — controls per permission. */
export default async function DrawingControlDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser((await headers()) as unknown as Headers);
  if (!can(user.role, 'drawing.write')) {
    return (
      <Note tone="warn">
        Drawing Control is for users who can edit drawings. Your role ({ROLE_LABEL[user.role] ?? user.role}) can view drawings but not change them —{' '}
        <Link className="link" href={`/drawings/${id}`}>
          view this drawing in the Design Fee Schedule (DFS)
        </Link>
        .
      </Note>
    );
  }
  const detail = await getDrawingDetail(id);
  if (!detail) notFound();
  const [ref, people, pkgs] = await Promise.all([drawingReference(detail.drawing.projectId), activeUsers(), listPackages(detail.drawing.projectId)]);
  const d = detail.drawing;
  const title = d.numberStatus === 'NOT_YET_NUMBERED' ? 'Not yet numbered' : d.drawingCode;
  return (
    <>
      <PageHeader
        title={title}
        description={d.drawingName}
        crumbs={[{ label: 'Drawing Control', href: '/drawing-control' }, { label: title }]}
        actions={
          <Link href={`/drawings/${id}`} className="btn">
            DFS view
          </Link>
        }
      />
      <DrawingDetailView
        detail={detail}
        controls={{
          write: can(user.role, 'drawing.write'),
          complete: can(user.role, 'drawing.complete'),
          reschedule: can(user.role, 'drawing.reschedule'),
          admin: can(user.role, 'drawing.admin'),
          phases: ref.phases.map((p) => ({ value: p.id, label: p.code, projectId: p.projectId })),
          packages: pkgs.map((p) => ({ value: p.id, label: `${p.packageCode} — ${p.packageName}`, projectId: p.projectId })),
          disciplines: ref.disciplines.map((x) => ({ value: x.id, label: `${x.code} — ${x.name}` })),
          users: people.map((u) => ({ value: u.id, label: u.name })),
        }}
      />
    </>
  );
}
