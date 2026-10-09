import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import './globals.css';
import { SideNav, ViewerBar } from '@/components/nav';
import { NAV } from '@/lib/nav-items';
import { SESSION_ROLE_LABEL } from '@/lib/access';
import { getCurrentUser, UnauthenticatedError, type SessionUser } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { APP_TITLE } from '@/lib/labels';
import { recentEmergencySignIns } from '@/lib/members/auth';
import { routeAllowed } from '@/lib/members/gate';
import { can, LEVEL_LABEL } from '@/lib/members/policy';

export const metadata: Metadata = {
  title: APP_TITLE,
  description: 'Project drawing status, billing and design control for construction projects',
};

/** How the person is described under their name in the menu. */
function roleLabelOf(user: SessionUser) {
  if (user.emergency) return 'Emergency Account Admin';
  if (!user.member) return SESSION_ROLE_LABEL[user.loginRole];
  if (user.principal.accountAdmin) return LEVEL_LABEL.account_admin;
  return can(user.principal, 'members') ? LEVEL_LABEL.project_admin : LEVEL_LABEL.member;
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const h = await headers();
  // Set by the middleware on every screen except the sign-in and invite pages.
  const path = h.get('x-pds-path');
  const search = h.get('x-pds-search') ?? '';
  let user: SessionUser | null = null;
  try {
    user = await getCurrentUser(h as unknown as Headers);
  } catch (e) {
    if (!(e instanceof UnauthenticatedError)) throw e;
  }
  if (!user || !path) {
    // The sign-in page (or a session that has ended: back to sign-in).
    if (path && !user) redirect(`/login?next=${encodeURIComponent(path + search)}`);
    return (
      <html lang="en">
        <body>{children}</body>
      </html>
    );
  }
  const allowed = routeAllowed(user, 'page', 'GET', path, search);
  const body = allowed ? (
    children
  ) : (
    <div className="card mx-auto mt-16 max-w-md p-6 text-center">
      <h1 className="text-[15px] font-semibold">This screen is not part of your access</h1>
      <p className="mt-2 text-[12.5px] text-ink-soft">Your sign-in cannot open this screen.</p>
    </div>
  );
  if (user.loginRole === 'VIEWER') {
    return (
      <html lang="en">
        <body>
          <div className="flex h-screen flex-col">
            <ViewerBar />
            <main className="min-h-0 min-w-0 flex-1 overflow-auto p-3">{body}</main>
          </div>
        </body>
      </html>
    );
  }
  // Account Admins see every recent use of the emergency sign-in.
  const emergencies = user.principal.accountAdmin ? await recentEmergencySignIns() : [];
  const hrefs = NAV.filter((i) => routeAllowed(user, 'page', 'GET', i.href)).map((i) => i.href);
  const name = user.member?.name ?? (user.emergency ? 'Emergency Account Admin' : SESSION_ROLE_LABEL[user.loginRole]);
  return (
    <html lang="en">
      <body>
        <div className="flex h-screen">
          <SideNav hrefs={hrefs} name={name} roleLabel={roleLabelOf(user)} editMode={user.editMode} canEdit={can(user.principal, 'edit')} />
          <main className="min-h-0 min-w-0 flex-1 overflow-auto p-3 pt-12 lg:pt-3">
            {emergencies.length > 0 && (
              <p className="mb-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900" role="status" data-emergency-banner="">
                The emergency Account Admin sign-in was used {emergencies.length} time(s) in the last 14 days — last on {formatDateTime(emergencies[emergencies.length - 1].at)}
                {emergencies[emergencies.length - 1].address ? ` from ${emergencies[emergencies.length - 1].address}` : ''}. See Audit.
              </p>
            )}
            {body}
          </main>
        </div>
      </body>
    </html>
  );
}
