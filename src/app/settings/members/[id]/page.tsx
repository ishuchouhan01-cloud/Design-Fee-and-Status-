import Link from 'next/link';
import { headers } from 'next/headers';
import { EndSessionButton } from '@/components/member-detail-actions';
import { Card, Note, PageHeader } from '@/components/ui';
import { actorOf, getCurrentUser } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { editTime } from '@/lib/updated-on';
import { LEVEL_LABEL } from '@/lib/members/policy';
import { memberDetail, MemberRuleError } from '@/lib/members/service';

export const dynamic = 'force-dynamic';

/** Sign-ins, sessions and the trail in the office's time zone (APP_TIME_ZONE), as on the Members table. */
const formatDateTime = (d: Date | string | null | undefined) => (d ? editTime(new Date(d)) : '—');

const STATUS: Record<string, string> = { active: 'Active', invited: 'Invited', deactivated: 'Deactivated' };
const yes = (b: boolean) => (b ? 'On' : '—');

/** Member detail: profile, every project membership, sessions, recent activity. */
export default async function MemberPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser((await headers()) as unknown as Headers);
  const ctx = { principal: user.principal, actor: actorOf(user), memberId: user.member?.id ?? null };
  let d: Awaited<ReturnType<typeof memberDetail>>;
  try {
    d = await memberDetail(ctx, id);
  } catch (e) {
    if (e instanceof MemberRuleError) return <Note tone="warn">{e.message}</Note>;
    throw e;
  }
  const m = d.member;
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title={m.name} description={m.email} crumbs={[{ label: 'Members', href: '/settings/members' }, { label: m.name }]} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Profile">
          <dl className="grid grid-cols-[9rem_1fr] gap-y-1 text-[12.5px]">
            <dt className="text-ink-mute">Email</dt>
            <dd>{m.email}</dd>
            <dt className="text-ink-mute">Phone</dt>
            <dd>{m.phone ?? '—'}</dd>
            <dt className="text-ink-mute">Status</dt>
            <dd data-member-status="">{STATUS[m.status] ?? m.status}</dd>
            <dt className="text-ink-mute">Company</dt>
            <dd>{m.company ?? '—'}</dd>
            <dt className="text-ink-mute">Role</dt>
            <dd>{m.role ?? '—'}</dd>
            <dt className="text-ink-mute">Access</dt>
            <dd>{m.accountAdmin ? 'Account Admin — every project, every module' : `${d.memberships.length} project(s)`}</dd>
            <dt className="text-ink-mute">Added</dt>
            <dd>
              {formatDate(m.createdAt)}
              {m.createdBy ? ` by ${m.createdBy}` : ''}
            </dd>
            <dt className="text-ink-mute">Last sign-in</dt>
            <dd>{m.lastSignInAt ? formatDateTime(m.lastSignInAt) : '—'}</dd>
            {m.deactivatedAt && (
              <>
                <dt className="text-ink-mute">Deactivated</dt>
                <dd>{formatDateTime(m.deactivatedAt)}</dd>
              </>
            )}
          </dl>
        </Card>
        <Card title="Sessions" subtitle="Signed in now">
          {d.sessions.length === 0 ? (
            <p className="text-[12.5px] text-ink-mute">No open session.</p>
          ) : (
            <table className="w-full text-[12.5px]">
              <thead className="text-left text-2xs uppercase text-ink-mute">
                <tr>
                  <th className="py-1">Since</th>
                  <th className="py-1">Last seen</th>
                  <th className="py-1">Address</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {d.sessions.map((s) => (
                  <tr key={s.id} className="border-t border-line/60">
                    <td className="py-1.5">{formatDateTime(s.createdAt)}</td>
                    <td className="py-1.5">{s.lastSeenAt ? formatDateTime(s.lastSeenAt) : '—'}</td>
                    <td className="py-1.5">{s.ip ?? '—'}</td>
                    <td className="py-1.5 text-right">{d.canManage && <EndSessionButton id={s.id} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
      <Card title="Projects" subtitle="Access level and modules per project" className="mt-4">
        {m.accountAdmin ? (
          <p className="text-[12.5px] text-ink-soft">An Account Admin has every project and every module.</p>
        ) : d.memberships.length === 0 ? (
          <p className="text-[12.5px] text-ink-mute">No project yet.</p>
        ) : (
          <table className="w-full text-[12.5px]" data-memberships="">
            <thead className="text-left text-2xs uppercase text-ink-mute">
              <tr>
                {['Project', 'Access level', 'Billing', 'Edit', 'Import / Export', 'Planning', 'Added'].map((h) => (
                  <th key={h} className="py-1 pr-3 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.memberships.map((g) => (
                <tr key={g.projectId} className="border-t border-line/60">
                  <td className="py-1.5 pr-3">
                    {g.canEdit ? (
                      <Link className="link" href={`/settings/members?projectId=${g.projectId}`}>
                        {g.project}
                      </Link>
                    ) : (
                      g.project
                    )}
                  </td>
                  <td className="py-1.5 pr-3">{LEVEL_LABEL[g.level as 'member' | 'project_admin']}</td>
                  <td className="py-1.5 pr-3">{yes(g.billing)}</td>
                  <td className="py-1.5 pr-3">{yes(g.edit)}</td>
                  <td className="py-1.5 pr-3">{yes(g.importExport)}</td>
                  <td className="py-1.5 pr-3">{yes(g.planning)}</td>
                  <td className="py-1.5 pr-3">
                    {formatDate(g.addedAt)}
                    {g.addedBy ? ` by ${g.addedBy}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title="Recent activity" subtitle="From the audit trail" className="mt-4">
        {d.activity.length === 0 ? (
          <p className="text-[12.5px] text-ink-mute">Nothing recorded yet.</p>
        ) : (
          <table className="w-full text-[12.5px]">
            <tbody>
              {d.activity.map((a, i) => (
                <tr key={i} className="border-t border-line/60">
                  <td className="whitespace-nowrap py-1.5 pr-3 tabular-nums">{formatDateTime(a.at)}</td>
                  <td className="py-1.5 pr-3">{a.who ?? '—'}</td>
                  <td className="py-1.5 pr-3">{a.action.replace(/_/g, ' ').toLowerCase()}</td>
                  <td className="py-1.5 pr-3">{a.entity}</td>
                  <td className="py-1.5 text-ink-soft">{a.field ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
