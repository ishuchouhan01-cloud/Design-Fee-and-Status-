import clsx from 'clsx';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { SCHEDULE_STATUS_LABEL, type Rag, type ScheduleStatus } from '@/lib/domain';
import { formatDate } from '@/lib/periods';
import { RAG_LABEL } from '@/lib/labels';

export function Card({
  title,
  subtitle,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={clsx('card', className)}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            <h2 className="card-title">{title}</h2>
            {subtitle && <p className="mt-0.5 text-2xs text-ink-mute">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={bodyClassName ?? 'card-pad'}>{children}</div>
    </section>
  );
}

export function Kpi({
  label,
  value,
  hint,
  tone,
  suffix,
}: {
  label: string;
  value: string | number;
  hint?: ReactNode;
  tone?: 'default' | 'good' | 'warn' | 'bad';
  suffix?: string;
}) {
  const toneClass =
    tone === 'good'
      ? 'text-rag-green'
      : tone === 'warn'
        ? 'text-rag-amber'
        : tone === 'bad'
          ? 'text-rag-red'
          : 'text-ink';
  return (
    <div className="card card-pad">
      <p className="kpi-label">{label}</p>
      <p className={clsx('kpi-value mt-2', toneClass)}>
        {value}
        {suffix && <span className="ml-0.5 text-[13px] font-medium text-ink-mute">{suffix}</span>}
      </p>
      {hint && <p className="mt-1.5 text-2xs leading-snug text-ink-mute">{hint}</p>}
    </div>
  );
}

const RAG_CLASS: Record<Rag, string> = {
  GREEN: 'bg-emerald-50 text-rag-green ring-1 ring-emerald-200',
  AMBER: 'bg-amber-50 text-rag-amber ring-1 ring-amber-200',
  RED: 'bg-red-50 text-rag-red ring-1 ring-red-200',
  GREY: 'bg-slate-100 text-rag-grey ring-1 ring-slate-200',
};

export function RagBadge({ rag, title, overridden }: { rag: Rag; title?: string; overridden?: boolean }) {
  return (
    <span className={clsx('pill', RAG_CLASS[rag])} title={title}>
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
      {RAG_LABEL[rag] ?? rag}
      {overridden && <span className="font-normal opacity-70">· override</span>}
    </span>
  );
}

const SCHEDULE_CLASS: Record<ScheduleStatus, string> = {
  ON_TRACK: 'bg-emerald-50 text-rag-green ring-1 ring-emerald-200',
  DUE_SOON: 'bg-amber-50 text-rag-amber ring-1 ring-amber-200',
  RESCHEDULED: 'bg-violet-50 text-violet-700 ring-1 ring-violet-200',
  DELAYED: 'bg-red-50 text-rag-red ring-1 ring-red-200',
  COMPLETED_ON_TIME: 'bg-slate-100 text-slate-700 ring-1 ring-slate-200',
  COMPLETED_LATE: 'bg-orange-50 text-orange-700 ring-1 ring-orange-200',
  NOT_SCHEDULED: 'bg-slate-50 text-slate-500 ring-1 ring-slate-200',
};

export function ScheduleBadge({ status, days }: { status: ScheduleStatus; days?: number | null }) {
  return (
    <span className={clsx('pill', SCHEDULE_CLASS[status])}>
      {SCHEDULE_STATUS_LABEL[status]}
      {days != null && days !== 0 && (
        <span className="font-normal opacity-80">
          {days > 0 ? `+${days}d` : `${days}d`}
        </span>
      )}
    </span>
  );
}

/**
 * Completion is binary everywhere in this application. This component is the
 * only way it is ever rendered, which is part of how the rule stays true.
 */
export function CompletionBadge({ status }: { status: string }) {
  const done = status === 'COMPLETED';
  return (
    <span
      className={clsx(
        'pill',
        done ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-700',
      )}
    >
      {done ? 'Complete' : 'Pending'}
    </span>
  );
}

export function DateCell({ value, muted }: { value: Date | null | undefined; muted?: boolean }) {
  return (
    <span className={clsx('whitespace-nowrap font-mono text-[11.5px] tabular-nums', muted ? 'text-ink-mute' : 'text-ink-soft')}>
      {formatDate(value)}
    </span>
  );
}

export function Pct({ value }: { value: number }) {
  const tone = value >= 85 ? 'text-rag-green' : value >= 60 ? 'text-ink' : value >= 30 ? 'text-rag-amber' : 'text-rag-red';
  return <span className={clsx('font-mono tabular-nums font-semibold', tone)}>{value.toFixed(1)}%</span>;
}

export function Bar({ value, total }: { value: number; total: number }) {
  const p = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200" title={`${value} of ${total}`}>
      <div
        className={clsx('h-full rounded-full', p >= 85 ? 'bg-rag-green' : p >= 40 ? 'bg-brand-500' : 'bg-rag-amber')}
        style={{ width: `${p}%` }}
      />
    </div>
  );
}

