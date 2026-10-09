import Link from 'next/link';
import { SetPassword } from '@/components/member-login';
import { APP_TITLE } from '@/lib/labels';
import { INVITE_REASON, inviteInfo } from '@/lib/members/auth';

export const dynamic = 'force-dynamic';

/** The one-time invite link: the member sees their name and email and sets a password. */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const state = await inviteInfo(token);
  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-alt p-4">
      <div className="w-full max-w-md">
        <h1 className="text-center text-[20px] font-semibold text-ink">{APP_TITLE}</h1>
        {state.ok ? (
          <SetPassword token={token} name={state.name} email={state.email} />
        ) : (
          <div className="card mx-auto mt-6 max-w-sm p-5 text-center">
            <p className="text-[13px] text-ink" role="alert">
              {INVITE_REASON[state.reason]}
            </p>
            <p className="mt-3 text-[12.5px]">
              <Link className="link" href="/login">
                Go to sign-in
              </Link>
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
