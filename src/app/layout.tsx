import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import './globals.css';
import { SideNav, ViewerBar } from '@/components/nav';
import { LOGIN_ROLE_LABEL, pageAllowed } from '@/lib/access';
import { getCurrentUser, UnauthenticatedError, type SessionUser } from '@/lib/auth';
import { APP_TITLE } from '@/lib/labels';

export const metadata: Metadata = {
  title: APP_TITLE,
  description: 'Project drawing status, billing and design control for construction projects',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const h = await headers();
  // Set by the middleware on every screen except the sign-in page.
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
  const allowed = pageAllowed(user.loginRole, path, search);
  const body = allowed ? (
    children
  ) : (
    <div className="card mx-auto mt-16 max-w-md p-6 text-center">
      <h1 className="text-[15px] font-semibold">This screen is not part of your sign-in</h1>
      <p className="mt-2 text-[12.5px] text-ink-soft">Your role cannot open this screen.</p>
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
  return (
    <html lang="en">
      <body>
        <div className="flex h-screen">
          <SideNav role={user.loginRole} roleLabel={LOGIN_ROLE_LABEL[user.loginRole]} editMode={user.editMode} />
          <main className="min-h-0 min-w-0 flex-1 overflow-auto p-3 pt-12 lg:pt-3">{body}</main>
        </div>
      </body>
    </html>
  );
}
