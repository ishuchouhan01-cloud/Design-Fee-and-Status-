import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { DrawingDetailView } from '@/components/drawing-detail';
import { Note, PageHeader } from '@/components/ui';
import { getCurrentUser } from '@/lib/auth';
import { can } from '@/lib/rbac';
import { getDrawingDetail } from '@/lib/services/drawing-register';

export const dynamic = 'force-dynamic';

/** Drawing detail in the REGISTER — read-only for every role. */
export default async function DrawingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser((await headers()) as unknown as Headers);
  if (!can(user.role, 'drawing.read')) return <Note tone="warn">Your role does not include access to DFS.</Note>;
  const detail = await getDrawingDetail(id);
  if (!detail) notFound();
  const d = detail.drawing;
  const title = d.numberStatus === 'NOT_YET_NUMBERED' ? 'Not yet numbered' : d.drawingCode;
  return (
    <>
      <PageHeader
        title={title}
        description={d.drawingName}
        crumbs={[{ label: 'DFS', href: '/drawings' }, { label: title }]}
        actions={
          can(user.role, 'drawing.write') ? (
            <Link href={`/drawing-control/${id}`} className="btn btn-primary">
              Manage in Drawing Control
            </Link>
          ) : undefined
        }
      />
      <DrawingDetailView detail={detail} />
    </>
  );
}
