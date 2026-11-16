import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fmtDate, fmtDec, fmtInt, fmtMoney } from '../lib/format';
import type { CampaignRow } from '../lib/types';
import { Chip, DataView, EmptyState, Kpi, PageHead, Panel } from '../components/ui';

/**
 * Campaign attribution — spend against what it actually produced, read from
 * v_campaign_attribution. The chain is campaign -> lead -> enquiry -> customer
 * PO, so "won value" is money on a purchase order, not a forecast.
 */
export default function Campaigns() {
  const query = useQuery({
    queryKey: ['campaigns', 'all'],
    queryFn: () => api.get<{ data: CampaignRow[] }>('/campaigns'),
    select: (r) => r.data,
  });

  return (
    <DataView
      query={query}
      label="Loading campaigns"
      isEmpty={(d) => d.length === 0}
      empty={<EmptyState title="No campaigns yet" hint="A campaign groups the leads it produced, so its spend can be measured against the business it won." />}
    >
      {(rows) => {
        const spend = rows.reduce((a, c) => a + Number(c.spend ?? 0), 0);
        const won = rows.reduce((a, c) => a + Number(c.won_value ?? 0), 0);
        const leads = rows.reduce((a, c) => a + c.leads, 0);
        const qualified = rows.reduce((a, c) => a + c.qualified, 0);

        return (
          <>
            <PageHead
              title="Campaigns"
              sub="What each campaign cost, and what it returned once its leads reached a purchase order."
            />

            <div className="kpis">
              <Kpi label="Total spend" value={fmtMoney(spend, 'AED', true)} sub={`${rows.length} campaigns`} />
              <Kpi label="Won value" value={fmtMoney(won, 'AED', true)} sub="on customer POs" />
              <Kpi
                label="Return"
                value={spend > 0 ? `${fmtDec(won / spend, 1)}×` : '—'}
                sub={spend > 0 ? 'won value per AED spent' : 'no spend recorded'}
              />
              <Kpi
                label="Leads"
                value={fmtInt(leads)}
                sub={`${fmtInt(qualified)} qualified${leads > 0 ? ` · ${fmtDec((qualified / leads) * 100, 0)}%` : ''}`}
              />
            </div>

            <Panel title="By campaign" count={rows.length} flush>
              <div className="table-wrap">
                <table className="t">
                  <thead>
                    <tr>
                      <th>Campaign</th><th>Channel</th><th>Runs</th>
                      <th className="num">Spend</th><th className="num">Leads</th><th className="num">Qualified</th>
                      <th className="num">Enquiries</th><th className="num">Won</th>
                      <th className="num">Cost / qualified</th><th className="num">Return</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((c) => (
                      <tr key={c.campaign_id}>
                        <td className="wrap">
                          <Link to={`/deal-desk?campaign=${c.campaign_id}`} className="id">{c.campaign_code}</Link>
                          <span className="sub">{c.name}{c.owner_name ? ` · ${c.owner_name}` : ''}</span>
                        </td>
                        <td>{c.channel}</td>
                        <td className="nowrap">
                          {fmtDate(c.start_date)}
                          {c.end_date ? ` – ${fmtDate(c.end_date)}` : ''}
                          {!c.is_active ? <span className="sub">Closed</span> : null}
                        </td>
                        <td className="num">{fmtMoney(c.spend, c.currency ?? 'AED', true)}</td>
                        <td className="num">{fmtInt(c.leads)}</td>
                        <td className="num">{fmtInt(c.qualified)}</td>
                        <td className="num">{fmtInt(c.enquiries)}</td>
                        <td className="num">
                          {c.won_count > 0
                            ? <>{fmtMoney(c.won_value, 'AED', true)}<span className="sub">{c.won_count} deal{c.won_count === 1 ? '' : 's'}</span></>
                            : <span className="muted">—</span>}
                        </td>
                        <td className="num">
                          {c.cost_per_qualified_lead != null
                            ? fmtMoney(c.cost_per_qualified_lead, c.currency ?? 'AED', true)
                            : <span className="muted">—</span>}
                        </td>
                        <td className="num">
                          {c.return_multiple != null
                            ? <Chip tone={c.return_multiple >= 3 ? 'ok' : c.return_multiple >= 1 ? 'warn' : 'crit'} mono>
                                {fmtDec(c.return_multiple, 1)}×
                              </Chip>
                            : <span className="muted">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>

            <p className="sub" style={{ padding: '0 4px' }}>
              A campaign with leads but no enquiries is not necessarily failing — it may simply be
              younger than your sales cycle. Read the return column against the campaign's dates.
            </p>
          </>
        );
      }}
    </DataView>
  );
}
