import { headers } from 'next/headers';
import { StatusScreen } from '@/components/status/status-screen';
import { Note } from '@/components/ui';
import { getCurrentUser, userCan } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** Billing: the Project Drawing Status tree with Total / Billed / Unbilled first (Admin and Super Admin). */
export default async function BillingPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const user = await getCurrentUser((await headers()) as unknown as Headers);
  if (!userCan(user, 'billing.read')) return <Note tone="warn">Billing is for Admin and Super Admin.</Note>;
  return <StatusScreen sp={sp} user={user} mode="billing" />;
}
