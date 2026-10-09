/**
 * The whole menu (a plain module: the layout, on the server, decides which
 * entries each person sees with the same rule as every request; the menu only
 * hides what the server already refuses).
 */
import { NAV_LABEL } from '@/lib/labels';

export type NavIcon = 'home' | 'folder' | 'target' | 'stack' | 'calendar' | 'tree' | 'rupee' | 'pencil' | 'upload' | 'refresh' | 'clock' | 'list' | 'users' | 'gear';

export type NavItem = { href: string; label: string; icon: NavIcon };

export const NAV: NavItem[] = [
  { href: '/', label: NAV_LABEL.dashboard, icon: 'home' },
  { href: '/projects', label: NAV_LABEL.projects, icon: 'folder' },
  { href: '/goals', label: NAV_LABEL.goals, icon: 'target' },
  { href: '/deliverables', label: NAV_LABEL.deliverables, icon: 'stack' },
  { href: '/fy26', label: NAV_LABEL.fy26, icon: 'calendar' },
  { href: '/drawings', label: NAV_LABEL.dfs, icon: 'tree' },
  { href: '/billing', label: NAV_LABEL.billing, icon: 'rupee' },
  { href: '/drawing-control', label: NAV_LABEL.drawingControl, icon: 'pencil' },
  { href: '/import-centre', label: NAV_LABEL.importCentre, icon: 'upload' },
  { href: '/update-centre', label: NAV_LABEL.updateCentre, icon: 'refresh' },
  { href: '/schedule', label: NAV_LABEL.schedule, icon: 'clock' },
  { href: '/audit', label: NAV_LABEL.audit, icon: 'list' },
  { href: '/settings/members', label: NAV_LABEL.members, icon: 'users' },
  { href: '/settings', label: NAV_LABEL.settings, icon: 'gear' },
];
