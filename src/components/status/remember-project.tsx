'use client';

/**
 * The project picker on Project Drawing Status is remembered per person (in
 * this browser): the first visit of a browsing session opens the project they
 * last chose; choosing "All" afterwards is remembered as well.
 */
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';

export function RememberProject({ storageKey, current, hasOtherFilters }: { storageKey: string; current: string; hasOtherFilters: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    try {
      const restoredKey = `${storageKey}.restored`;
      if (!current && !hasOtherFilters && !window.sessionStorage.getItem(restoredKey)) {
        window.sessionStorage.setItem(restoredKey, '1');
        const saved = window.localStorage.getItem(storageKey);
        if (saved) router.replace(`${pathname}?projectId=${encodeURIComponent(saved)}`);
        return;
      }
      window.sessionStorage.setItem(restoredKey, '1');
      window.localStorage.setItem(storageKey, current);
    } catch {
      /* storage unavailable: nothing is remembered */
    }
  }, [storageKey, current, hasOtherFilters, router, pathname]);
  return null;
}
