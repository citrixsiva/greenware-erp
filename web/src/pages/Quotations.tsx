import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { fmtDate, fmtMoney, fmtPct, isNum } from '../lib/format';
import { usePagedList } from '../lib/hooks';
import type { QuotationListRow } from '../lib/types';
import { EmptyState, ErrorState, LoadingState, MoreButton, PageHead, Panel, StatusPill } from '../components/ui';

const STATUSES = ['Draft', 'PendingApproval', 'Approved', 'Submitted', 'Superseded', 'Rejected'];

export default function Quotations() {
  const [sp, setSp] = useSearchParams();
  const q = sp.get('q') ?? '';
  const status = sp.get('status') ?? '';
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    setSp(n, { replace: true });
  };
  const list = usePagedList<QuotationListRow>(['quotations'], '/quotations', { q: q || undefined, status: status || undefined });
  const showTotal = list.rows.some((r) => r.total_sell !== undefined);
  const showGm = list.rows.some((r) => r.gross_margin_pct !== undefined);

  return (
    <>
      <PageHead title="Quotations" sub="Each quotation keeps every version it ever had. Open one to edit the draft or review history." />
      <form className="filters" onSubmit={(e) => { e.preventDefault(); set('q', text.trim()); }}>
        <label className="field" style={{ minWidth: 260 }}>
          <span className="label">Search</span>
          <input className="input" type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Quotation, enquiry or customer" />
        </label>
        <label className="field">
          <span className="label">Current version status</span>
          <select className="select" value={status} onChange={(e) => set('status', e.target.value)}>
            <option value="">Any</option>
            {STATUSES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <button type="submit" className="btn">Search</button>
      </form>
      <Panel title="Quotations" count={list.isPending ? '' : `${list.rows.length}${list.hasMore ? '+' : ''}`} flush>
        {list.isPending ? <LoadingState /> : list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : list.rows.length === 0 ? (
          <EmptyState title={q || status ? 'No quotation matches' : 'No quotations yet'} hint={q || status ? 'Clear the search or the status filter.' : 'Build one from an enquiry.'} />
        ) : (
          <>
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr><th>Quotation</th><th>Customer</th><th>Enquiry</th><th>Version</th><th>Status</th>{showTotal ? <th className="num">Total</th> : null}{showGm ? <th className="num">GM</th> : null}<th>Valid until</th><th>Owner</th></tr>
                </thead>
                <tbody>
                  {list.rows.map((r) => (
                    <tr key={r.id}>
                      <td><Link to={`/quotations/${r.id}`} className="id">{r.quotation_no}</Link></td>
                      <td>{r.customer_name}</td>
                      <td><Link to={`/enquiries/${r.enquiry_id}`} className="id">{r.enquiry_no}</Link></td>
                      <td className="mono">{r.version_no ? `v${r.version_no}` : ''}</td>
                      <td>{r.status ? <StatusPill value={r.status} /> : null}</td>
                      {showTotal ? <td className="num">{isNum(r.total_sell) ? fmtMoney(r.total_sell, r.currency) : null}</td> : null}
                      {showGm ? <td className="num">{isNum(r.gross_margin_pct) ? fmtPct(r.gross_margin_pct) : null}</td> : null}
                      <td className="nowrap">{fmtDate(r.valid_until)}</td>
                      <td>{r.owner_name}</td>
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
