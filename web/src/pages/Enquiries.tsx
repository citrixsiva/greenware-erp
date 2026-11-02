import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { fmtDate, fmtMoney, fmtPct, isNum } from '../lib/format';
import { usePagedList } from '../lib/hooks';
import { STAGES, type EnquiryRow } from '../lib/types';
import { Chip, EmptyState, ErrorState, LoadingState, MoreButton, PageHead, Panel, StatusPill } from '../components/ui';

export default function Enquiries() {
  const [sp, setSp] = useSearchParams();
  const q = sp.get('q') ?? '';
  const stage = sp.get('stage') ?? '';
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);

  const list = usePagedList<EnquiryRow>(['enquiries'], '/enquiries', { q: q || undefined, stage: stage || undefined });
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    setSp(n, { replace: true });
  };
  // A margin column exists only if the server sent margin for at least one row.
  const showGm = list.rows.some((r) => r.gross_margin_pct !== undefined);

  return (
    <>
      <PageHead title="Enquiries" sub="Newest first. Open one to see its whole chain: procurement, estimation, quotations, follow-ups." />
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          set('q', text.trim());
        }}
      >
        <label className="field" style={{ minWidth: 260 }}>
          <span className="label">Search</span>
          <input className="input" type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Number, title or customer" />
        </label>
        <label className="field">
          <span className="label">Stage</span>
          <select className="select" value={stage} onChange={(e) => set('stage', e.target.value)}>
            <option value="">All stages</option>
            {STAGES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <button type="submit" className="btn">Search</button>
      </form>

      <Panel title="Enquiries" count={list.isPending ? '' : `${list.rows.length}${list.hasMore ? '+' : ''}`} flush>
        {list.isPending ? <LoadingState /> : list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : list.rows.length === 0 ? (
          <EmptyState title={q || stage ? 'No enquiries match' : 'No enquiries yet'} hint={q || stage ? 'Clear the search or the stage filter.' : 'Enquiries you can see will appear here.'} />
        ) : (
          <>
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Enquiry</th><th>Customer</th><th>Stage</th><th className="num">Value</th>
                    {showGm ? <th className="num">GM</th> : null}
                    <th>SBU</th><th>Owner</th><th className="num">Days in stage</th><th>Next follow-up</th>
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="wrap"><Link to={`/enquiries/${r.id}`}><span className="id">{r.enquiry_no}</span></Link><span className="sub">{r.title}</span></td>
                      <td>{r.customer_name}</td>
                      <td><StatusPill value={r.stage} /></td>
                      <td className="num">{isNum(r.approx_budget) ? fmtMoney(r.approx_budget, r.budget_currency ?? 'AED', true) : <span className="muted">No budget</span>}</td>
                      {showGm ? <td className="num">{isNum(r.gross_margin_pct) ? fmtPct(r.gross_margin_pct) : null}</td> : null}
                      <td>{r.primary_sbu_code ? <Chip mono>{r.primary_sbu_code}</Chip> : null}</td>
                      <td>{r.account_manager_name}</td>
                      <td className="num">{r.days_in_stage}</td>
                      <td className="nowrap">
                        {r.next_follow_up ? fmtDate(r.next_follow_up) : <span className="muted">None set</span>}
                        {r.follow_up_overdue ? <> <Chip tone="crit">Overdue</Chip></> : null}
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
    </>
  );
}
