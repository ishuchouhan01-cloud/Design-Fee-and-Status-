'use client';

import clsx from 'clsx';
import { useEffect, useState } from 'react';

type Role = 'VIEWER' | 'ADMIN' | 'SUPER_ADMIN';

const CHOICES: { role: Role; title: string; body: string; password: boolean }[] = [
  { role: 'VIEWER', title: 'Viewer', body: 'See Project Drawing Status. No password.', password: false },
  { role: 'ADMIN', title: 'Admin', body: 'Project Drawing Status, Billing, Import, Export and Edit Mode.', password: true },
  { role: 'SUPER_ADMIN', title: 'Super Admin', body: 'Every module of the application.', password: true },
];

export function LoginPanel({ next, switching, viewerPassword = false }: { next: string | null; switching: boolean; viewerPassword?: boolean }) {
  const choices = CHOICES.map((c) => (c.role === 'VIEWER' && viewerPassword ? { ...c, body: 'See Project Drawing Status.', password: true } : c));
  const [chosen, setChosen] = useState<Role | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Switch User from a screen that could not sign out itself.
  useEffect(() => {
    if (switching) void fetch('/api/auth/logout', { method: 'POST' });
  }, [switching]);

  const submit = async (role: Role, pw?: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role, password: pw }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; home?: string };
      if (!res.ok) {
        setError(body.error ?? 'Sign-in failed. Please try again.');
        setPassword('');
        return;
      }
      window.location.assign(next ?? body.home ?? '/drawings');
    } catch {
      setError('The server could not be reached. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-6 grid gap-3 md:grid-cols-3">
      {choices.map((c) => {
        const open = chosen === c.role;
        return (
          <section key={c.role} className={clsx('card flex flex-col p-4', open && 'ring-2 ring-brand-300')} aria-labelledby={`login-${c.role}`}>
            <h2 id={`login-${c.role}`} className="text-[15px] font-semibold text-ink">
              {c.title}
            </h2>
            <p className="mt-1 flex-1 text-[12.5px] text-ink-soft">{c.body}</p>
            {!c.password ? (
              <button type="button" className="btn btn-primary mt-4" disabled={busy} onClick={() => void submit(c.role)}>
                Enter as Viewer
              </button>
            ) : open ? (
              <form
                className="mt-4 space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit(c.role, password);
                }}
              >
                <label className="label" htmlFor={`pw-${c.role}`}>
                  Password
                </label>
                <input
                  id={`pw-${c.role}`}
                  type="password"
                  className="input"
                  autoComplete="current-password"
                  autoFocus
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <div className="flex gap-2">
                  <button type="submit" className="btn btn-primary flex-1" disabled={busy || !password}>
                    {busy ? 'Signing in…' : `Sign in as ${c.title}`}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setChosen(null);
                      setPassword('');
                      setError(null);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                className="btn mt-4"
                onClick={() => {
                  setChosen(c.role);
                  setPassword('');
                  setError(null);
                }}
              >
                Sign in as {c.title}
              </button>
            )}
          </section>
        );
      })}
      {error && (
        <p className="md:col-span-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-center text-[12.5px] text-rag-red" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
