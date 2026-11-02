import { Link, useSearchParams } from 'react-router-dom';
import { fmtDate } from '../lib/format';
import { useBootstrap, usePagedList } from '../lib/hooks';
import type { EstRequest } from '../lib/types';
import { SlaKpis } from '../components/Queue';
import { Chip, EmptyState, ErrorState, LoadingState, MoreButton, PageHead, Panel, SlaPill, StatusPill, UrgencyChip } from '../components/ui';

const ALL = 'Raised,Assigned,InReview,ClarificationNeeded,Submitted,Cancelled';
const VIEWS: Record<string, { label: string; status?: string }> = {
  open: { label: 'Open' },
  done: { label: 'Submitted', status: 'Submitted' },
  all: { label: 'All', status: ALL },
};

export default function Estimation() {
  const [sp, setSp] = useSearchParams();
  const boot = useBootstrap();
  const view = VIEWS[sp.get('view') ?? 'open'] ? (sp.get('view') ?? 'open') : 'open';
  const urgency = sp.get('urgency') ?? '';
  const sla = sp.get('sla') ?? '';
  const sbu = sp.get('sbu') ?? '';
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    setSp(n, { replace: true });
  };
  const list = usePagedList<EstRequest>(['est'], '/estimation/requests', {
    status: VIEWS[view].status,
    urgency: urgency || undefined,
    slaState: sla || undefined,
    sbuId: sbu || undefined,
  });

  return (
    <>
      <PageHead title="Estimation queue" sub="Most urgent first. The clock pauses while a question is open with Sales." />
      <SlaKpis path="/estimation/sla" label="Estimation" />
      <div className="filters">
        <div className="field">
          <span className="label" id="v-l">Show</span>
          <div className="seg" role="group" aria-labelledby="v-l">
            {Object.entries(VIEWS).map(([k, v]) => (
              <button key={k} type="button" aria-pressed={view === k} onClick={() => set('view', k === 'open' ? '' : k)}>{v.label}</button>
            ))}
          </div>
        </div>
        <label className="field">
          <span className="label">SBU</span>
          <select className="select" value={sbu} onChange={(e) => set('sbu', e.target.value)}>
            <option value="">All SBUs</option>
            {boot.data?.sbus.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="label">Urgency</span>
          <select className="select" value={urgency} onChange={(e) => set('urgency', e.target.value)}>
            <option value="">Any</option><option>Urgent</option><option>Normal</option>
          </select>
        </label>
        <label className="field">
          <span className="label">SLA state</span>
          <select className="select" value={sla} onChange={(e) => set('sla', e.target.value)}>
            <option value="">Any</option><option>Breached</option><option>Approaching</option><option>Within</option>
          </select>
        </label>
      </div>

      <Panel title="Requests" count={list.isPending ? '' : `${list.rows.length}${list.hasMore ? '+' : ''}`} flush>
        {list.isPending ? <LoadingState /> : list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : list.rows.length === 0 ? (
          <EmptyState title="Nothing in this queue" hint={view === 'open' && !urgency && !sla && !sbu ? 'No estimation is waiting on an engineer.' : 'No request matches these filters.'} />
        ) : (
          <>
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr><th>SLA</th><th>Request</th><th>Enquiry</th><th>SBU</th><th>Status</th><th>Urgency</th><th>Engineer</th><th>Needed by</th><th className="num">Rounds</th></tr>
                </thead>
                <tbody>
                  {list.rows.map((r) => (
                    <tr key={r.id}>
                      <td><SlaPill state={r.sla_state} clock={r.sla_clock} elapsed={r.elapsed_working_hours} target={r.target_hours} /></td>
                      <td><Link to={`/estimation/${r.id}`} className="id">{r.request_no}</Link></td>
                      <td className="wrap"><Link to={`/enquiries/${r.enquiry_id}`}><span className="id">{r.enquiry_no}</span></Link><span className="sub">{r.customer_name} · {r.enquiry_title}</span></td>
                      <td><Chip mono>{r.sbu_code}</Chip></td>
                      <td><StatusPill value={r.status} /></td>
                      <td><UrgencyChip urgency={r.urgency} /></td>
                      <td>{r.assigned_to_name ?? <span className="muted">Unassigned</span>}</td>
                      <td className="nowrap">{r.required_by ? fmtDate(r.required_by) : <span className="muted">Not set</span>}</td>
                      <td className="num">{r.clarification_rounds}</td>
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
