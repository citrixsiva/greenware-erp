import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useCan } from '../lib/auth';
import { dubaiToday, fmtDate, fmtDec, fmtInt, fmtMoney } from '../lib/format';
import { useBootstrap, useEmployees } from '../lib/hooks';
import type { CampaignRow } from '../lib/types';
import { FormDialog } from '../components/Dialog';
import { useToast } from '../components/Toast';
import {
  Chip, DataView, EmptyState, Field, Kpi, PageHead, Panel, PlusIcon,
} from '../components/ui';

const CHANNELS = ['Email', 'Webinar', 'Event', 'Digital', 'Content', 'Outbound'];

function CampaignForm({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const boot = useBootstrap();
  const employees = useEmployees();
  const [name, setName] = useState('');
  const [channel, setChannel] = useState('Email');
  const [ownerId, setOwnerId] = useState('');
  const [technologyCategoryId, setTechnologyCategoryId] = useState('');
  const [startDate, setStartDate] = useState(dubaiToday());
  const [endDate, setEndDate] = useState('');
  const [budget, setBudget] = useState('');
  const [currency, setCurrency] = useState('AED');
  const [targetLeads, setTargetLeads] = useState('');

  const badDates = !!endDate && endDate < startDate;

  return (
    <FormDialog
      title="New campaign"
      submitLabel="Create campaign"
      wide
      onClose={onClose}
      disabled={!name.trim() || !startDate || badDates}
      onSubmit={async () => {
        const res = await api.post<{ data: { campaign_code: string } }>('/campaigns', {
          name: name.trim(),
          channel,
          ownerId: ownerId || null,
          technologyCategoryId: technologyCategoryId || null,
          startDate,
          endDate: endDate || null,
          budget: budget ? Number(budget) : null,
          currency: budget ? currency : undefined,
          targetLeads: targetLeads ? Number(targetLeads) : null,
        });
        onDone(`${res.data.campaign_code} created.`);
      }}
    >
      <div className="dlg__body">
        <Field label="Name" required hint="What you would call it in a meeting — “Q1 Veeam renewal push”.">
          {(p) => <input {...p} className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={255} autoFocus />}
        </Field>

        <div className="cols">
          <Field label="Channel" required>
            {(p) => (
              <select {...p} className="select" value={channel} onChange={(e) => setChannel(e.target.value)}>
                {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            )}
          </Field>
          <Field label="Owner" hint="Defaults to you.">
            {(p) => (
              <select {...p} className="select" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                <option value="">You</option>
                {(employees.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}
              </select>
            )}
          </Field>
        </div>

        <Field label="Technology" hint="Optional. Ties the campaign to the practice it is meant to feed.">
          {(p) => (
            <select {...p} className="select" value={technologyCategoryId} onChange={(e) => setTechnologyCategoryId(e.target.value)}>
              <option value="">Not specific to one</option>
              {(boot.data?.technology_categories ?? []).map((t) => (
                <option key={t.id} value={t.id}>{t.sbu_code ? `${t.sbu_code} · ${t.name}` : t.name}</option>
              ))}
            </select>
          )}
        </Field>

        <div className="cols">
          <Field label="Starts" required>
            {(p) => <input {...p} className="input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />}
          </Field>
          <Field label="Ends" error={badDates ? 'The campaign cannot end before it starts.' : null} hint="Leave blank for an always-on campaign.">
            {(p) => <input {...p} className="input" type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} />}
          </Field>
        </div>

        <div className="cols">
          <Field label="Budget" hint="What you plan to spend. Actual spend is recorded on the campaign later.">
            {(p) => <input {...p} className="input" type="number" min={0} step={500} value={budget} onChange={(e) => setBudget(e.target.value)} />}
          </Field>
          <Field label="Currency">
            {(p) => (
              <select {...p} className="select" value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={!budget}>
                {(boot.data?.currencies ?? [{ code: 'AED', name: 'UAE Dirham' }]).map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
              </select>
            )}
          </Field>
          <Field label="Target leads">
            {(p) => <input {...p} className="input" type="number" min={1} step={10} value={targetLeads} onChange={(e) => setTargetLeads(e.target.value)} />}
          </Field>
        </div>
      </div>
    </FormDialog>
  );
}

/**
 * Spend is edited on its own, never alongside the budget on the create form.
 * It is the denominator of cost-per-qualified-lead and the return multiple, so
 * changing it moves every number on this screen — it deserves a deliberate act
 * and its own line in the audit trail.
 */
function SpendForm({ campaign, onClose, onDone }: {
  campaign: CampaignRow; onClose: () => void; onDone: (msg: string) => void;
}) {
  const [spend, setSpend] = useState(campaign.spend != null ? String(campaign.spend) : '');
  const ccy = campaign.currency ?? 'AED';
  const next = Number(spend || 0);
  const qualified = campaign.qualified;

  return (
    <FormDialog
      title={`Spend on ${campaign.campaign_code}`}
      submitLabel="Save spend"
      onClose={onClose}
      disabled={spend === ''}
      onSubmit={async () => {
        await api.patch(`/campaigns/${campaign.campaign_id}`, { spend: next });
        onDone(`Spend on ${campaign.campaign_code} set to ${fmtMoney(next, ccy, true)}.`);
      }}
    >
      <div className="dlg__body">
        <Field label={`Spend to date (${ccy})`} required hint={campaign.budget != null ? `Budgeted ${fmtMoney(campaign.budget, ccy, true)}.` : 'No budget was set for this campaign.'}>
          {(p) => <input {...p} className="input" type="number" min={0} step={100} value={spend} onChange={(e) => setSpend(e.target.value)} autoFocus />}
        </Field>
        <div className="kv">
          <span>Cost per qualified lead</span>
          <strong>{qualified > 0 ? fmtMoney(next / qualified, ccy, true) : <span className="muted">no qualified leads yet</span>}</strong>
          <span>Return</span>
          <strong>
            {next > 0 && campaign.won_value
              ? `${fmtDec(Number(campaign.won_value) / next, 1)}× on ${fmtMoney(campaign.won_value, 'AED', true)} won`
              : <span className="muted">nothing won yet</span>}
          </strong>
        </div>
      </div>
    </FormDialog>
  );
}

/**
 * Campaign attribution — spend against what it actually produced, read from
 * v_campaign_attribution. The chain is campaign -> lead -> enquiry -> customer
 * PO, so "won value" is money on a purchase order, not a forecast.
 */
export default function Campaigns() {
  const qc = useQueryClient();
  const toast = useToast();
  const canCreate = useCan('campaigns.create');
  const canEdit = useCan('campaigns.edit');
  const [dlg, setDlg] = useState<{ kind: 'new' } | { kind: 'spend'; campaign: CampaignRow } | null>(null);

  const query = useQuery({
    queryKey: ['campaigns', 'all'],
    queryFn: () => api.get<{ data: CampaignRow[] }>('/campaigns'),
    select: (r) => r.data,
  });

  const done = (msg: string) => {
    toast.push('ok', msg);
    setDlg(null);
    void qc.invalidateQueries({ queryKey: ['campaigns'] });
  };
  const newButton = (
    <button type="button" className="btn btn--primary" onClick={() => setDlg({ kind: 'new' })}>
      <PlusIcon /> New campaign
    </button>
  );

  return (
    <>
      <PageHead
        title="Campaigns"
        sub="What each campaign cost, and what it returned once its leads reached a purchase order."
        actions={canCreate ? newButton : null}
      />

      <DataView
        query={query}
        label="Loading campaigns"
        isEmpty={(d) => d.length === 0}
        empty={(
          <EmptyState
            title="No campaigns yet"
            hint="A campaign groups the leads it produced, so its spend can be measured against the business it won."
            action={canCreate ? newButton : undefined}
          />
        )}
      >
        {(rows) => {
          const spend = rows.reduce((a, c) => a + Number(c.spend ?? 0), 0);
          const won = rows.reduce((a, c) => a + Number(c.won_value ?? 0), 0);
          const leads = rows.reduce((a, c) => a + c.leads, 0);
          const qualified = rows.reduce((a, c) => a + c.qualified, 0);

          return (
            <>
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
                          <td className="num">
                            {canEdit ? (
                              <button type="button" className="linklike" onClick={() => setDlg({ kind: 'spend', campaign: c })}>
                                {c.spend != null && Number(c.spend) > 0
                                  ? fmtMoney(c.spend, c.currency ?? 'AED', true)
                                  : 'Add spend'}
                              </button>
                            ) : fmtMoney(c.spend, c.currency ?? 'AED', true)}
                          </td>
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

      {dlg?.kind === 'new' ? <CampaignForm onClose={() => setDlg(null)} onDone={done} /> : null}
      {dlg?.kind === 'spend' ? <SpendForm campaign={dlg.campaign} onClose={() => setDlg(null)} onDone={done} /> : null}
    </>
  );
}
