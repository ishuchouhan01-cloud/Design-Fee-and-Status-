import { LoginPanel } from '@/components/login-panel';
import { APP_TITLE } from '@/lib/labels';

export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; switch?: string }> }) {
  const sp = await searchParams;
  const next = sp.next && sp.next.startsWith('/') && !sp.next.startsWith('//') ? sp.next : null;
  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-alt p-4">
      <div className="w-full max-w-3xl">
        <h1 className="text-center text-[20px] font-semibold text-ink">{APP_TITLE}</h1>
        <p className="mt-1 text-center text-[13px] text-ink-soft">Choose how you want to sign in.</p>
        <LoginPanel next={next} switching={sp.switch === '1'} />
      </div>
    </main>
  );
}
