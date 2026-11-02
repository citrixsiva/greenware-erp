import { useId, type ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { errorMessage } from '../lib/api';
import { fmtDec, humanize, isNum } from '../lib/format';
import type { SlaClock, SlaState } from '../lib/types';
import { Icon } from './Icon';

/* ---------- state pills ---------- */

export function SlaPill({ state, clock, elapsed, target }: { state: SlaState; clock: SlaClock; elapsed: number; target: number | null }) {
  // Paused wins: while the clock is stopped for an RFQ or a clarification, the state is not "running late".
  const paused = clock === 'paused';
  const tone = paused ? 'idle' : state === 'Breached' ? 'crit' : state === 'Approaching' ? 'warn' : 'ok';
  const label = paused ? 'Paused' : state;
  const detail = isNum(target) ? `${fmtDec(elapsed, 1)}/${fmtDec(target, 0)} h` : `${fmtDec(elapsed, 1)} h`;
  return (
    <span
      className={`pill pill--${tone}`}
      title={`${label}. ${fmtDec(elapsed, 2)} working hours elapsed${isNum(target) ? ` of ${fmtDec(target, 0)} allowed` : ''}${clock === 'stopped' ? ' (clock stopped: answered)' : ''}`}
    >
      {label} <span className="mono">{detail}</span>
    </span>
  );
}

const STATUS_TONE: Record<string, string> = {
  Responded: 'ok', Submitted: 'ok', Approved: 'ok', Won: 'ok', Live: 'ok',
  Breached: 'crit', Rejected: 'crit', Lost: 'crit',
  PendingApproval: 'warn', ClarificationNeeded: 'warn', Pending: 'warn', Escalated: 'warn',
  AwaitingSupplier: 'info', InReview: 'info', Sourcing: 'info', Assigned: 'info', Working: 'info', Qualifying: 'info',
};
export function StatusPill({ value }: { value: string }) {
  const tone = STATUS_TONE[value] ?? 'idle';
  return <span className={`pill pill--${tone}`}>{humanize(value)}</span>;
}

export function Chip({ children, tone, mono, title }: { children: ReactNode; tone?: 'crit' | 'warn' | 'ok' | 'accent'; mono?: boolean; title?: string }) {
  return (
    <span className={`chip${tone ? ` chip--${tone}` : ''}${mono ? ' chip--mono' : ''}`} title={title}>
      {children}
    </span>
  );
}

export const UrgencyChip = ({ urgency }: { urgency: string }) =>
  urgency === 'Urgent' ? <Chip tone="crit">Urgent</Chip> : <span className="muted">Normal</span>;

/* ---------- layout ---------- */

export function PageHead({ title, sub, crumbs, actions }: { title: ReactNode; sub?: ReactNode; crumbs?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="stack" style={{ gap: 4 }}>
      {crumbs ? <div className="crumbs">{crumbs}</div> : null}
      <div className="page__head">
        <div className="grow">
          <h1>{title}</h1>
          {sub ? <div className="sub">{sub}</div> : null}
        </div>
        {actions ? <div className="page__actions">{actions}</div> : null}
      </div>
    </div>
  );
}

export function Panel({ title, count, actions, children, flush, id }: { title?: ReactNode; count?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; id?: string }) {
  return (
    <section className="panel" aria-labelledby={id}>
      {title ? (
        <div className="panel__head">
          <h2 id={id}>{title}</h2>
          {count !== undefined ? <span className="count">{count}</span> : null}
          {actions ? <div className="right row">{actions}</div> : null}
        </div>
      ) : null}
      <div className={flush ? 'panel__body--flush' : 'panel__body'}>{children}</div>
    </section>
  );
}

export function Kpi({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="kpi">
      <div className="k">{label}</div>
      <div className="v">{value}</div>
      {sub ? <div className="s">{sub}</div> : null}
    </div>
  );
}

export function Notice({ tone, children, title }: { tone: 'ok' | 'warn' | 'crit' | 'info'; children: ReactNode; title?: string }) {
  return (
    <div className={`notice notice--${tone}`} role={tone === 'crit' ? 'alert' : 'status'}>
      <div className="grow">
        {title ? <b>{title} </b> : null}
        <span className="prewrap">{children}</span>
      </div>
    </div>
  );
}

/* ---------- data states ---------- */

export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="skel" role="status" aria-label={`${label}…`}>
      <i /><i /><i />
      <span className="sr-only">{label}…</span>
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state">
      <b>{title}</b>
      {hint ? <span>{hint}</span> : null}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="state state--error" role="alert">
      <b>Could not load this</b>
      <span className="prewrap">{errorMessage(error)}</span>
      {onRetry ? <button type="button" className="btn btn--sm" onClick={onRetry}>Try again</button> : null}
    </div>
  );
}

/** Loading, error and empty are never skipped: every list goes through here. */
export function DataView<T>({
  query, isEmpty, empty, children, label,
}: {
  query: UseQueryResult<T>;
  isEmpty?: (d: T) => boolean;
  empty?: ReactNode;
  label?: string;
  children: (d: T) => ReactNode;
}) {
  if (query.isPending) return <LoadingState label={label} />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const d = query.data as T;
  if (isEmpty?.(d)) return <>{empty ?? <EmptyState title="Nothing here yet" />}</>;
  return <>{children(d)}</>;
}

/* ---------- forms ---------- */

export function Field({
  label, hint, error, required, children, className,
}: {
  label: ReactNode; hint?: ReactNode; error?: string | null; required?: boolean; className?: string;
  children: (p: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean; 'aria-required'?: boolean }) => ReactNode;
}) {
  const id = useId();
  const hid = `${id}-h`;
  const eid = `${id}-e`;
  const described = [hint ? hid : '', error ? eid : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`field${className ? ` ${className}` : ''}`}>
      <label className="label" htmlFor={id}>
        {label}
        {required ? <span className="req" aria-hidden="true">*</span> : null}
      </label>
      {children({ id, 'aria-describedby': described, 'aria-invalid': error ? true : undefined, 'aria-required': required || undefined })}
      {hint ? <span className="hint" id={hid}>{hint}</span> : null}
      {error ? <span className="err" id={eid}>{error}</span> : null}
    </div>
  );
}

export const Count = ({ n }: { n: number }) => <span className="mono">{n}</span>;

/**
 * Stands in for a value the server did not send because the caller's role may not see it.
 * A masked field is absent from the payload, so the cell must say so rather than look like zero.
 */
export function Masked({ what }: { what?: string }) {
  const title = what ? `${what} is not visible to your role.` : 'This value is not visible to your role.';
  return <span className="muted" title={title} aria-label={title}>—</span>;
}

export function MoreButton({ cursor, loading, onMore }: { cursor: string | null | undefined; loading?: boolean; onMore: () => void }) {
  if (!cursor) return null;
  return (
    <div className="row" style={{ justifyContent: 'center', padding: 'var(--s3)' }}>
      <button type="button" className="btn" onClick={onMore} disabled={loading}>{loading ? 'Loading…' : 'Load more'}</button>
    </div>
  );
}

export const PlusIcon = () => <Icon name="plus" size={14} />;
