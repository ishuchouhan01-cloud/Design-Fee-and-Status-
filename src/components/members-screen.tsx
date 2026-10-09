'use client';

/**
 * Settings → Members (Account Admin, Project Admins), styled like Autodesk
 * Forma's Project Admin → Members: a project picker, the Members / Companies /
 * Roles list on the left, "Add members ▾", Export, search, filters, the table
 * with the module switches, a ⋮ menu per row and paging. Every change goes
 * through /api/members*, which applies the same guards as the server rule.
 */
import clsx from 'clsx';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

type Switch = 'billing' | 'edit' | 'importExport' | 'planning';
const SWITCHES: { key: Switch; label: string }[] = [
  { key: 'billing', label: 'Billing' },
  { key: 'edit', label: 'Edit' },
  { key: 'importExport', label: 'Import / Export' },
  { key: 'planning', label: 'Planning' },
];

interface Row {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  status: string;
  company: string | null;
  role: string | null;
  accountAdmin: boolean;
  level: 'account_admin' | 'project_admin' | 'member' | null;
  levelLabel: string;
  projects: number;
  addedOn: string | null;
  lastSignIn: string | null;
  switches: Record<Switch, boolean>;
  locked: boolean;
  canEdit: boolean;
}
interface Project {
  id: string;
  name: string;
  path: string;
}
interface Named {
  id: string;
  name: string;
  trade?: string | null;
  members: number;
}
interface ListResponse {
  rows: Row[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

async function api<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(url, body === undefined ? { method, cache: 'no-store' } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `The request failed (${res.status}).`);
  return data;
}

const STATUS_TONE: Record<string, string> = {
  active: 'bg-emerald-50 text-emerald-800 ring-emerald-300',
  invited: 'bg-amber-50 text-amber-900 ring-amber-300',
  deactivated: 'bg-slate-100 text-slate-600 ring-slate-300',
};
const STATUS_LABEL: Record<string, string> = { active: 'Active', invited: 'Invited', deactivated: 'Deactivated' };

function initials(name: string) {
  const p = name.trim().split(/\s+/).filter(Boolean);
  return ((p[0]?.[0] ?? '') + (p.length > 1 ? p[p.length - 1][0] : (p[0]?.[1] ?? ''))).toUpperCase();
}

const fmt = (iso: string | null, time = false) => {
  if (!iso) return '—';
  const d = new Date(iso);
  const s = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  return time ? `${s} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : s;
};

function Toggle({ on, disabled, label, onChange }: { on: boolean; disabled?: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={disabled ? `${label} (locked)` : label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={clsx('relative inline-flex h-4 w-7 shrink-0 rounded-full transition disabled:cursor-not-allowed', on ? 'bg-brand-600' : 'bg-slate-300', disabled && 'opacity-60')}
    >
      <span className={clsx('absolute top-0.5 h-3 w-3 rounded-full bg-white transition', on ? 'left-3.5' : 'left-0.5')} />
    </button>
  );
}

function Dialog({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-slate-900/40 p-4 pt-16" role="dialog" aria-modal="true" aria-label={title}>
      <div className={clsx('card w-full p-5', wide ? 'max-w-4xl' : 'max-w-lg')}>
        <div className="mb-3 flex items-center gap-2">
          <h2 className="mr-auto text-[15px] font-semibold text-ink">{title}</h2>
          <button type="button" className="link text-[12px]" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** The one-time invite link: shown once, with a Copy button. */
function LinkBox({ link, expiresAt, email }: { link: string; expiresAt: string; email?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2" data-invite-link="">
      <p className="text-[12.5px] text-ink-soft">
        One-time link{email ? ` for ${email}` : ''}, valid until {fmt(expiresAt, true)}. It is shown only now — copy it and send it to the person (for example by email or chat).
      </p>
      <div className="flex gap-2">
        <input className="input flex-1 font-mono text-[11.5px]" readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="Invite link" />
        <button
          type="button"
          className="btn btn-primary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(link);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

export function MembersScreen({
  projects,
  canAll,
  initialProjectId,
  companies: initialCompanies,
  roles: initialRoles,
  meId,
  accountAdmin,
  initialTab,
}: {
  projects: Project[];
  canAll: boolean;
  initialProjectId: string;
  companies: Named[];
  roles: Named[];
  meId: string | null;
  accountAdmin: boolean;
  initialTab: 'members' | 'companies' | 'roles';
}) {
  const [tab, setTab] = useState(initialTab);
  const [projectId, setProjectId] = useState(initialProjectId);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | { kind: 'add' | 'import' | 'copyMembers' } | { kind: 'link'; link: string; expiresAt: string; email: string } | { kind: 'copyAccess'; row: Row }>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [companies, setCompanies] = useState(initialCompanies);
  const [roles, setRoles] = useState(initialRoles);
  const [addOpen, setAddOpen] = useState(false);

  const query = useMemo(() => {
    const q = new URLSearchParams();
    if (projectId) q.set('projectId', projectId);
    if (search.trim()) q.set('search', search.trim());
    for (const [k, v] of Object.entries(filters)) if (v) q.set(k, v);
    return q;
  }, [projectId, search, filters]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const q = new URLSearchParams(query);
      q.set('page', String(page));
      q.set('pageSize', String(pageSize));
      setData(await api<ListResponse>(`/api/members?${q}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [query, page, pageSize]);

