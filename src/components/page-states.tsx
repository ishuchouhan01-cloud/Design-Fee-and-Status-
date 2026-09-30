'use client';

/** Loading skeletons and the error panel every screen uses. */

export function PageSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading">
      <span className="mb-2 block h-3 w-40 animate-pulse rounded bg-slate-200" />
      <span className="mb-5 block h-6 w-80 max-w-full animate-pulse rounded bg-slate-200" />
      <div className="card mb-3 flex flex-wrap gap-3 px-4 py-3">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="block h-8 w-44 animate-pulse rounded bg-slate-100" />
        ))}
      </div>
      <div className="card space-y-3 p-4">
        {Array.from({ length: rows }, (_, i) => (
          <span key={i} className="block h-4 animate-pulse rounded bg-slate-100" style={{ width: `${90 - (i % 4) * 12}%` }} />
        ))}
      </div>
    </div>
  );
}

export function ErrorPanel({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="card mx-auto mt-10 max-w-lg p-6 text-center" role="alert">
      <h2 className="text-[15px] font-semibold text-ink">This page could not be shown</h2>
      <p className="mt-2 text-[12.5px] text-ink-soft">Something went wrong while loading it. Please try again. If it keeps happening, contact an Administrator{error.digest ? ` and mention reference ${error.digest}` : ''}.</p>
      <button type="button" className="btn btn-primary mt-4" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
