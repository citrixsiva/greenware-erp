import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth, useCan } from '../lib/auth';
import { fmtCompact, fmtDec, fmtMoney, fmtPct } from '../lib/format';
import { usePagedList, useEmployees, useBootstrap } from '../lib/hooks';
import type { CampaignRow, DealDeskSummary, LeadRow } from '../lib/types';
import { FormDialog } from '../components/Dialog';
import { useToast } from '../components/Toast';
import {
  Chip, EmptyState, ErrorState, Field, Kpi, LoadingState, MoreButton, PageHead, Panel, PlusIcon, StatusPill,
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

/* ───────────────────────── new lead ───────────────────────── */

/**
 * The entry form. Only the company name is required — a lead caught at a stand
 * or off a phone call is usually half a record, and refusing to save it until
 * every field is filled is how leads end up on the back of a business card
 * instead of in the system. Everything else can be added later from the lead
 * screen, and the score rises as the record fills out.
 */
function NewLead({ campaigns, onClose, onDone }: {
  campaigns: CampaignRow[];
  onClose: () => void;
  onDone: (id: string, leadNo: string) => void;
}) {
  const boot = useBootstrap();
  const employees = useEmployees();
  const { user } = useAuth();

  const [companyName, setCompanyName] = useState('');
  const [contactName, setContactName] = useState('');
  const [designation, setDesignation] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [country, setCountry] = useState('AE');
  const [source, setSource] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [technologyId, setTechnologyId] = useState('');
  const [estimatedValue, setEstimatedValue] = useState('');
  const [currency, setCurrency] = useState('AED');
  const [ownerId, setOwnerId] = useState('');
  const [consent, setConsent] = useState(false);
  const [notes, setNotes] = useState('');

  // The owner defaults to the person entering it — whoever catches a lead owns
  // it until someone decides otherwise.
  const myEmployeeId = (employees.data ?? []).find((e) => e.full_name === user?.displayName)?.id ?? '';

  return (
    <FormDialog
      title="New lead"
      submitLabel="Create lead"
      wide
      onClose={onClose}
      disabled={!companyName.trim()}
      onSubmit={async () => {
        const res = await api.post<{ data: { id: string; lead_no: string } }>('/leads', {
          companyName: companyName.trim(),
          contactName: contactName.trim() || null,
          designation: designation.trim() || null,
          email: email.trim() || null,
          phone: phone.trim() || null,
          country: country.trim() ? country.trim().toUpperCase() : null,
          source: source.trim() || null,
          sourceDetail: notes.trim() || null,
          campaignId: campaignId || null,
          technologyId: technologyId || null,
          estimatedValue: estimatedValue ? Number(estimatedValue) : null,
          currency,
          ownerId: ownerId || myEmployeeId || null,
          consentMarketing: consent,
        });
        onDone(res.data.id, res.data.lead_no);
      }}
    >
      <div className="dlg__body">
        <Field label="Company" required hint="Free text until the lead is matched to a customer account.">
          {(p) => <input {...p} className="input" value={companyName} onChange={(e) => setCompanyName(e.target.value)} maxLength={255} autoFocus />}
        </Field>

        <div className="cols">
          <Field label="Contact name">
            {(p) => <input {...p} className="input" value={contactName} onChange={(e) => setContactName(e.target.value)} maxLength={255} />}
          </Field>
          <Field label="Role" hint="A decision-maker title scores the lead higher.">
            {(p) => <input {...p} className="input" value={designation} onChange={(e) => setDesignation(e.target.value)} maxLength={255} placeholder="IT Director" />}
          </Field>
        </div>

        <div className="cols">
          <Field label="Email">
            {(p) => <input {...p} className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={255} />}
          </Field>
          <Field label="Phone">
            {(p) => <input {...p} className="input" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={255} />}
          </Field>
        </div>

        <div className="cols">
          <Field label="Source" hint="Where it came from, in your own words.">
            {(p) => <input {...p} className="input" value={source} onChange={(e) => setSource(e.target.value)} maxLength={255} placeholder="GITEX booth scan" />}
          </Field>
          <Field label="Campaign" hint="Links the lead to campaign spend, so its return can be measured.">
            {(p) => (
              <select {...p} className="select" value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
                <option value="">None</option>
                {campaigns.map((c) => <option key={c.campaign_id} value={c.campaign_id}>{c.campaign_code} · {c.name}</option>)}
              </select>
            )}
          </Field>
        </div>

        <div className="cols">
          <Field label="Technology" hint="Routes the lead to the right SBU.">
            {(p) => (
              <select {...p} className="select" value={technologyId} onChange={(e) => setTechnologyId(e.target.value)}>
                <option value="">Not known yet</option>
                {(boot.data?.technologies ?? []).map((t) => (
                  <option key={t.id} value={t.id}>{t.category_name} · {t.name}{t.sbu_code ? ` (${t.sbu_code})` : ''}</option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Owner">
            {(p) => (
              <select {...p} className="select" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                <option value="">Me</option>
                {(employees.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}
              </select>
            )}
          </Field>
        </div>

        <div className="cols">
          <Field label="Estimated value" hint="A rough figure is fine. Over AED 100,000 adds to the score.">
            {(p) => <input {...p} className="input" type="number" min={0} step={1000} value={estimatedValue} onChange={(e) => setEstimatedValue(e.target.value)} />}
          </Field>
          <Field label="Currency">
            {(p) => (
              <select {...p} className="select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {(boot.data?.currencies ?? [{ code: 'AED', name: 'UAE Dirham' }]).map((c) => (
                  <option key={c.code} value={c.code}>{c.code}</option>
                ))}
              </select>
            )}
          </Field>
        </div>

        <Field label="Country">
          {(p) => <input {...p} className="input" value={country} onChange={(e) => setCountry(e.target.value)} maxLength={2} placeholder="AE" style={{ maxWidth: 90 }} />}
        </Field>

        <Field label="Notes">
          {(p) => <textarea {...p} className="input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={10_000} placeholder="What they asked about, what was promised, anything worth knowing next time." />}
        </Field>

        <label className="check">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>
            They agreed to be contacted about Greenware products and services.
            <span className="hint"> Tick this only if they actually did — it is the lawful basis for adding them to a sequence.</span>
          </span>
        </label>
      </div>
    </FormDialog>
  );
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

  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const canCreate = useCan('leads.create');
  const [newLead, setNewLead] = useState(false);
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
        actions={canCreate ? (
          <button type="button" className="btn btn--primary" onClick={() => setNewLead(true)}>
            <PlusIcon /> New lead
          </button>
        ) : null}
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
                ? 'The inbox is clear. Add one with “New lead”, or let campaigns, web forms and event scans fill it.'
                : 'No lead matches these filters.'}
              action={canCreate && view === 'inbox' && !ownerId && !campaignId && !search
                ? <button type="button" className="btn btn--primary" onClick={() => setNewLead(true)}><PlusIcon /> New lead</button>
                : undefined}
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

      {newLead ? (
        <NewLead
          campaigns={campaigns.data?.data ?? []}
          onClose={() => setNewLead(false)}
          onDone={(id, leadNo) => {
            toast.push('ok', `${leadNo} created.`);
            void qc.invalidateQueries({ queryKey: ['leads'] });
            void qc.invalidateQueries({ queryKey: ['dealdesk'] });
            nav(`/deal-desk/${id}`);
          }}
        />
      ) : null}
    </>
  );
}