  useEffect(() => {
    const t = setTimeout(() => void load(), search ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  // The chosen project is remembered per person.
  useEffect(() => {
    try {
      window.localStorage.setItem(`pds.members.project.${meId ?? 'role'}`, projectId);
    } catch {
      /* a remembered preference only */
    }
  }, [projectId, meId]);

  const refreshLists = async () => {
    const [c, r] = await Promise.all([api<{ rows: Named[] }>('/api/companies'), api<{ rows: Named[] }>('/api/job-roles')]);
    setCompanies(c.rows);
    setRoles(r.rows);
  };

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (done) setNotice(done);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const setSwitch = (r: Row, k: Switch, v: boolean) => act(() => api(`/api/members/${r.id}/access`, 'POST', { projectId, switches: { [k]: v } }));
  const setLevel = (r: Row, level: string) => act(() => api(`/api/members/${r.id}/access`, 'POST', { projectId, level }));

  const rowAction = async (r: Row, action: string) => {
    setMenu(null);
    if (action === 'invite' || action === 'reset') {
      if (action === 'reset' && !window.confirm(`Reset the password of ${r.name}? Their password stops working and every session ends. You get a new invite link to send them.`)) return;
      try {
        const res = await api<{ link: string; expiresAt: string }>(`/api/members/${r.id}/actions`, 'POST', { action });
        setDialog({ kind: 'link', link: res.link, expiresAt: res.expiresAt, email: r.email });
        await load();
      } catch (e) {
        setError((e as Error).message);
      }
      return;
    }
    if (action === 'deactivate' && !window.confirm(`Deactivate ${r.name}? They are signed out at once and cannot sign in. They stay in the history.`)) return;
    if (action === 'remove' && !window.confirm(`Remove ${r.name} from this project?`)) return;
    if (action === 'remove') return act(() => api(`/api/members/${r.id}/access?projectId=${encodeURIComponent(projectId)}`, 'DELETE'), `${r.name} was removed from the project.`);
    if (action === 'accountAdminOn' || action === 'accountAdminOff') return act(() => api(`/api/members/${r.id}`, 'PATCH', { accountAdmin: action === 'accountAdminOn' }));
    if (action === 'copyAccess') return setDialog({ kind: 'copyAccess', row: r });
    if (action === 'edit') return setEditing(r.id);
    return act(() => api(`/api/members/${r.id}/actions`, 'POST', { action }));
  };

  const exportHref = `/api/members/export?${query}`;
  const projectName = projects.find((p) => p.id === projectId)?.path ?? 'All projects';
  const start = data ? (data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1) : 0;
  const end = data ? Math.min(data.total, data.page * data.pageSize) : 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-[17px] font-semibold tracking-tight text-ink">Members</h1>
        <label className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-soft">
          <span className="sr-only">Project</span>
          <select
            className="select h-8 min-w-[16rem] font-medium text-ink"
            value={projectId}
            onChange={(e) => {
              setProjectId(e.target.value);
              setPage(1);
            }}
            data-project-picker=""
          >
            {canAll && <option value="">All projects</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.path}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex min-h-0 flex-1 gap-3">
        <nav className="w-40 shrink-0 space-y-0.5" aria-label="Members lists">
          {(['members', 'companies', 'roles'] as const).map((t) => (
            <button key={t} type="button" className={clsx('block w-full rounded px-2.5 py-1.5 text-left text-[13px]', tab === t ? 'bg-brand-50 font-medium text-brand-700' : 'text-ink-soft hover:bg-slate-100')} onClick={() => setTab(t)}>
              {t === 'members' ? 'Members' : t === 'companies' ? 'Companies' : 'Roles'}
            </button>
          ))}
        </nav>
        <section className="card flex min-h-0 min-w-0 flex-1 flex-col">
          {tab !== 'members' ? (
            <NamedList
              kind={tab === 'companies' ? 'company' : 'role'}
              rows={tab === 'companies' ? companies : roles}
              editable={accountAdmin}
              onChanged={async () => {
                await refreshLists();
                await load();
              }}
            />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
                <div className="relative">
                  <button type="button" className="btn btn-primary btn-sm" aria-haspopup="menu" aria-expanded={addOpen} onClick={() => setAddOpen((v) => !v)} disabled={!projectId && !accountAdmin}>
                    Add members ▾
                  </button>
                  {addOpen && (
                    <div role="menu" className="absolute left-0 z-30 mt-1 w-64 rounded border border-line bg-white py-1 shadow-card">
                      {[
                        { k: 'add' as const, l: 'Add one' },
                        { k: 'import' as const, l: 'Import from Excel / CSV' },
                        { k: 'copyMembers' as const, l: 'Copy members from another project' },
                      ].map((x) => (
                        <button
                          key={x.k}
                          type="button"
                          role="menuitem"
                          className="block w-full px-3 py-1.5 text-left text-[12.5px] hover:bg-brand-50 disabled:text-ink-mute"
                          disabled={x.k !== 'add' && !projectId}
                          title={x.k !== 'add' && !projectId ? 'Choose a project first' : undefined}
                          onClick={() => {
                            setAddOpen(false);
                            setDialog({ kind: x.k });
                          }}
                        >
                          {x.l}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <a className="btn btn-sm" href={exportHref}>
                  Export
                </a>
                <input className="input h-8 w-56" type="search" placeholder="Search by name or email" aria-label="Search by name or email" value={search} onChange={(e) => (setSearch(e.target.value), setPage(1))} />
                <Filter label="Company" value={filters.companyId} options={companies.map((c) => [c.id, c.name])} onChange={(v) => (setFilters({ ...filters, companyId: v }), setPage(1))} />
                <Filter label="Role" value={filters.roleId} options={roles.map((c) => [c.id, c.name])} onChange={(v) => (setFilters({ ...filters, roleId: v }), setPage(1))} />
                <Filter
                  label="Access level"
                  value={filters.level}
                  options={[
                    ['account_admin', 'Account Admin'],
                    ['project_admin', 'Project Admin'],
                    ['member', 'Member'],
                  ]}
                  onChange={(v) => (setFilters({ ...filters, level: v }), setPage(1))}
                />
                <Filter
                  label="Status"
                  value={filters.status}
                  options={[
                    ['active', 'Active'],
                    ['invited', 'Invited'],
                    ['deactivated', 'Deactivated'],
                  ]}
                  onChange={(v) => (setFilters({ ...filters, status: v }), setPage(1))}
                />
                <Filter label="Switch on" value={filters.switch} options={SWITCHES.map((s) => [s.key, s.label])} onChange={(v) => (setFilters({ ...filters, switch: v }), setPage(1))} />
              </div>
              {(error || notice) && (
                <p className={clsx('px-3 py-2 text-[12.5px]', error ? 'text-rag-red' : 'text-emerald-800')} role={error ? 'alert' : 'status'}>
                  {error ?? notice}
                </p>
              )}
              <div className="min-h-0 flex-1 overflow-auto">
                <table className="w-full min-w-[78rem] border-separate border-spacing-0 text-[12.5px]" aria-label={`Members — ${projectName}`}>
                  <thead className="sticky top-0 z-10 bg-surface-sunk text-left text-2xs uppercase tracking-wide text-ink-mute">
                    <tr>
                      {['Name', 'Email', 'Phone', 'Status', 'Company', 'Role', 'Access level', 'Added on', 'Last sign-in', ...SWITCHES.map((s) => s.label), ''].map((h, i) => (
                        <th key={i} className="border-b border-line px-2.5 py-2 font-semibold">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {!data && (
                      <tr>
                        <td colSpan={14} className="px-3 py-6 text-center text-ink-mute">
                          Loading…
                        </td>
                      </tr>
                    )}
                    {data?.rows.length === 0 && (
                      <tr>
                        <td colSpan={14} className="px-3 py-6 text-center text-ink-mute">
                          No members match.
                        </td>
                      </tr>
                    )}
                    {data?.rows.map((r) =>
                      editing === r.id ? (
                        <EditRow key={r.id} row={r} companies={companies} roles={roles} onCancel={() => setEditing(null)} onSave={(patch) => act(async () => (await api(`/api/members/${r.id}`, 'PATCH', patch), setEditing(null), refreshLists()))} />
                      ) : (
                        <tr key={r.id} className="group hover:bg-brand-50/50" data-member-row={r.email}>
                          <td className="border-b border-line/70 px-2.5 py-1.5">
                            <span className="flex items-center gap-2">
                              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-100 text-[11px] font-semibold text-brand-700" aria-hidden="true">
                                {initials(r.name)}
                              </span>
                              <Link href={`/settings/members/${r.id}`} className="font-medium text-ink hover:underline">
                                {r.name}
                              </Link>
                            </span>
                          </td>
                          <td className="border-b border-line/70 px-2.5 py-1.5">{r.email}</td>
                          <td className="border-b border-line/70 px-2.5 py-1.5">{r.phone ?? '—'}</td>
                          <td className="border-b border-line/70 px-2.5 py-1.5">
                            <span className={clsx('inline-flex rounded-full px-2 py-0.5 text-2xs font-medium ring-1', STATUS_TONE[r.status])}>{STATUS_LABEL[r.status] ?? r.status}</span>
                          </td>
                          <td className="border-b border-line/70 px-2.5 py-1.5">{r.company ?? '—'}</td>
                          <td className="border-b border-line/70 px-2.5 py-1.5">{r.role ?? '—'}</td>
                          <td className="border-b border-line/70 px-2.5 py-1.5">
                            {projectId && r.canEdit && !r.accountAdmin ? (
                              <select className="select h-7 py-0.5" value={r.level ?? 'member'} aria-label={`Access level of ${r.name}`} onChange={(e) => void setLevel(r, e.target.value)}>
                                <option value="member">Member</option>
                                <option value="project_admin">Project Admin</option>
                              </select>
                            ) : (
                              r.levelLabel
                            )}
                          </td>
                          <td className="border-b border-line/70 px-2.5 py-1.5 tabular-nums">{fmt(r.addedOn)}</td>
                          <td className="border-b border-line/70 px-2.5 py-1.5 tabular-nums">{fmt(r.lastSignIn, true)}</td>
                          {SWITCHES.map((s) => (
                            <td key={s.key} className="border-b border-line/70 px-2.5 py-1.5">
                              <Toggle on={r.switches[s.key]} disabled={!projectId || r.locked || !r.canEdit || r.status === 'deactivated'} label={`${s.label} for ${r.name}`} onChange={(v) => void setSwitch(r, s.key, v)} />
                            </td>
                          ))}
                          <td className="relative border-b border-line/70 px-2 py-1.5 text-right">
                            <button type="button" className="rounded px-1.5 text-ink-mute hover:bg-slate-200 hover:text-ink" aria-label={`Actions for ${r.name}`} aria-haspopup="menu" aria-expanded={menu === r.id} onClick={() => setMenu(menu === r.id ? null : r.id)}>
                              ⋮
                            </button>
                            {menu === r.id && (
                              <RowMenu
                                row={r}
                                projectId={projectId}
                                accountAdmin={accountAdmin}
                                isMe={r.id === meId}
                                onPick={(a) => void rowAction(r, a)}
                                onClose={() => setMenu(null)}
                              />
                            )}
                          </td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2 text-[12px] text-ink-soft">
                <span className="mr-auto" data-paging="">
                  Showing {start}–{end} of {data?.total ?? 0}
                </span>
                <label className="inline-flex items-center gap-1">
                  Rows
                  <select className="select h-7 py-0.5" value={pageSize} onChange={(e) => (setPageSize(Number(e.target.value)), setPage(1))}>
                    {[20, 50, 100].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" className="btn btn-sm" disabled={!data || data.page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </button>
                <button type="button" className="btn btn-sm" disabled={!data || data.page >= data.pageCount} onClick={() => setPage((p) => p + 1)}>
                  Next
                </button>
              </div>
            </>
          )}
        </section>
      </div>

      {dialog?.kind === 'link' && (
        <Dialog title="Invite link" onClose={() => setDialog(null)}>
          <LinkBox link={dialog.link} expiresAt={dialog.expiresAt} email={dialog.email} />
        </Dialog>
      )}
      {dialog?.kind === 'add' && (
        <AddOne
          projects={projects}
          projectId={projectId}
          accountAdmin={accountAdmin}
          companies={companies}
          roles={roles}
          onClose={() => setDialog(null)}
          onAdded={async (res, email) => {
            await refreshLists();
            await load();
            if (res.invite) setDialog({ kind: 'link', link: res.invite.link, expiresAt: res.invite.expiresAt, email });
            else {
              setDialog(null);
              setNotice(`${email} was given access.`);
            }
          }}
        />
      )}
      {dialog?.kind === 'import' && (
        <ImportMembers
          projectId={projectId}
          projectName={projectName}
          onClose={() => setDialog(null)}
          onDone={async () => {
            await refreshLists();
            await load();
          }}
        />
      )}
      {dialog?.kind === 'copyMembers' && (
        <CopyMembers
          projects={projects.filter((p) => p.id !== projectId)}
          toProjectId={projectId}
          onClose={() => setDialog(null)}
          onDone={async (n) => {
            setDialog(null);
            setNotice(`${n} member(s) copied.`);
            await load();
          }}
        />
      )}
      {dialog?.kind === 'copyAccess' && (
        <CopyAccess
          row={dialog.row}
          fromProjectId={projectId}
          projects={projects.filter((p) => p.id !== projectId)}
          onClose={() => setDialog(null)}
          onDone={async () => {
            setDialog(null);
            setNotice(`Access of ${dialog.row.name} copied.`);
            await load();
          }}
        />
      )}
    </div>
  );
}

function Filter({ label, value, options, onChange }: { label: string; value?: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <select className="select h-8 w-auto max-w-[11rem]" aria-label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">{label}: all</option>
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}

function RowMenu({ row, projectId, accountAdmin, isMe, onPick, onClose }: { row: Row; projectId: string; accountAdmin: boolean; isMe: boolean; onPick: (a: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const off = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, [onClose]);
  const items: [string, string, boolean][] = [
    ['edit', 'Edit details', row.canEdit],
    ['invite', row.status === 'invited' ? 'Copy invite link / Resend' : '', row.canEdit && row.status === 'invited'],
    ['reset', 'Reset password', row.canEdit && row.status === 'active'],
    ['copyAccess', 'Copy access to other projects', !!projectId && row.canEdit && !row.accountAdmin],
    ['remove', 'Remove from project', !!projectId && row.canEdit && !row.accountAdmin && !isMe],
    [row.status === 'deactivated' ? 'reactivate' : 'deactivate', row.status === 'deactivated' ? 'Reactivate' : 'Deactivate', row.canEdit && !isMe],
    [row.accountAdmin ? 'accountAdminOff' : 'accountAdminOn', row.accountAdmin ? 'Remove Account Admin' : 'Make Account Admin', accountAdmin && row.status !== 'deactivated'],
  ];
  return (
    <div ref={ref} role="menu" className="absolute right-2 z-30 mt-1 w-60 rounded border border-line bg-white py-1 text-left shadow-card">
      {items
        .filter(([, l, ok]) => ok && l)
        .map(([k, l]) => (
          <button key={k} type="button" role="menuitem" className={clsx('block w-full px-3 py-1.5 text-[12.5px] hover:bg-brand-50', (k === 'deactivate' || k === 'remove') && 'text-rag-red')} onClick={() => onPick(k)}>
            {l}
          </button>
        ))}
      <Link role="menuitem" href={`/settings/members/${row.id}`} className="block px-3 py-1.5 text-[12.5px] hover:bg-brand-50">
        Open details
      </Link>
    </div>
  );
}

function EditRow({ row, companies, roles, onCancel, onSave }: { row: Row; companies: Named[]; roles: Named[]; onCancel: () => void; onSave: (p: { name: string; email?: string; phone: string | null; company: string | null; role: string | null }) => void }) {
  const emailEditable = row.status === 'invited';
  const [v, setV] = useState({ name: row.name, email: row.email, phone: row.phone ?? '', company: row.company ?? '', role: row.role ?? '' });
  return (
    <tr className="bg-brand-50/40">
      <td className="border-b border-line/70 px-2.5 py-1.5">
        <input className="input h-7" aria-label="Name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} autoFocus />
      </td>
      <td className="border-b border-line/70 px-2.5 py-1.5 text-ink-mute">
        {emailEditable ? <input className="input h-7" aria-label="Email" type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} /> : row.email}
      </td>
      <td className="border-b border-line/70 px-2.5 py-1.5">
        <input className="input h-7" aria-label="Phone" value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} />
      </td>
      <td className="border-b border-line/70 px-2.5 py-1.5" />
      <td className="border-b border-line/70 px-2.5 py-1.5">
        <input className="input h-7" aria-label="Company" list="pds-companies" value={v.company} onChange={(e) => setV({ ...v, company: e.target.value })} />
        <datalist id="pds-companies">
          {companies.map((c) => (
            <option key={c.id} value={c.name} />
          ))}
        </datalist>
      </td>
      <td className="border-b border-line/70 px-2.5 py-1.5">
        <input className="input h-7" aria-label="Role" list="pds-roles" value={v.role} onChange={(e) => setV({ ...v, role: e.target.value })} />
        <datalist id="pds-roles">
          {roles.map((c) => (
            <option key={c.id} value={c.name} />
          ))}
        </datalist>
      </td>
      <td colSpan={8} className="border-b border-line/70 px-2.5 py-1.5">
        <div className="flex gap-2">
          <button type="button" className="btn btn-primary btn-sm" disabled={!v.name.trim()} onClick={() => onSave({ name: v.name, ...(emailEditable && v.email !== row.email ? { email: v.email } : {}), phone: v.phone || null, company: v.company || null, role: v.role || null })}>
            Save
          </button>
          <button type="button" className="btn btn-sm" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </td>
    </tr>
  );
}

function AddOne({
  projects,
  projectId,
  accountAdmin,
  companies,
  roles,
  onClose,
  onAdded,
}: {
  projects: Project[];
  projectId: string;
  accountAdmin: boolean;
  companies: Named[];
  roles: Named[];
  onClose: () => void;
  onAdded: (res: { invite: { link: string; expiresAt: string } | null }, email: string) => void;
}) {
  const [v, setV] = useState({ name: '', email: '', phone: '', company: '', role: '', projectId, level: 'member', accountAdmin: false });
  const [sw, setSw] = useState<Record<Switch, boolean>>({ billing: false, edit: false, importExport: false, planning: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = v.level === 'project_admin' || v.accountAdmin;
  return (
    <Dialog title="Add a member" onClose={onClose}>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const res = await api<{ invite: { link: string; expiresAt: string } | null }>('/api/members', 'POST', {
              name: v.name,
              email: v.email,
              phone: v.phone || null,
              company: v.company || null,
              role: v.role || null,
              projectId: v.projectId || null,
              level: v.level,
              switches: sw,
              accountAdmin: v.accountAdmin,
            });
            onAdded(res, v.email.trim().toLowerCase());
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="block">
          <span className="label">Name</span>
          <input className="input" required autoFocus value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        </label>
        <label className="block">
          <span className="label">Email</span>
          <input className="input" type="email" required value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />
        </label>
        <label className="block">
          <span className="label">Phone (optional)</span>
          <input className="input" value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} />
        </label>
        <label className="block">
          <span className="label">Company</span>
          <input className="input" list="pds-add-companies" value={v.company} onChange={(e) => setV({ ...v, company: e.target.value })} />
          <datalist id="pds-add-companies">
            {companies.map((c) => (
              <option key={c.id} value={c.name} />
            ))}
          </datalist>
        </label>
        <label className="block">
          <span className="label">Role</span>
          <input className="input" list="pds-add-roles" value={v.role} onChange={(e) => setV({ ...v, role: e.target.value })} />
          <datalist id="pds-add-roles">
            {roles.map((c) => (
              <option key={c.id} value={c.name} />
            ))}
          </datalist>
        </label>
        <label className="block">
          <span className="label">Project</span>
          <select className="select" value={v.projectId} onChange={(e) => setV({ ...v, projectId: e.target.value })} required={!v.accountAdmin}>
            <option value="">{v.accountAdmin ? '— every project (Account Admin) —' : 'Choose a project'}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.path}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="label">Access level</span>
          <select className="select" value={v.level} onChange={(e) => setV({ ...v, level: e.target.value })} disabled={v.accountAdmin}>
            <option value="member">Member</option>
            <option value="project_admin">Project Admin</option>
          </select>
        </label>
        {accountAdmin && (
          <label className="flex items-center gap-2 self-end text-[12.5px]">
            <input type="checkbox" checked={v.accountAdmin} onChange={(e) => setV({ ...v, accountAdmin: e.target.checked })} /> Account Admin (every project, every module)
          </label>
        )}
        <fieldset className="sm:col-span-2">
          <legend className="label">Modules{locked ? ' — all on for a Project Admin / Account Admin' : ''}</legend>
          <div className="flex flex-wrap gap-4 text-[12.5px]">
            <span className="inline-flex items-center gap-2 text-ink-mute">
              <Toggle on disabled label="Drawing Status" onChange={() => undefined} /> Drawing Status
            </span>
            {SWITCHES.map((s) => (
              <span key={s.key} className="inline-flex items-center gap-2">
                <Toggle on={locked || sw[s.key]} disabled={locked} label={s.label} onChange={(on) => setSw({ ...sw, [s.key]: on })} /> {s.label}
              </span>
            ))}
          </div>
        </fieldset>
        {error && (
          <p className="text-[12.5px] text-rag-red sm:col-span-2" role="alert">
            {error}
          </p>
        )}
        <div className="flex gap-2 sm:col-span-2">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Adding…' : 'Add member'}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

interface ImportResult {
  counts: { new: number; updated: number; skipped: number; errors: number };
  rows: { row: number; name: string; email: string; company: string | null; role: string | null; level: string; action: string; reason: string | null }[];
  applied: boolean;
  links: { email: string; link: string }[];
}

function ImportMembers({ projectId, projectName, onClose, onDone }: { projectId: string; projectName: string; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [res, setRes] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (apply: boolean) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set('file', file);
      fd.set('projectId', projectId);
      fd.set('apply', apply ? '1' : '0');
      const r = await fetch('/api/members/import', { method: 'POST', body: fd });
      const data = (await r.json().catch(() => ({}))) as ImportResult & { error?: string };
      if (!r.ok) throw new Error(data.error ?? 'The import failed.');
      setRes(data);
      if (apply) onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={`Import members into ${projectName}`} onClose={onClose} wide>
      <p className="text-[12.5px] text-ink-soft">
        Excel (.xlsx) or CSV: our <a className="link" href={"/api/members/template"}>template</a>, or Forma&rsquo;s own Members export. Columns are found by name: Name, Email, Phone, Company, Role, Access level (and Billing, Edit Mode, Import / Export, Planning: Yes / No). &ldquo;Project Admin&rdquo; becomes Project Admin, anything else Member. New companies and roles are added.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input type="file" accept=".xlsx,.csv" aria-label="Members file" onChange={(e) => (setFile(e.target.files?.[0] ?? null), setRes(null))} />
        <button type="button" className="btn btn-sm" disabled={!file || busy} onClick={() => void run(false)}>
          {busy && !res ? 'Reading…' : 'Dry run'}
        </button>
        {res && !res.applied && (
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || res.counts.new + res.counts.updated === 0} onClick={() => void run(true)}>
            Confirm import ({res.counts.new} new, {res.counts.updated} updated)
          </button>
        )}
      </div>
      {error && (
        <p className="mt-2 text-[12.5px] text-rag-red" role="alert">
          {error}
        </p>
      )}
      {res && (
        <div className="mt-3 space-y-3">
          <p className="text-[12.5px]" data-import-counts="">
            {res.applied ? 'Imported' : 'Dry run'}: <b>{res.counts.new}</b> new · <b>{res.counts.updated}</b> updated · <b>{res.counts.skipped}</b> skipped · <b>{res.counts.errors}</b> errors
          </p>
          <div className="max-h-72 overflow-auto rounded border border-line">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-surface-sunk text-left text-2xs uppercase text-ink-mute">
                <tr>
                  {['Row', 'Name', 'Email', 'Company', 'Role', 'Level', 'Result', 'Reason'].map((h) => (
                    <th key={h} className="px-2 py-1 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {res.rows.map((r) => (
                  <tr key={`${r.row}-${r.email}`} className="border-t border-line/60">
                    <td className="px-2 py-1 tabular-nums">{r.row}</td>
                    <td className="px-2 py-1">{r.name}</td>
                    <td className="px-2 py-1">{r.email}</td>
                    <td className="px-2 py-1">{r.company ?? ''}</td>
                    <td className="px-2 py-1">{r.role ?? ''}</td>
                    <td className="px-2 py-1">{r.level === 'project_admin' ? 'Project Admin' : 'Member'}</td>
                    <td className={clsx('px-2 py-1', r.action === 'error' && 'text-rag-red')}>{r.action}</td>
                    <td className="px-2 py-1 text-ink-soft">{r.reason ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {res.applied && res.links.length > 0 && (
            <div>
              <p className="text-[12.5px] font-medium">One-time invite links (shown only now):</p>
              <div className="mt-1 space-y-3">
                {res.links.map((l) => (
                  <LinkBox key={l.email} link={l.link} expiresAt={new Date(Date.now() + 72 * 3_600_000).toISOString()} email={l.email} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

function CopyMembers({ projects, toProjectId, onClose, onDone }: { projects: Project[]; toProjectId: string; onClose: () => void; onDone: (n: number) => void }) {
  const [from, setFrom] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title="Copy members from another project" onClose={onClose}>
      <p className="text-[12.5px] text-ink-soft">Every member of the chosen project gets the same access level and switches on this project.</p>
      <select className="select mt-2" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Copy from">
        <option value="">Choose a project</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.path}
          </option>
        ))}
      </select>
      {error && (
        <p className="mt-2 text-[12.5px] text-rag-red" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        className="btn btn-primary mt-3"
        disabled={!from}
        onClick={async () => {
          try {
            const r = await api<{ copied: number }>('/api/members/copy', 'POST', { fromProjectId: from, toProjectId });
            onDone(r.copied);
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        Copy members
      </button>
    </Dialog>
  );
}

function CopyAccess({ row, fromProjectId, projects, onClose, onDone }: { row: Row; fromProjectId: string; projects: Project[]; onClose: () => void; onDone: () => void }) {
  const [to, setTo] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title={`Copy the access of ${row.name} to other projects`} onClose={onClose}>
      <div className="max-h-64 space-y-1 overflow-auto">
        {projects.map((p) => (
          <label key={p.id} className="flex items-center gap-2 text-[12.5px]">
            <input type="checkbox" checked={to.includes(p.id)} onChange={(e) => setTo(e.target.checked ? [...to, p.id] : to.filter((x) => x !== p.id))} /> {p.path}
          </label>
        ))}
      </div>
      {error && (
        <p className="mt-2 text-[12.5px] text-rag-red" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        className="btn btn-primary mt-3"
        disabled={!to.length}
        onClick={async () => {
          try {
            await api(`/api/members/${row.id}/actions`, 'POST', { action: 'copyAccess', fromProjectId, toProjectIds: to });
            onDone();
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        Copy access
      </button>
    </Dialog>
  );
}

function NamedList({ kind, rows, editable, onChanged }: { kind: 'company' | 'role'; rows: Named[]; editable: boolean; onChanged: () => void }) {
  const url = kind === 'company' ? '/api/companies' : '/api/job-roles';
  const [name, setName] = useState('');
  const [edit, setEdit] = useState<{ id: string; name: string } | null>(null);
  const [merge, setMerge] = useState<{ from: string; into: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (body: unknown) => {
    setError(null);
    try {
      await api(url, 'POST', body);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const title = kind === 'company' ? 'Companies' : 'Roles';
  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      <h2 className="text-[14px] font-semibold">{title}</h2>
      {!editable && <p className="mt-1 text-[12px] text-ink-mute">Only an Account Admin edits this list. New names are added when members are added or imported.</p>}
      {editable && (
        <div className="mt-2 flex flex-wrap gap-2">
          <input className="input h-8 w-64" placeholder={`New ${kind}`} aria-label={`New ${kind}`} value={name} onChange={(e) => setName(e.target.value)} />
          <button type="button" className="btn btn-sm" disabled={!name.trim()} onClick={() => void run({ name }).then(() => setName(''))}>
            Add
          </button>
        </div>
      )}
      {error && (
        <p className="mt-2 text-[12.5px] text-rag-red" role="alert">
          {error}
        </p>
      )}
      <table className="mt-3 w-full max-w-2xl text-[12.5px]">
        <thead className="text-left text-2xs uppercase text-ink-mute">
          <tr>
            <th className="py-1 font-semibold">Name</th>
            <th className="py-1 text-right font-semibold">Members</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-line/60">
              <td className="py-1.5">
                {edit?.id === r.id ? (
                  <span className="flex gap-2">
                    <input className="input h-7" aria-label="Name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => void run({ id: r.id, name: edit.name }).then(() => setEdit(null))}>
                      Save
                    </button>
                    <button type="button" className="btn btn-sm" onClick={() => setEdit(null)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  r.name
                )}
              </td>
              <td className="py-1.5 text-right tabular-nums">{r.members}</td>
              <td className="py-1.5 pl-3 text-right">
                {editable && edit?.id !== r.id && (
                  <span className="inline-flex gap-2">
                    <button type="button" className="link text-[12px]" onClick={() => setEdit({ id: r.id, name: r.name })}>
                      Rename
                    </button>
                    {merge?.from === r.id ? (
                      <span className="inline-flex gap-1">
                        <select className="select h-7 py-0.5" aria-label="Merge into" value={merge.into} onChange={(e) => setMerge({ ...merge, into: e.target.value })}>
                          <option value="">Merge into…</option>
                          {rows
                            .filter((x) => x.id !== r.id)
                            .map((x) => (
                              <option key={x.id} value={x.id}>
                                {x.name}
                              </option>
                            ))}
                        </select>
                        <button type="button" className="btn btn-sm" disabled={!merge.into} onClick={() => void run({ mergeFrom: r.id, mergeInto: merge.into }).then(() => setMerge(null))}>
                          Merge
                        </button>
                      </span>
                    ) : (
                      <button type="button" className="link text-[12px]" onClick={() => setMerge({ from: r.id, into: '' })}>
                        Merge
                      </button>
                    )}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
