import Link from 'next/link';
import { Card, DateCell, Kpi, Note, PageHeader, TableWrap } from '@/components/ui';
import { FilterBar, type FilterDef } from '@/components/filter-bar';
import { Pagination } from '@/components/pagination';
import { auditActions, queryAudit } from '@/lib/audit';
import { listProjects } from '@/lib/services/reference';
import { AUDIT_ACTIONS, ENTITY_TYPES, FY26_ENTITY_TYPES } from '@/lib/domain';

export const dynamic = 'force-dynamic';

function short(v: string | null): string {
  if (!v) return '—';
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const d = new Date(v);
    return `${String(d.getUTCDate()).padStart(2, '0')}-${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]}-${d.getUTCFullYear()}`;
  }
  return v.length > 70 ? `${v.slice(0, 70)}…` : v;
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const page = Number(sp.page ?? 1);
  const pageSize = Number(sp.pageSize ?? 50);
  const [result, projects, actions] = await Promise.all([
    queryAudit({
      entityType: sp.entityType,
      entityId: sp.entityId,
      action: sp.action,
      projectId: sp.projectId,
      search: sp.search,
      page,
      pageSize,
    }),
    listProjects(),
    auditActions(),
  ]);

  const defs: FilterDef[] = [
    { key: 'entityType', label: 'Record type', type: 'select', options: [...ENTITY_TYPES, 'PROJECT', 'IMPORT_RUN', 'EXPORT', 'DATABASE', 'DEPENDENCY', ...FY26_ENTITY_TYPES, 'FY26_IMPORT'].map((t) => ({ value: t, label: t })), width: '11rem' },
    { key: 'action', label: 'Action', type: 'select', options: (actions.length ? actions : [...AUDIT_ACTIONS]).map((a) => ({ value: a, label: a })), width: '11rem' },
    { key: 'projectId', label: 'Project', type: 'select', options: projects.map((p) => ({ value: p.id, label: p.projectName })), width: '13rem' },
  ];

  return (
    <>
      <PageHeader
        title="Audit trail"
        description="Who changed what, from what to what, when and why. Written for every material change: completion, dates, quantities, rescheduling, RAG overrides, imports, exports and backups."
        crumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Audit' }]}
        actions={
          sp.entityId ? (
            <Link href="/audit" className="btn">
              Clear record filter
            </Link>
          ) : undefined
        }
      />

      <FilterBar filters={defs} />

      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Entries in view" value={result.total.toLocaleString()} />
        <Kpi label="Page" value={`${result.page} / ${Math.max(1, Math.ceil(result.total / result.pageSize))}`} />
        <Kpi label="Distinct actions" value={actions.length} />
        <Kpi label="Record filter" value={sp.entityId ? '1 record' : 'all'} />
      </div>

      <Card title="Change log" bodyClassName="">
        <TableWrap maxHeight="66vh">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>User</th>
                <th>Action</th>
                <th>Record</th>
                <th>Field</th>
                <th>From</th>
                <th>To</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap">
                    <DateCell value={r.timestamp} muted />
                    <span className="sub block">{r.timestamp.toISOString().slice(11, 19)}</span>
                  </td>
                  <td className="text-ink-mute">{r.userLabel ?? '—'}</td>
                  <td>
                    <span className="pill bg-slate-100 text-slate-700">{r.action}</span>
                  </td>
                  <td className="max-w-[260px]">
                    <span className="block truncate" title={r.entityLabel ?? r.entityId}>
                      {r.entityLabel ?? r.entityId}
                    </span>
                    <span className="sub">{r.entityType}</span>
                  </td>
                  <td className="font-mono text-[11px]">{r.field ?? '—'}</td>
                  <td className="max-w-[180px] truncate text-ink-mute" title={r.oldValue ?? ''}>
                    {short(r.oldValue)}
                  </td>
                  <td className="max-w-[180px] truncate font-medium" title={r.newValue ?? ''}>
                    {short(r.newValue)}
                  </td>
                  <td className="max-w-[220px] truncate text-ink-mute" title={r.reason ?? ''}>
                    {r.reason ?? '—'}
                  </td>
                </tr>
              ))}
              {result.rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-6 text-center text-ink-mute">
                    No audit entries match the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableWrap>
        <Pagination
          page={result.page}
          pageCount={Math.max(1, Math.ceil(result.total / result.pageSize))}
          total={result.total}
          pageSize={result.pageSize}
        />
      </Card>

      <div className="mt-4">
        <Note>
          Audit entries are append-only. Reverting a completion or a date produces a new entry rather than erasing the
          old one, so the history of a record is always reconstructable.
        </Note>
      </div>
    </>
  );
}
