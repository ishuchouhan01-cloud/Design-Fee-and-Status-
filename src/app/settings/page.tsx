import { Card, Empty, Kpi, Note, PageHeader, TableWrap } from '@/components/ui';
import { BackupPanel } from '@/components/backup-panel';
import { config } from '@/lib/config';
import { db } from '@/db';
import { appSettings, importIssues, importRuns, users } from '@/db/schema';
import { desc, eq, sql } from 'drizzle-orm';
import { runDataQualityChecks } from '@/lib/import/quality';
import { currentTotals } from '@/lib/import';
import { backupTargetInfo, checkPgTools, listBackups } from '@/lib/services/backup';
import { ROLE_DESCRIPTION, ROLE_PERMISSIONS } from '@/lib/rbac';
import { ROLES } from '@/lib/domain';
import { getCurrentUser } from '@/lib/auth';
import { headers } from 'next/headers';
import { LOGIN_ROLE_LABEL } from '@/lib/access';
import { SwitchUserButton } from '@/components/switch-user-button';

export const dynamic = 'force-dynamic';

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
  const sp = await searchParams;
  const signedIn = await getCurrentUser((await headers()) as unknown as Headers);
  const switchCard = (
    <Card title="Signed in" subtitle={`As ${LOGIN_ROLE_LABEL[signedIn.loginRole]}`}>
      <p className="mb-3 text-[12.5px] text-ink-soft">Switch User ends this session (Edit Mode goes off) and returns to the sign-in screen.</p>
      <SwitchUserButton />
    </Card>
  );
  // Viewer and Admin: Switch User only.
  if (signedIn.loginRole !== 'SUPER_ADMIN') {
    return (
      <div className="mx-auto max-w-xl">
        <PageHeader title="Settings" crumbs={[{ label: 'Project Drawing Status', href: '/drawings' }, { label: 'Settings' }]} />
        {switchCard}
      </div>
    );
  }
  const [totals, quality, runs, settings, userRows, me] = await Promise.all([
    currentTotals(),
    runDataQualityChecks(),
    db.select().from(importRuns).orderBy(desc(importRuns.startedAt)).limit(10),
    db.select().from(appSettings).orderBy(appSettings.key),
    db.select().from(users).orderBy(users.name).limit(300),
    getCurrentUser((await headers()) as unknown as Headers),
  ]);
  const activeRun = sp.run ?? runs[0]?.id;
  const issues = activeRun
    ? await db
        .select()
        .from(importIssues)
        .where(eq(importIssues.importRunId, activeRun))
        .orderBy(importIssues.severity)
        .limit(500)
    : [];
  const roleCounts = await db
    .select({ role: users.role, n: sql<number>`count(*)::int` })
    .from(users)
    .groupBy(users.role);
  const backups = listBackups();
  const pgTools = await checkPgTools();

  return (
    <>
      <PageHeader
        title="Settings"
        description="System state, data quality, import history, backups and roles."
        crumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Settings' }]}
      />
      <div className="mb-4">{switchCard}</div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <Kpi label="Projects" value={totals.projects} />
        <Kpi label="Packages" value={totals.packages} />
        <Kpi label="Goals" value={totals.goals.toLocaleString()} />
        <Kpi label="Deliverables" value={totals.deliverables.toLocaleString()} />
        <Kpi label="Drawings" value={totals.drawings.toLocaleString()} />
        <Kpi label="Dependencies" value={totals.dependencies} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title="System" subtitle="Where the data lives">
          <dl className="space-y-1.5 text-[12px]">
            <Row k="Engine" v="PostgreSQL" />
            <Row k="Connection" v={config.databaseLabel} mono />
            <Row k="Backup directory" v={backupTargetInfo().directory} mono />
            <Row k="Pool size" v={String(config.dbPoolMax)} />
            <Row k="Import directory" v={config.importDir} mono />
            <Row k="Sign-in" v="Viewer · Admin · Super Admin (sign-in screen)" />
            <Row k="Fiscal year starts" v={`month ${config.fiscalYearStartMonth}`} />
            <Row k="Due-soon horizon" v={`${config.dueSoonDays} days`} />
            <Row k="Signed in as" v={LOGIN_ROLE_LABEL[me.loginRole]} />
          </dl>
          <p className="mt-3 text-2xs leading-relaxed text-ink-mute">
            Every path above comes from environment configuration. Nothing is hard-coded to a personal machine, so the
            same build runs on a company server unchanged.
          </p>
        </Card>

        <Card title="Application settings" subtitle="Editable key/value configuration held in the database" bodyClassName="">
          <TableWrap maxHeight="280px">
            <table className="table">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {settings.map((s) => (
                  <tr key={s.key}>
                    <td className="font-mono text-[11px]">{s.key}</td>
                    <td className="max-w-[260px] truncate" title={s.value}>
                      {s.value}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>

        <Card title="Data quality" subtitle="Re-run on every page load, not just at migration time" bodyClassName="">
          {quality.length === 0 ? (
            <Empty>No data-quality findings.</Empty>
          ) : (
            <TableWrap maxHeight="300px">
              <table className="table">
                <thead>
                  <tr>
                    <th>Severity</th>
                    <th>Check</th>
                    <th className="num">Cases</th>
                    <th>Example</th>
                  </tr>
                </thead>
                <tbody>
                  {quality.map((q) => (
                    <tr key={q.code}>
                      <td>
                        <span
                          className={`pill ${q.severity === 'ERROR' ? 'bg-red-50 text-rag-red' : q.severity === 'WARNING' ? 'bg-amber-50 text-rag-amber' : 'bg-slate-100 text-slate-600'}`}
                        >
                          {q.severity}
                        </span>
                      </td>
                      <td>
                        <span className="font-medium">{q.message}</span>
                        <span className="sub block font-mono">{q.code}</span>
                      </td>
                      <td className="num">{q.count}</td>
                      <td className="max-w-[260px] truncate text-ink-mute" title={q.sample?.join(', ')}>
                        {q.sample?.slice(0, 2).join(', ') ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        <Card title="Backup" subtitle="pg_dump custom format — safe to run while the app is in use">
          {!pgTools.available && (
            <div className="mb-3">
              <Note tone="warn">
                <strong>Backups are unavailable.</strong> <span className="font-mono">{pgTools.command}</span> could
                not be run. {pgTools.hint}
              </Note>
            </div>
          )}
          <BackupPanel
            initial={backups.map((b) => ({ name: b.name, bytes: b.bytes, createdAt: b.createdAt.toISOString() }))}
            info={backupTargetInfo()}
            toolVersion={pgTools.available ? pgTools.version : null}
          />
        </Card>
      </div>

      <Card title="Import history" subtitle="Every migration run, with its warnings and unmapped rows" className="mt-4" bodyClassName="">
        {runs.length === 0 ? (
          <Empty>No imports recorded. Run `npm run migrate:excel`.</Empty>
        ) : (
          <>
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Workbooks</th>
                    <th>Status</th>
                    <th className="num">Created</th>
                    <th className="num">Updated</th>
                    <th className="num">Sheets skipped</th>
                    <th className="num">Warnings</th>
                    <th className="num">Errors</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id} className={r.id === activeRun ? 'bg-brand-50' : undefined}>
                      <td className="whitespace-nowrap font-mono text-[11px]">{r.startedAt.toISOString().slice(0, 19).replace('T', ' ')}</td>
                      <td className="max-w-[320px] truncate" title={r.workbook}>
                        {r.workbook}
                      </td>
                      <td>
                        <span
                          className={`pill ${r.status === 'SUCCESS' ? 'bg-emerald-50 text-rag-green' : r.status === 'PARTIAL' ? 'bg-amber-50 text-rag-amber' : 'bg-red-50 text-rag-red'}`}
                        >
                          {r.status}
                        </span>
                      </td>
                      <td className="num">{r.createdCount}</td>
                      <td className="num">{r.updatedCount}</td>
                      <td className="num">{r.skippedCount}</td>
                      <td className="num">{r.warningCount}</td>
                      <td className="num">{r.errorCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <div className="border-t border-line">
              <p className="px-4 pt-3 card-title">Import log — most recent run</p>
              <TableWrap maxHeight="320px">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Severity</th>
                      <th>Code</th>
                      <th>Sheet</th>
                      <th className="num">Row</th>
                      <th>Message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {issues.map((i) => (
                      <tr key={i.id}>
                        <td>
                          <span
                            className={`pill ${i.severity === 'ERROR' ? 'bg-red-50 text-rag-red' : i.severity === 'WARNING' ? 'bg-amber-50 text-rag-amber' : 'bg-slate-100 text-slate-600'}`}
                          >
                            {i.severity}
                          </span>
                        </td>
                        <td className="font-mono text-[11px]">{i.code}</td>
                        <td className="text-ink-mute">{i.sheet ?? '—'}</td>
                        <td className="num">{i.rowNumber ?? '—'}</td>
                        <td className="max-w-[620px]">{i.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </div>
          </>
        )}
      </Card>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title="Roles and permissions" subtitle="Authorization is kept separate from business logic" bodyClassName="">
          <TableWrap>
            <table className="table">
              <thead>
                <tr>
                  <th>Role</th>
                  <th className="num">Users</th>
                  <th>What it can do</th>
                  <th className="num">Permissions</th>
                </tr>
              </thead>
              <tbody>
                {ROLES.map((role) => (
                  <tr key={role}>
                    <td className="font-semibold">{role}</td>
                    <td className="num">{roleCounts.find((r) => r.role === role)?.n ?? 0}</td>
                    <td>{ROLE_DESCRIPTION[role]}</td>
                    <td className="num">{ROLE_PERMISSIONS[role].length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>

        <Card title="People" subtitle="Design leads and team members created from the workbooks" bodyClassName="">
          <TableWrap maxHeight="280px">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Active</th>
                </tr>
              </thead>
              <tbody>
                {userRows.map((u) => (
                  <tr key={u.id}>
                    <td className="font-medium">{u.name}</td>
                    <td className="font-mono text-[11px] text-ink-mute">{u.email}</td>
                    <td>{u.role}</td>
                    <td>{u.active ? 'yes' : 'no'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      </div>

      <div className="mt-4">
        <Note tone="warn">
          Backups are written with <span className="font-mono">pg_dump</span> in PostgreSQL&rsquo;s custom format.
          Do not point the backup directory at a synchronised OneDrive or SharePoint folder — keep dumps on the
          server or on a proper backup target. For production, run this alongside the company&rsquo;s normal
          PostgreSQL backup job rather than instead of it.
        </Note>
      </div>
    </>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-ink-mute">{k}</dt>
      <dd className={`truncate text-right ${mono ? 'font-mono text-[11px]' : 'font-medium'}`} title={v}>
        {v}
      </dd>
    </div>
  );
}
