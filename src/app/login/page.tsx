import { LoginPanel } from '@/components/login-panel';
import { EmailLogin, EmergencyLogin } from '@/components/member-login';
import { APP_TITLE } from '@/lib/labels';
import { viewerNeedsPassword } from '@/lib/login';
import { legacyLoginsOn } from '@/lib/members/gate';

export const dynamic = 'force-dynamic';

/**
 * Sign-in: email and password (one form). While LEGACY_ROLE_LOGINS is on, the
 * shared Viewer / Admin / Super Admin cards are shown beside it. The emergency
 * Account Admin sign-in is only at /login?emergency=1 and is never linked.
 */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; switch?: string; emergency?: string }> }) {
  const sp = await searchParams;
  const next = sp.next && sp.next.startsWith('/') && !sp.next.startsWith('//') ? sp.next : null;
  const switching = sp.switch === '1';
  if (sp.emergency === '1') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-surface-alt p-4">
        <div className="w-full max-w-md">
          <h1 className="text-center text-[20px] font-semibold text-ink">{APP_TITLE}</h1>
          <EmergencyLogin />
        </div>
      </main>
    );
  }
  const legacy = legacyLoginsOn();
  const viewerPassword = legacy ? await viewerNeedsPassword().catch(() => false) : false;
  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-alt p-4">
      <div className="w-full max-w-3xl">
        <h1 className="text-center text-[20px] font-semibold text-ink">{APP_TITLE}</h1>
        <p className="mt-1 text-center text-[13px] text-ink-soft">Sign in with your email and password.</p>
        <EmailLogin next={next} switching={switching} />
        {legacy && (
          <>
            <p className="mt-6 text-center text-[12px] text-ink-mute">Or use a shared sign-in (until it is switched off):</p>
            <LoginPanel next={next} switching={false} viewerPassword={viewerPassword} />
          </>
        )}
      </div>
    </main>
  );
}
