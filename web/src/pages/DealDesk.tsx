import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fmtCompact, fmtDec, fmtMoney, fmtPct } from '../lib/format';
import { usePagedList, useEmployees } from '../lib/hooks';
import type { CampaignRow, DealDeskSummary, LeadRow } from '../lib/types';
import {
  Chip, EmptyState, ErrorState, Kpi, LoadingState, MoreButton, PageHead, Panel, StatusPill,
} from '../components/ui';

/** The inbox is the three workable states; Qualified and Disqualified are history. */
const VIEWS: Record<string, { label: string; status?: string }> = {
  inbox: { label: 'Inbox' },
  new: { label: 'Untouched', status: 'New' },
  working: { label: 'Working', status: 'Working' },
  nurturing: { label: 'Nurturing', status: 'Nurturing' },
};

/** Score bands. A lead is not "hot" because it is new — it is hot because it fits and engaged. */
function ScoreChip({ score }: { score: number }) {
  const tone = score >= 60 ? 'ok' : score >= 30 ? 'warn' : undefined;
  return <Chip tone={tone} mono title={`Lead score ${score} of 100`}>{score}</Chip>;
}

function AgeCell({ days, status }: { days: number; status: string }) {
  // Untouched and ageing is the one number a Deal Desk should never have to hunt for.
  const bad = status === 'New' && days >= 3;
  return bad
    ? <Chip tone="crit" mono title="Untouched for three days or more">{days}d</Chip>
    : <span className="mono">{days}d</span>;
}

export default function DealDesk() {
  const [sp, setSp] = useSearchParams();
  const view = VIEWS[sp.get('view') ?? 'inbox'] ? (sp.get('view') ?? 'inbox') : 'inbox';
  const ownerId = sp.get('owner') ?? '';
  const campaignId = sp.get('campaign') ?? '';
  const search = sp.get('q') ?? '';

  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    setSp(n, { replace: true });
  };

  const employees = useEmployees();
  const campaigns = useQuery({
    queryKey: ['campaigns', 'active'],
    queryFn: () => api.get<{ data: CampaignRow[] }>('/campaigns', { active: true }),
  });
  const summary = useQuery({
    queryKey: ['dealdesk', 'summary', ownerId, campaignId],
    queryFn: () => api.get<{ data: DealDeskSummary }>('/dealdesk/summary', {
      ownerId: ownerId || undefined,
      campaignId: campaignId || undefined,
    }),
  });

  const list = usePagedList<LeadRow>(['leads', view], '/leads', {
    status: VIEWS[view].status,
    ownerId: ownerId || undefined,
    campaignId: campaignId || undefined,
    q: search || undefined,
  });

  const s = summary.data?.data;

  return (
    <>
      <PageHead
        title="Deal Desk"
        sub="Leads score themselves on fit and behaviour. Work the top of the list, and qualifying hands the lead straight to sales as an enquiry."
      />

      <div className="kpis">
        <Kpi label="Open leads" value={s ? fmtCompact(s.open_leads) : '—'} sub={s ? `${fmtMoney(s.open_value, 'AED', true)} estimated` : undefined} />
        <Kpi label="Untouched" value={s ? fmtCompact(s.untouched) : '—'} sub={s && s.stale > 0 ? `${s.stale} over 3 days old` : 'All picked up'} />
        <Kpi label="Average score" value={s?.avg_score != null ? fmtDec(s.avg_score, 1) : '—'} sub="of 100" />
        <Kpi
          label="Conversion"
          value={s?.conversion_pct != null ? fmtPct(s.conversion_pct) : '—'}
          sub={s ? `${s.qualified} qualified · ${s.disqualified} disqualified` : undefined}
        />
      </div>

      <div className="filters">
        <div className="field">
          <span className="label" id="dd-v">Show</span>
          <div className="seg" role="group" aria-labelledby="dd-v">
            {Object.entries(VIEWS).map(([k, v]) => (
              <button key={k} type="button" aria-pressed={view === k} onClick={() => set('view', k === 'inbox' ? '' : k)}>
                {v.label}
              </button>
            ))}
          </div>
        </div>
        <label className="field">
          <span className="label">Owner</span>
          <select className="select" value={ownerId} onChange={(e) => set('owner', e.target.value)}>
            <option value="">Anyone</option>
            {(employees.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="label">Campaign</span>
          <select className="select" value={campaignId} onChange={(e) => set('campaign', e.target.value)}>
            <option value="">All campaigns</option>
            {(campaigns.data?.data ?? []).map((c) => (
              <option key={c.campaign_id} value={c.campaign_id}>{c.campaign_code} · {c.name}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="label">Search</span>
          <input
            className="input"
            type="search"
            placeholder="Company, contact, email or lead no."
            defaultValue={search}
            onChange={(e) => set('q', e.target.value.trim())}
          />
        </label>
      </div>

      <Panel title="Leads" count={list.isPending ? '' : `${list.rows.length}${list.hasMore ? '+' : ''}`} flush>
        {list.isPending ? <LoadingState label="Loading leads" />
          : list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          : list.rows.length === 0 ? (
            <EmptyState
              title="No leads here"
              hint={view === 'inbox' && !ownerId && !campaignId && !search
                ? 'The inbox is clear. New leads arrive from campaigns, web forms and event scans.'
                : 'No lead matches these filters.'}
            />
          ) : (
            <>
              <div className="table-wrap">
                <table className="t">
                  <thead>
                    <tr>
                      <th className="num">Score</th><th>Lead</th><th>Company</th><th>Contact</th>
                      <th>Campaign</th><th>Technology</th><th>Owner</th>
                      <th className="num">Value</th><th>Status</th><th className="num">Age</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.rows.map((l) => (
                      <tr key={l.id}>
                        <td className="num"><ScoreChip score={l.score} /></td>
                        <td><Link to={`/deal-desk/${l.id}`} className="id">{l.lead_no}</Link></td>
                        <td className="wrap">
                          {l.company_name}
                          {l.customer_id ? <span className="sub">Existing customer</span> : null}
                        </td>
                        <td className="wrap">
                          {l.contact_name ?? <span className="muted">No contact</span>}
                          {l.designation ? <span className="sub">{l.designation}</span> : null}
                        </td>
                        <td className="wrap">{l.campaign_code ? <>{l.campaign_code}<span className="sub">{l.campaign_name}</span></> : <span className="muted">Direct</span>}</td>
                        <td>{l.technology_name ?? <span className="muted">Unmatched</span>}</td>
                        <td>{l.owner_name ?? <span className="muted">Unassigned</span>}</td>
                        <td className="num">{l.estimated_value != null ? fmtMoney(l.estimated_value, l.currency, true) : <span className="muted">—</span>}</td>
                        <td><StatusPill value={l.status} /></td>
                        <td className="num"><AgeCell days={l.age_days} status={l.status} /></td>
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
