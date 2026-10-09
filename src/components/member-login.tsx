'use client';

/**
 * Sign-in with email and password (one form), the invite page's "set your
 * password" form, and the hidden emergency sign-in (/login?emergency=1).
 */
import { useEffect, useState } from 'react';

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as { error?: string; home?: string };
  return { ok: res.ok, data };
}

export function EmailLogin({ next, switching }: { next: string | null; switching: boolean }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (switching) void fetch('/api/auth/logout', { method: 'POST' });
  }, [switching]);
  return (
    <form
      className="card mx-auto mt-6 max-w-sm space-y-3 p-5"
      aria-labelledby="email-login"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const { ok, data } = await post('/api/auth/login', { email, password });
          if (!ok) {
            setError(data.error ?? 'Sign-in failed. Please try again.');
            setPassword('');
            return;
          }
          window.location.assign(next ?? data.home ?? '/drawings');
        } catch {
          setError('The server could not be reached. Please try again.');
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2 id="email-login" className="text-[15px] font-semibold text-ink">
        Sign in
      </h2>
      <label className="block">
        <span className="label">Email</span>
        <input className="input" type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="block">
        <span className="label">Password</span>
        <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <button type="submit" className="btn btn-primary w-full" disabled={busy || !email || !password}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      {error && (
        <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-rag-red" role="alert">
          {error}
        </p>
      )}
      <p className="text-[12px] text-ink-soft">First time? Use the invite link from your admin.</p>
      <p className="text-[12px] text-ink-soft">Forgot your password? Ask your admin to reset it; you will get a new link.</p>
    </form>
  );
}

export function SetPassword({ token, name, email }: { token: string; name: string; email: string }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="card mx-auto mt-6 max-w-sm space-y-3 p-5"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const { ok, data } = await post('/api/auth/invite', { token, password, confirm });
          if (!ok) {
            setError(data.error ?? 'The password could not be set.');
            return;
          }
          window.location.assign(data.home ?? '/drawings');
        } catch {
          setError('The server could not be reached. Please try again.');
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2 className="text-[15px] font-semibold text-ink">Welcome, {name}</h2>
      <p className="text-[12.5px] text-ink-soft">
        Set the password for <span className="font-medium text-ink">{email}</span>. Use at least 12 characters; not your email, and not a common password.
      </p>
      <input type="email" className="hidden" autoComplete="username" value={email} readOnly aria-hidden="true" tabIndex={-1} />
      <label className="block">
        <span className="label">New password</span>
        <input className="input" type="password" autoComplete="new-password" minLength={12} required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <label className="block">
        <span className="label">Confirm the password</span>
        <input className="input" type="password" autoComplete="new-password" minLength={12} required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </label>
      <button type="submit" className="btn btn-primary w-full" disabled={busy || password.length < 12 || !confirm}>
        {busy ? 'Saving…' : 'Set password and sign in'}
      </button>
      {error && (
        <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-rag-red" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

export function EmergencyLogin() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="card mx-auto mt-6 max-w-sm space-y-3 border-amber-300 p-5"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const { ok, data } = await post('/api/auth/login', { emergency: true, password });
          if (!ok) {
            setError(data.error ?? 'Sign-in failed.');
            setPassword('');
            return;
          }
          window.location.assign('/settings/members');
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2 className="text-[15px] font-semibold text-ink">Emergency Account Admin</h2>
      <p className="text-[12.5px] text-ink-soft">For when no Account Admin can sign in. Every use is recorded and shown to the Account Admins.</p>
      <label className="block">
        <span className="label">Emergency password</span>
        <input className="input" type="password" autoComplete="off" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <button type="submit" className="btn btn-primary w-full" disabled={busy || !password}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      {error && (
        <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-rag-red" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