export function Delta({ value, suffix = '' }: { value: number; suffix?: string }) {
  if (value === 0) return <span className="font-mono text-ink-mute">0{suffix}</span>;
  const good = value > 0;
  return (
    <span className={clsx('font-mono font-semibold tabular-nums', good ? 'text-rag-green' : 'text-rag-red')}>
      {value > 0 ? '+' : ''}
      {value}
      {suffix}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-1 py-6 text-center text-[12px] text-ink-mute">{children}</p>;
}

export function TableWrap({ children, maxHeight }: { children: ReactNode; maxHeight?: string }) {
  return (
    <div className="overflow-auto" style={maxHeight ? { maxHeight } : undefined}>
      {children}
    </div>
  );
}

export function Crumbs({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav className="flex flex-wrap items-center gap-1 text-2xs text-ink-mute">
      {items.map((it, i) => (
        <span key={`${it.label}-${i}`} className="flex items-center gap-1">
          {i > 0 && <span className="text-slate-300">/</span>}
          {it.href ? (
            <Link href={it.href} className="link">
              {it.label}
            </Link>
          ) : (
            <span className="text-ink-soft">{it.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  crumbs,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  crumbs?: { label: string; href?: string }[];
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        {crumbs && <Crumbs items={crumbs} />}
        <h1 className="mt-1 text-[19px] font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-[12.5px] leading-relaxed text-ink-mute">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Note({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' }) {
  return (
    <p
      className={clsx(
        'rounded border px-3 py-2 text-[12px] leading-relaxed',
        tone === 'warn'
          ? 'border-amber-200 bg-amber-50 text-amber-900'
          : 'border-brand-100 bg-brand-50 text-brand-700',
      )}
    >
      {children}
    </p>
  );
}

/**
 * Drawing release status: the stored binary completion value shown in drawing
 * words. RELEASED / NOT RELEASED — nothing in between.
 */
export function ReleaseBadge({ status }: { status: string }) {
  const done = status === 'COMPLETED';
  return (
    <span
      className={clsx(
        'pill whitespace-nowrap font-semibold tracking-wide',
        done ? 'bg-emerald-600 text-white' : 'bg-amber-100 text-amber-900 ring-1 ring-amber-300',
      )}
    >
      {done ? 'Released' : 'Not Released'}
    </span>
  );
}

/** A drawing number, or "Not yet numbered" (with any partial sheet number). */
export function DrawingNumber({
  code,
  numberStatus,
  partialNumber,
}: {
  code: string;
  numberStatus: string;
  partialNumber?: string | null;
}) {
  if (numberStatus === 'NOT_YET_NUMBERED') {
    return (
      <span className="whitespace-nowrap">
        <span className="pill bg-slate-100 text-slate-600 ring-1 ring-dashed ring-slate-300">Not yet numbered</span>
        {partialNumber && <span className="sub ml-1">sheet {partialNumber}</span>}
      </span>
    );
  }
  return <span className="whitespace-nowrap font-mono text-[11.5px] font-medium">{code}</span>;
}

/** Actual release date; a released drawing without one shows "—" (its evidence is in the drawing detail). */
export function ActualRelease({
  status,
  value,
  evidence,
}: {
  status: string;
  value: Date | null | undefined;
  evidence?: string | null;
}) {
  void status;
  void evidence;
  return <DateCell value={value ?? null} />;
}
