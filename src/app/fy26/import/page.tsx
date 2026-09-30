import Link from 'next/link';
import { headers } from 'next/headers';
import { ImportControls } from '@/components/fy26-import-controls';
import { Card, Empty, Note, PageHeader, TableWrap } from '@/components/ui';
import { getCurrentUser } from '@/lib/auth';
import { can } from '@/lib/rbac';
import { importIssueSummary, listImportBatches, listImportIssues } from '@/lib/services/fy26';

export const dynamic = 'force-dynamic';

interface Stored {
  totals?: Record<string, number>;
  validation?: { metric: string; expected: number; actual: number; difference: number; status: string }[];
  error?: string;
}

function when(d: Date | null) {
  return d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '—';
}

const SEVERITY_TONE: Record<string, string> = {
  ERROR: 'bg-rose-600 text-white',
  WARNING: 'bg-amber-500 text-white',
  INFO: 'bg-slate-200 text-slate-700',
};

export default async function Fy26ImportPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const [batches, user] = await Promise.all([
    listImportBatches(20),
    getCurrentUser((await headers()) as unknown as Headers),
  ]);
  const selected = batches.find((b) => b.id === sp.batchId) ?? batches[0] ?? null;
  const [summary, issues] = selected
    ? await Promise.all([
        importIssueSummary(selected.id),
        listImportIssues(selected.id, sp.severity || undefined, sp.code || undefined, 1000),
      ])
    : [[], []];
  const stored: Stored = selected ? JSON.parse(selected.previewJson || '{}') : {};

  const link = (extra: Record<string, string>) => {
    const q = new URLSearchParams();
    if (selected) q.set('batchId', selected.id);
    for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v);
    return `/fy26/import?${q.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="Design Goals – Financial Year 2026–27: import report"
        description="Every run is recorded with its validation table and every row it skipped, merged or protected — with the workbook, sheet and row it came from."
        crumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Design Goals – Financial Year 2026–27', href: '/fy26' },
          { label: 'Import report' },
        ]}
      />

      {can(user.role, 'fy26.import') ? (
        <Card title="Run the import" subtitle="Admin only">
          <ImportControls />
        </Card>
      ) : (
        <Note>Only an Admin can run the import. You can read every report below.</Note>
      )}

      {!selected ? (
        <Empty>No import has been run yet.</Empty>
      ) : (
        <>
          <Card
            title={`Batch ${selected.id}`}
            subtitle={`${selected.status} · started ${when(selected.startedAt)} · ${selected.workbookCount} workbooks · ${selected.sourceFolder}`}
          >
            {stored.error ? <Note tone="warn">This run failed and was rolled back in full: {stored.error}</Note> : null}
            {stored.validation ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th className="num">Expected</th>
                    <th className="num">Actual</th>
                    <th className="num">Difference</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {stored.validation.map((v) => (
                    <tr key={v.metric}>
                      <td>{v.metric}</td>
                      <td className="num">{v.expected}</td>
                      <td className="num">{v.actual}</td>
                      <td className="num">{v.difference}</td>
                      <td>
                        <span className={`pill ${v.status === 'PASS' ? 'bg-emerald-600 text-white' : 'bg-rose-600 text-white'}`}>
                          {v.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            <p className="mt-2 text-[12px] text-slate-600">
              Created {selected.createdCount} · updated {selected.updatedCount} · skipped {selected.skippedCount} ·
              protected from overwrite {selected.protectedCount} · warnings {selected.warningCount} · errors{' '}
              {selected.errorCount}
            </p>
          </Card>

          <Card title="Issues by code" subtitle="Select one to filter the list below">
            <div className="flex flex-wrap gap-1.5">
              <Link href={link({})} className={`btn btn-sm ${!sp.code && !sp.severity ? 'btn-primary' : ''}`}>
                All
              </Link>
              {summary.map((s) => (
                <Link
                  key={`${s.code}-${s.severity}`}
                  href={link({ code: s.code })}
                  className={`btn btn-sm ${sp.code === s.code ? 'btn-primary' : ''}`}
                >
                  <span className={`pill mr-1 ${SEVERITY_TONE[s.severity] ?? ''}`}>{s.severity}</span>
                  {s.code} · {s.total}
                </Link>
              ))}
            </div>
          </Card>

          <Card title="Issues" subtitle={`${issues.length} shown`}>
            {issues.length === 0 ? (
              <Empty>No issues for this filter.</Empty>
            ) : (
              <TableWrap maxHeight="36rem">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Severity</th>
                      <th>Code</th>
                      <th>Workbook</th>
                      <th>Sheet</th>
                      <th className="num">Row</th>
                      <th>Message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {issues.map((i) => (
                      <tr key={i.id}>
                        <td>
                          <span className={`pill ${SEVERITY_TONE[i.severity] ?? ''}`}>{i.severity}</span>
                        </td>
                        <td className="whitespace-nowrap text-[11.5px]">{i.code}</td>
                        <td className="whitespace-nowrap text-[11.5px] text-slate-600">{i.workbook ?? '—'}</td>
                        <td className="whitespace-nowrap text-[11.5px] text-slate-600">{i.sheet ?? '—'}</td>
                        <td className="num">{i.rowNumber ?? '—'}</td>
                        <td className="text-[12px]">{i.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Card>

          {batches.length > 1 ? (
            <Card title="Earlier runs">
              <ul className="space-y-1 text-[12px]">
                {batches.map((b) => (
                  <li key={b.id}>
                    <Link className="link" href={`/fy26/import?batchId=${b.id}`}>
                      {when(b.startedAt)}
                    </Link>{' '}
                    · {b.status} · created {b.createdCount}, updated {b.updatedCount}, protected {b.protectedCount}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </>
      )}
    </>
  );
}
