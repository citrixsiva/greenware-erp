import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, UserError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime, fmtDec, fmtMoney, fmtPct, isNum } from '../lib/format';
import { usePagedList } from '../lib/hooks';
import type { ApprovalRow } from '../lib/types';
import { FormDialog } from '../components/Dialog';
import { useToast } from '../components/Toast';
import {
  Chip, EmptyState, ErrorState, Kpi, LoadingState, Masked, MoreButton, PageHead, Panel, StatusPill,
} from '../components/ui';

const VIEWS = {
  mine: { label: 'Waiting for me', query: { mine: 'true' } },
  pending: { label: 'All open', query: { status: 'Pending' } },
  all: { label: 'Everything', query: {} },
} as const;
type ViewKey = keyof typeof VIEWS;

const TRIGGER_LABEL: Record<string, string> = {
  LOW_MARGIN: 'Low margin',
  MARGIN_OVERRIDE: 'Margin split exception',
};

type Dlg = null | { kind: 'decide'; row: ApprovalRow; decision: 'Approved' | 'Rejected' };

function DecideDialog({ row, decision, onClose, onDone }: {
  row: ApprovalRow; decision: 'Approved' | 'Rejected'; onClose: () => void; onDone: (msg: string) => void;
}) {
  const [comments, setComments] = useState('');
  const reject = decision === 'Rejected';
  return (
    <FormDialog
      title={`${reject ? 'Reject' : 'Approve'} ${row.quotation_no ?? 'this quotation'} v${row.version_no ?? ''}`}
      submitLabel={reject ? 'Reject' : 'Approve'}
      danger={reject}
      onClose={onClose}
      onSubmit={async () => {
        const text = comments.trim();
        if (reject && text.length < 3) throw new UserError('Say why you are rejecting this quotation.');
        const res = await api.post<{ data: { versionStatus: string | null; approval: { status: string } } }>(
          `/approvals/${row.id}/steps/${row.step_id}/decide`,
          { decision, comments: text || undefined },
        );
        const { versionStatus, approval } = res.data;
        if (reject) {
          onDone(
            row.trigger_code === 'LOW_MARGIN'
              ? `Rejected. Version ${row.version_no} is marked rejected; the owner has to price it again.`
              : 'Rejected. The standard margin split stays in force.',
          );
          return;
        }
        // The chain is only finished when the approval itself turns Approved; until then it moves on.
        onDone(
          approval?.status !== 'Approved'
            ? 'Approved. It now goes to the next approver in the chain.'
            : versionStatus === 'Submitted'
              ? `Approved. Version ${row.version_no} has been submitted and earlier versions are superseded.`
              : row.trigger_code === 'MARGIN_OVERRIDE'
                ? `Approved. The new split now applies to version ${row.version_no}.`
                : 'Approved.',
        );
      }}
    >
      <dl className="dl">
        <div><dt>Reason it came to you</dt><dd>{TRIGGER_LABEL[row.trigger_code] ?? row.trigger_code}</dd></div>
        <div><dt>Customer</dt><dd>{row.customer_name ?? ''}</dd></div>
        <div>
          <dt>Quoted total</dt>
          <dd className="mono">{isNum(row.total_sell) ? fmtMoney(row.total_sell, row.currency ?? 'AED') : <Masked what="The quoted total" />}</dd>
        </div>
        <div>
          <dt>Gross margin</dt>
          <dd className="mono">{isNum(row.gross_margin_pct) ? fmtPct(row.gross_margin_pct, 2) : <Masked what="Margin" />}</dd>
        </div>
        <div><dt>Raised by</dt><dd>{row.requested_by_name}</dd></div>
        <div><dt>Waiting</dt><dd className="mono">{isNum(row.waiting_working_hours) ? `${fmtDec(row.waiting_working_hours, 1)} working hours` : '—'}</dd></div>
      </dl>
      <label className="field">
        <span className="label">Comments{reject ? <span className="req" aria-hidden="true">*</span> : null}</span>
        <textarea
          className="textarea"
          value={comments}
          autoFocus
          onChange={(e) => setComments(e.target.value)}
          placeholder={reject ? 'What has to change before this can go out?' : 'Optional note for the record'}
        />
      </label>
      {row.raised_by_me ? (
        <div className="notice notice--warn" role="status">
          <span className="prewrap">You raised this one. Nobody may approve their own quotation, so approving here only passes it to the next approver.</span>
        </div>
      ) : null}
    </FormDialog>
  );
}

