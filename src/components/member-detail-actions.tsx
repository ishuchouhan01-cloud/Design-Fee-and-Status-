'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** End one session of a member (they are signed out at their next request). */
export function EndSessionButton({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await fetch(`/api/members/sessions/${id}`, { method: 'DELETE' });
          router.refresh();
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? 'Ending…' : 'End session'}
    </button>
  );
}
