import { headers } from 'next/headers';
import { MembersScreen } from '@/components/members-screen';
import { Note } from '@/components/ui';
import { actorOf, getCurrentUser } from '@/lib/auth';
import { can } from '@/lib/members/policy';
import { listNamed, managedProjects } from '@/lib/members/service';

export const dynamic = 'force-dynamic';

/** Settings → Members / Companies / Roles (Account Admin and Project Admins). */
export default async function MembersPage({ searchParams }: { searchParams: Promise<{ projectId?: string; tab?: string }> }) {
  const sp = await searchParams;
  const user = await getCurrentUser((await headers()) as unknown as Headers);
  if (!can(user.principal, 'members')) return <Note tone="warn">Members is for Account Admins and Project Admins.</Note>;
  const ctx = { principal: user.principal, actor: actorOf(user), memberId: user.member?.id ?? null };
  const [projects, companies, roles] = await Promise.all([managedProjects(ctx), listNamed('company'), listNamed('role')]);
  const accountAdmin = user.principal.accountAdmin;
  const initial = sp.projectId && projects.some((p) => p.id === sp.projectId) ? sp.projectId : accountAdmin ? '' : (projects[0]?.id ?? '');
  const tab = sp.tab === 'companies' || sp.tab === 'roles' ? sp.tab : 'members';
  return (
    <MembersScreen
      projects={projects.map((p) => ({ id: p.id, name: p.name, path: p.path }))}
      canAll={accountAdmin}
      initialProjectId={initial}
      companies={companies}
      roles={roles}
      meId={user.member?.id ?? null}
      accountAdmin={accountAdmin}
      initialTab={tab}
    />
  );
}
