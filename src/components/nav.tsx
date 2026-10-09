'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { APP_TITLE, DFS_LABEL } from '@/lib/labels';
import { confirmDiscard, setEditModeFlag } from '@/components/edit-state';
import { NAV, type NavIcon } from '@/lib/nav-items';



const ICONS = {
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  folder: 'M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
  target: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 5a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  stack: 'M12 3l9 5-9 5-9-5zm-9 9l9 5 9-5M3 16l9 5 9-5',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  tree: 'M4 4h6v4H4zM14 10h6v4h-6zM14 17h6v4h-6zM7 8v11h7M7 12h7',
  rupee: 'M6 4h12M6 8h12M9 4c5 0 5 8 0 8H6l8 8',
  pencil: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  upload: 'M12 16V4m0 0l-4 4m4-4l4 4M4 16v4h16v-4',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 4v5l3 2',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1M16 4a4 4 0 0 1 0 7M18 14a5 5 0 0 1 4 5v2',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM4 12h2m12 0h2M12 4v2m0 12v2M6.3 6.3l1.4 1.4m8.6 8.6 1.4 1.4m0-11.4-1.4 1.4m-8.6 8.6-1.4 1.4',
} as const satisfies Record<NavIcon, string>;

function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      <path d={ICONS[name]} />
    </svg>
  );
}

export async function switchUser() {
  if (!confirmDiscard()) return;
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } finally {
    window.location.assign('/login');
  }
}

export function EditModeSwitch({ on, compact }: { on: boolean; compact?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState(on);
  useEffect(() => {
    setState(on);
    setEditModeFlag(on);
  }, [on]);
  const flip = async () => {
    if (state && !confirmDiscard()) return;
    setBusy(true);
    try {
      const res = await fetch('/api/auth/edit-mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: !state }) });
      if (res.ok) {
        setState(!state);
        setEditModeFlag(!state);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      role="switch"
      aria-checked={state}
      disabled={busy}
      onClick={() => void flip()}
      className={clsx('flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-[12.5px] font-medium hover:bg-white/10', state ? 'text-white' : 'text-slate-300')}
      title={DFS_LABEL.editMode}
    >
      <span className={clsx('relative inline-flex h-4 w-7 shrink-0 rounded-full transition', state ? 'bg-emerald-500' : 'bg-slate-600')} aria-hidden="true">
        <span className={clsx('absolute top-0.5 h-3 w-3 rounded-full bg-white transition', state ? 'left-3.5' : 'left-0.5')} />
      </span>
      {!compact && <span>{DFS_LABEL.editMode}</span>}
    </button>
  );
}

/** "Ana Rao" → AR (the avatar in the menu). */
function initialsOf(name: string) {
  const p = name.trim().split(/\s+/).filter(Boolean);
  return ((p[0]?.[0] ?? '') + (p.length > 1 ? p[p.length - 1][0] : (p[0]?.[1] ?? ''))).toUpperCase();
}

export function SideNav({
  hrefs,
  name,
  roleLabel,
  editMode,
  canEdit,
}: {
  /** The menu entries this person may open. */
  hrefs: string[];
  /** The person (a member's name) or the shared sign-in's label. */
  name: string;
  roleLabel: string;
  editMode: boolean;
  /** Edit Mode is offered when Edit is on for at least one of their projects. */
  canEdit: boolean;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem('pds.nav.collapsed') === '1');
    } catch {
      /* a remembered preference only */
    }
  }, []);
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      try {
        window.localStorage.setItem('pds.nav.collapsed', c ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !c;
    });
  };
  const items = NAV.filter((i) => hrefs.includes(i.href));
  return (
    <>
      <button
        type="button"
        className="fixed left-3 top-2 z-40 rounded bg-slate-900 px-2.5 py-1.5 text-[12px] font-medium text-white lg:hidden"
        aria-expanded={open}
        aria-controls="side-nav"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Close menu' : 'Menu'}
      </button>
      {open && <div className="fixed inset-0 z-20 bg-slate-900/30 lg:hidden" onClick={() => setOpen(false)} aria-hidden="true" />}
      <aside
        id="side-nav"
        className={clsx(
          'fixed inset-y-0 left-0 z-30 flex shrink-0 flex-col bg-slate-900 text-slate-200 transition-all lg:static lg:translate-x-0',
          collapsed ? 'w-60 lg:w-14' : 'w-60',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center gap-2 border-b border-white/10 px-3 pb-3 pt-12 lg:pt-3">
          {!collapsed && <p className="flex-1 text-[13.5px] font-semibold leading-snug text-white">{APP_TITLE}</p>}
          <button
            type="button"
            className="hidden rounded px-1.5 py-1 text-slate-300 hover:bg-white/10 hover:text-white lg:inline-flex"
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand the menu' : 'Collapse the menu to icons'}
            title={collapsed ? 'Expand the menu' : 'Collapse the menu to icons'}
          >
            {collapsed ? '»' : '«'}
          </button>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto p-2" aria-label="Main">
          {items.map((item) => {
            // The longest matching entry only (Settings is not lit on Settings → Members).
            const best = NAV.filter((i) => (i.href === '/' ? pathname === '/' : pathname === i.href || pathname.startsWith(`${i.href}/`))).sort((a, b) => b.href.length - a.href.length)[0];
            const active = best?.href === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={clsx('nav-item', active && 'nav-item-active', collapsed && 'lg:justify-center')}
                aria-current={active ? 'page' : undefined}
                title={collapsed ? item.label : undefined}
                onClick={(e) => {
                  if (!confirmDiscard()) e.preventDefault();
                }}
              >
                <Icon name={item.icon} />
                <span className={clsx(collapsed && 'lg:sr-only')}>{item.label}</span>
              </Link>
            );
          })}
          {canEdit && (
            <div className="mt-2 border-t border-white/10 pt-2">
              <EditModeSwitch on={editMode} compact={collapsed} />
            </div>
          )}
        </nav>
        <div className="border-t border-white/10 px-3 py-3">
          <div className={clsx('flex items-center gap-2', collapsed && 'lg:justify-center')}>
            <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/15 text-[11px] font-semibold text-white" aria-hidden="true" title={name}>
              {initialsOf(name)}
            </span>
            {!collapsed && (
              <span className="min-w-0">
                <span className="block truncate text-[12px] font-medium text-white" data-person="">
                  {name}
                </span>
                <span className="block truncate text-[11px] text-slate-400">{roleLabel}</span>
              </span>
            )}
          </div>
          <button type="button" className="mt-1.5 text-[11.5px] text-slate-300 underline-offset-2 hover:text-white hover:underline" onClick={() => void switchUser()}>
            {DFS_LABEL.signOut}
          </button>
        </div>
      </aside>
    </>
  );
}

export function FullScreenButton({ className }: { className?: string }) {
  const [full, setFull] = useState(false);
  useEffect(() => {
    const on = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  return (
    <button
      type="button"
      className={clsx('btn btn-sm', className)}
      onClick={() => {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen?.();
      }}
    >
      {full ? DFS_LABEL.exitFullScreen : DFS_LABEL.fullScreen}
    </button>
  );
}

/** The Viewer's slim top bar: the title, Full Screen and Switch User. */
export function ViewerBar() {
  return (
    <header className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2">
      <p className="mr-auto text-[14px] font-semibold text-ink">{APP_TITLE}</p>
      <FullScreenButton />
      <button type="button" className="link text-[12px]" onClick={() => void switchUser()}>
        {DFS_LABEL.switchUser}
      </button>
    </header>
  );
}