export default function Approvals() {
  const [sp, setSp] = useSearchParams();
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const raw = sp.get('view') ?? 'mine';
  const view: ViewKey = (raw in VIEWS ? raw : 'mine') as ViewKey;
  const [dlg, setDlg] = useState<Dlg>(null);

  const setView = (v: ViewKey) => {
    const next = new URLSearchParams(sp);
    if (v === 'mine') next.delete('view');
    else next.set('view', v);
    setSp(next, { replace: true });
  };

  const list = usePagedList<ApprovalRow>(['approvals', view], '/approvals', VIEWS[view].query);
  const rows = list.rows;
  const waiting = rows.filter((r) => r.status === 'Pending');
  const overdue = waiting.filter((r) => r.overdue);
  const showTotal = rows.some((r) => r.total_sell !== undefined);
  const showGm = rows.some((r) => r.gross_margin_pct !== undefined);

  /** A step is yours to decide only while the approval is open and the chain has reached you. */
  const mine = (r: ApprovalRow) => r.status === 'Pending' && !!r.step_id && r.approver_id === user?.id;

  const reload = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['approvals'] }),
      qc.invalidateQueries({ queryKey: ['quotation'] }),
      qc.invalidateQueries({ queryKey: ['quote-margin'] }),
      qc.invalidateQueries({ queryKey: ['quotations'] }),
    ]);
  };

  return (
    <>
      <PageHead
        title="Approvals"
        sub="Quotations held back by the margin rules. Deciding one releases it, or sends it back to be priced again."
      />

      <div className="kpis">
        <Kpi
          label="Overdue"
          value={<span style={overdue.length ? { color: 'var(--crit-ink)' } : undefined}>{overdue.length}</span>}
          sub={overdue.length ? 'past the escalation window' : 'none past the escalation window'}
        />
        <Kpi label="Open in this view" value={waiting.length} />
        <Kpi
          label="Longest wait"
          value={waiting.length ? `${fmtDec(Math.max(...waiting.map((r) => r.waiting_working_hours ?? 0)), 1)} h` : '0 h'}
          sub="working hours, Dubai calendar"
        />
        <Kpi label="Raised by me" value={rows.filter((r) => r.raised_by_me).length} sub="you cannot decide these" />
      </div>

      <div className="filters">
        <div className="field">
          <span className="label" id="v-l">Show</span>
          <div className="seg" role="group" aria-labelledby="v-l">
            {(Object.keys(VIEWS) as ViewKey[]).map((k) => (
              <button key={k} type="button" aria-pressed={view === k} onClick={() => setView(k)}>{VIEWS[k].label}</button>
            ))}
          </div>
        </div>
      </div>

      <Panel title="Approvals" count={list.isPending ? '' : `${rows.length}${list.hasMore ? '+' : ''}`} flush>
        {list.isPending ? (
          <LoadingState label="Loading approvals" />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={view === 'mine' ? 'Nothing is waiting for you' : view === 'pending' ? 'Nothing is open' : 'No approval has ever been raised'}
            hint={view === 'mine' ? 'When a quotation falls below its margin threshold and the chain reaches you, it appears here.' : undefined}
          />
        ) : (
          <>
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Quotation</th><th>Customer</th><th>Reason</th>
                    {showTotal ? <th className="num">Total</th> : null}
                    {showGm ? <th className="num">GM</th> : null}
                    <th>Raised</th><th className="num">Waiting</th><th>Status</th>
                    <th><span className="sr-only">Decision</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>
                        {r.quotation_id ? (
                          <Link to={`/quotations/${r.quotation_id}${r.version_no ? `?v=${r.version_no}` : ''}`} className="id">{r.quotation_no}</Link>
                        ) : (
                          <span className="id muted">Gone</span>
                        )}
                        <span className="sub">v{r.version_no ?? '?'}{r.version_status ? ` · ${r.version_status}` : ''}</span>
                      </td>
                      <td>{r.customer_name ?? <span className="muted">Unknown</span>}</td>
                      <td>
                        {TRIGGER_LABEL[r.trigger_code] ?? r.trigger_code}
                        {r.step_no ? <span className="sub">step {r.step_no}</span> : null}
                      </td>
                      {showTotal ? <td className="num">{isNum(r.total_sell) ? fmtMoney(r.total_sell, r.currency ?? 'AED') : <Masked what="The quoted total" />}</td> : null}
                      {showGm ? <td className="num">{isNum(r.gross_margin_pct) ? fmtPct(r.gross_margin_pct, 2) : <Masked what="Margin" />}</td> : null}
                      <td className="nowrap">
                        {fmtDateTime(r.requested_at)}
                        <span className="sub">{r.raised_by_me ? 'by you' : `by ${r.requested_by_name}`}</span>
                      </td>
                      <td className="num">
                        {isNum(r.waiting_working_hours) ? (
                          r.overdue
                            ? <Chip tone="crit" mono title={isNum(r.escalate_after_hours) ? `Escalates after ${fmtDec(r.escalate_after_hours, 0)} working hours` : undefined}>{fmtDec(r.waiting_working_hours, 1)} h</Chip>
                            : <span className="mono">{fmtDec(r.waiting_working_hours, 1)} h</span>
                        ) : (
                          <span className="muted">Closed</span>
                        )}
                      </td>
                      <td><StatusPill value={r.status} /></td>
                      <td className="nowrap">
                        {mine(r) ? (
                          <span className="row row--tight">
                            <button type="button" className="btn btn--sm btn--primary" onClick={() => setDlg({ kind: 'decide', row: r, decision: 'Approved' })}>Approve</button>
                            <button type="button" className="btn btn--sm btn--danger" onClick={() => setDlg({ kind: 'decide', row: r, decision: 'Rejected' })}>Reject</button>
                          </span>
                        ) : r.status === 'Pending' ? (
                          <span className="muted">{r.raised_by_me ? 'Yours — someone else decides' : 'With another approver'}</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <MoreButton cursor={list.hasMore ? 'y' : null} loading={list.isFetchingNextPage} onMore={list.more} />
          </>
        )}
      </Panel>

      {dlg?.kind === 'decide' ? (
        <DecideDialog
          row={dlg.row}
          decision={dlg.decision}
          onClose={() => setDlg(null)}
          onDone={(msg) => { toast.push(dlg.decision === 'Rejected' ? 'warn' : 'ok', msg); void reload(); }}
        />
      ) : null}
    </>
  );
}
