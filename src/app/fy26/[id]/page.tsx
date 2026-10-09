import Link from 'next/link';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { DependencyList, type DependencyItem } from '@/components/fy26-dependencies';
import { PackageEditor } from '@/components/fy26-package-editor';
import { Card, CompletionBadge, DateCell, Note, PageHeader } from '@/components/ui';
import { getCurrentUser, userCan } from '@/lib/auth';
import { queryAudit } from '@/lib/audit';
import { fy26Reference, getFy26Package, listDependencies, listRevisions } from '@/lib/services/fy26';

export const dynamic = 'force-dynamic';

function iso(d: Date | null | undefined): string | null {
  return d ? new Date(d).toISOString() : null;
}

export default async function Fy26PackagePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pkg = await getFy26Package(id);
  if (!pkg) notFound();

  const [dependencies, revisions, reference, user, audit] = await Promise.all([
    listDependencies(id),
    listRevisions(id),
    fy26Reference(),
    getCurrentUser((await headers()) as unknown as Headers),
    queryAudit({ entityType: 'FY26_PACKAGE', entityId: id, pageSize: 25 }),
  ]);

  const canWrite = userCan(user, 'fy26.write');
  const phaseOptions = reference.phases
    .filter((p) => p.projectId === pkg.projectId)
    .map((p) => ({ value: p.id, label: p.name }));

  const depItems: DependencyItem[] = dependencies.map((d) => ({
    id: d.id,
    sequence: d.sequence,
    stepLabel: d.stepLabel,
    description: d.description,
    targetDate: iso(d.targetDate),
    responsibleText: d.responsibleText,
    remarks: d.remarks,
    completionStatus: d.completionStatus,
    isManual: d.isManual,
    sourceWorkbook: d.sourceWorkbook,
    sourceSheet: d.sourceSheet,
    sourceRow: d.sourceRow,
  }));

  const completedDeps = depItems.filter((d) => d.completionStatus === 'COMPLETED').length;

  return (
    <>
      <PageHeader
        title={pkg.packageDescription}
        description={`${pkg.projectName}${pkg.phaseName ? ` › ${pkg.phaseName}` : ''}${pkg.disciplineName ? ` › ${pkg.disciplineName}` : ''}`}
        crumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Design Goals – Financial Year 2026–27', href: '/fy26' },
          { label: pkg.packageDescription },
        ]}
      />

      <div className="mb-3">
        <PackageEditor
          pkg={{
            id: pkg.id,
            packageDescription: pkg.packageDescription,
            fy26PhaseId: pkg.phaseId,
            disciplineId: pkg.disciplineId,
            responsibleUserId: pkg.responsibleUserId,
            baselineReleaseDate: iso(pkg.baselineReleaseDate),
            currentExpectedReleaseDate: iso(pkg.currentExpectedReleaseDate),
            actualReleaseDate: iso(pkg.actualReleaseDate),
            planBillingCr: pkg.planBillingCr,
            actualBillingCr: pkg.actualBillingCr,
            plannedPackageQuantity: pkg.plannedPackageQuantity,
            actualPackageQuantity: pkg.actualPackageQuantity,
            remarks: pkg.remarks,
            completionStatus: pkg.completionStatus,
          }}
          phases={phaseOptions}
          disciplines={reference.disciplines.map((d) => ({ value: d.id, label: d.name }))}
          responsibles={reference.responsibles.map((r) => ({ value: r.id, label: r.name }))}
          canWrite={canWrite}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <Card title="Package" className="lg:col-span-2">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[12.5px] md:grid-cols-3">
            <div>
              <dt className="label">Status</dt>
              <dd className="mt-0.5">
                <CompletionBadge status={pkg.completionStatus} />
              </dd>
            </div>
            <div>
              <dt className="label">Original release date</dt>
              <dd className="mt-0.5 text-slate-700">
                <DateCell value={pkg.baselineReleaseDate} />
                <span className="ml-1.5 text-[11px] text-slate-400">never overwritten</span>
              </dd>
            </div>
            <div>
              <dt className="label">Current expected</dt>
              <dd className="mt-0.5 text-slate-700">
                <DateCell value={pkg.currentExpectedReleaseDate} />
              </dd>
            </div>
            <div>
              <dt className="label">Actual release</dt>
              <dd className="mt-0.5 text-slate-700">
                <DateCell value={pkg.actualReleaseDate} />
              </dd>
            </div>
            <div>
              <dt className="label">Plan billing [Cr.]</dt>
              <dd className="mt-0.5 text-slate-700">{pkg.planBillingCr?.toFixed(4) ?? '—'}</dd>
            </div>
            <div>
              <dt className="label">Actual billing [Cr.]</dt>
              <dd className="mt-0.5 text-slate-700">{pkg.actualBillingCr?.toFixed(4) ?? '—'}</dd>
            </div>
            <div>
              <dt className="label">Planned package qty</dt>
              <dd className="mt-0.5 text-slate-700">{pkg.plannedPackageQuantity ?? '—'}</dd>
            </div>
            <div>
              <dt className="label">Actual package qty</dt>
              <dd className="mt-0.5 text-slate-700">{pkg.actualPackageQuantity ?? '—'}</dd>
            </div>
            <div>
              <dt className="label">Responsible</dt>
              <dd className="mt-0.5 text-slate-700">
                {pkg.responsibleName ?? pkg.responsibleSourceText ?? '—'}
                {!pkg.responsibleName && pkg.responsibleSourceText ? (
                  <span className="ml-1.5 text-[11px] text-slate-400">source text; no matching user</span>
                ) : null}
              </dd>
            </div>
          </dl>
          {pkg.remarks ? <p className="mt-3 text-[12.5px] text-amber-800">{pkg.remarks}</p> : null}
        </Card>

        <Card title="Source" subtitle="Excel remains the reference">
          <dl className="space-y-1.5 text-[12px]">
            <div>
              <dt className="label">Workbook</dt>
              <dd className="text-slate-700">{pkg.sourceWorkbook}</dd>
            </div>
            <div>
              <dt className="label">Sheet</dt>
              <dd className="text-slate-700">{pkg.sourceSheet}</dd>
            </div>
            <div>
              <dt className="label">Row</dt>
              <dd className="text-slate-700">{pkg.sourceRow}</dd>
            </div>
            <div>
              <dt className="label">Column B in the source</dt>
              <dd className="text-slate-700">{pkg.sourceScopeLabel ?? '—'}</dd>
            </div>
            {pkg.legacyProjectId ? (
              <div>
                <dt className="label">Linked project record</dt>
                <dd>
                  <Link className="link" href={`/projects/${pkg.legacyProjectId}`}>
                    Open in Projects
                  </Link>
                </dd>
              </div>
            ) : null}
          </dl>
        </Card>
      </div>

      <Card
        title="Dependencies / tasks"
        subtitle={`${depItems.length} recorded · ${completedDeps} completed`}
      >
        <DependencyList packageId={pkg.id} dependencies={depItems} canWrite={canWrite} />
      </Card>

      {revisions.length > 0 ? (
        <Card title="Revision history" subtitle="Date, billing and quantity changes">
          <table className="table">
            <thead>
              <tr>
                <th>Changed</th>
                <th>Expected date</th>
                <th>Plan billing [Cr.]</th>
                <th>Planned qty</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {revisions.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap">{new Date(r.changedAt).toISOString().slice(0, 16).replace('T', ' ')}</td>
                  <td>
                    <DateCell value={r.previousExpectedDate} muted /> → <DateCell value={r.newExpectedDate} />
                  </td>
                  <td className="num">
                    {r.previousPlanBillingCr?.toFixed(4) ?? '—'} → {r.newPlanBillingCr?.toFixed(4) ?? '—'}
                  </td>
                  <td className="num">
                    {r.previousPlannedQuantity ?? '—'} → {r.newPlannedQuantity ?? '—'}
                  </td>
                  <td className="text-slate-600">{r.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      <Card title="Audit trail" subtitle="Every change to this package">
        {audit.rows.length === 0 ? (
          <Note>No changes recorded yet. Edits made here will appear immediately.</Note>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Action</th>
                <th>Field</th>
                <th>From</th>
                <th>To</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {audit.rows.map((a) => (
                <tr key={a.id}>
                  <td className="whitespace-nowrap">
                    {new Date(a.timestamp).toISOString().slice(0, 16).replace('T', ' ')}
                  </td>
                  <td>{a.userLabel}</td>
                  <td>{a.action}</td>
                  <td className="text-slate-600">{a.field ?? '—'}</td>
                  <td className="text-slate-600">{a.oldValue ?? '—'}</td>
                  <td className="text-slate-800">{a.newValue ?? '—'}</td>
                  <td className="text-slate-600">{a.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-2 text-[11.5px] text-slate-500">
          The full trail, including dependency changes, is in{' '}
          <Link className="link" href="/audit">
            Audit
          </Link>
          .
        </p>
      </Card>
    </>
  );
}
