import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useCan } from '../lib/auth';
import { fmtDate, fmtDateTime, fmtMoney } from '../lib/format';
import { useBootstrap, useEmployees } from '../lib/hooks';
import type { ActivityKind, LeadDetail as Lead, LeadStatus } from '../lib/types';
import { FormDialog } from '../components/Dialog';
import { useToast } from '../components/Toast';
import {
  Chip, DataView, EmptyState, Field, Notice, PageHead, Panel, StatusPill,
} from '../components/ui';

const KINDS: ActivityKind[] = ['Call', 'Email', 'Meeting', 'Note', 'LinkedIn', 'WhatsApp', 'SiteVisit'];
const WORKABLE: LeadStatus[] = ['New', 'Working', 'Nurturing', 'Recycled'];

/**
 * What an activity can evidence, for scoring. The labels are what the rules
 * actually award for, so nobody has to guess which one means what; the points
 * come from gw.scoring_rules and are shown so the choice is an informed one.
 */
const SIGNALS: { value: string; label: string }[] = [
  { value: '', label: 'Nothing in particular' },
  { value: 'email_replied', label: 'They replied to us' },
  { value: 'webinar_attended', label: 'They attended a webinar' },
  { value: 'form_submission', label: 'They submitted a form' },
  { value: 'page_view', label: 'They visited a key page' },
];

/* ───────────────────────── log an activity ───────────────────────── */

function LogActivity({ lead, onClose, onDone }: { lead: Lead; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<ActivityKind>('Call');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [outcome, setOutcome] = useState('');
  const [mins, setMins] = useState('');
  const [signal, setSignal] = useState('');
  const [signalValue, setSignalValue] = useState('');

  return (
    <FormDialog
      title={`Log activity · ${lead.lead_no}`}
      submitLabel="Save"
      onClose={onClose}
      disabled={!subject.trim()}
      onSubmit={async () => {
        await api.post(`/leads/${lead.id}/activities`, {
          kind,
          subject: subject.trim(),
          body: body.trim() || null,
          outcome: outcome.trim() || null,
          durationMins: mins ? Number(mins) : null,
          behaviourEvent: signal || undefined,
          behaviourValue: signal === 'page_view' && signalValue.trim() ? signalValue.trim() : undefined,
        });
        onDone();
      }}
    >
      <div className="dlg__body">
        <Field label="Type" required>
          {(p) => (
            <select {...p} className="select" value={kind} onChange={(e) => setKind(e.target.value as ActivityKind)}>
              {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          )}
        </Field>
        <Field label="Subject" required hint="What happened, in one line.">
          {(p) => <input {...p} className="input" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={255} />}
        </Field>
        <Field label="Notes">
          {(p) => <textarea {...p} className="input" rows={4} value={body} onChange={(e) => setBody(e.target.value)} maxLength={10_000} />}
        </Field>
        <Field label="Outcome" hint="Where it leaves things — a next step, an objection, a date.">
          {(p) => <input {...p} className="input" value={outcome} onChange={(e) => setOutcome(e.target.value)} maxLength={255} />}
        </Field>
        <Field label="Duration (minutes)">
          {(p) => <input {...p} className="input" type="number" min={0} max={1440} value={mins} onChange={(e) => setMins(e.target.value)} />}
        </Field>
        <Field label="Did this show buying interest?" hint="Only pick one if it is what actually happened — it adds to the lead's score, and an email we sent is not a reply.">
          {(p) => (
            <select {...p} className="select" value={signal} onChange={(e) => setSignal(e.target.value)}>
              {SIGNALS.map((sg) => <option key={sg.value} value={sg.value}>{sg.label}</option>)}
            </select>
          )}
        </Field>
        {signal === 'page_view' ? (
          <Field label="Which page" hint="The path, e.g. /pricing.">
            {(p) => <input {...p} className="input" value={signalValue} onChange={(e) => setSignalValue(e.target.value)} maxLength={255} placeholder="/pricing" />}
          </Field>
        ) : null}
        {lead.status === 'New' ? (
          <Notice tone="info">Logging the first activity moves this lead to Working.</Notice>
        ) : null}
      </div>
    </FormDialog>
  );
}

/* ───────────────────────── qualify into an enquiry ───────────────────────── */

function Qualify({ lead, onClose, onDone }: { lead: Lead; onClose: () => void; onDone: (enquiryId: string) => void }) {
  const boot = useBootstrap();
  const employees = useEmployees();
  const [businessTypeId, setBusinessTypeId] = useState('');
  const [accountManagerId, setAccountManagerId] = useState(lead.owner_id ?? '');
  const [title, setTitle] = useState(
    lead.technology_name ? `${lead.technology_name} — ${lead.company_name}` : lead.company_name,
  );

  return (
    <FormDialog
      title={`Qualify ${lead.lead_no}`}
      submitLabel="Create enquiry"
      onClose={onClose}
      disabled={!businessTypeId}
      onSubmit={async () => {
        const res = await api.post<{ data: { id: string } }>(`/leads/${lead.id}/qualify`, {
          businessTypeId,
          accountManagerId: accountManagerId || null,
          title: title.trim() || null,
        });
        onDone(res.data.id);
      }}
    >
      <div className="dlg__body">
        <Notice tone="warn" title="This hands the lead to sales">
          An enquiry is created and the lead closes as Qualified. That cannot be undone from here —
          from then on the deal lives in the pipeline.
          {lead.customer_id ? null : ' A new customer record will be created from the company name.'}
        </Notice>
        <Field label="Business type" required hint="Decides the margin rule and the approval chain.">
          {(p) => (
            <select {...p} className="select" value={businessTypeId} onChange={(e) => setBusinessTypeId(e.target.value)}>
              <option value="">Choose…</option>
              {(boot.data?.business_types ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          )}
        </Field>
        <Field label="Account manager" hint="Who owns the enquiry from here.">
          {(p) => (
            <select {...p} className="select" value={accountManagerId} onChange={(e) => setAccountManagerId(e.target.value)}>
              <option value="">Keep the lead owner</option>
              {(employees.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}
            </select>
          )}
        </Field>
        <Field label="Enquiry title">
          {(p) => <input {...p} className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={255} />}
        </Field>
      </div>
    </FormDialog>
  );
}

/* ───────────────────────── disqualify ───────────────────────── */

function Disqualify({ lead, onClose, onDone }: { lead: Lead; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  return (
    <FormDialog
      title={`Disqualify ${lead.lead_no}`}
      submitLabel="Disqualify"
      danger
      onClose={onClose}
      disabled={!reason.trim()}
      onSubmit={async () => {
        await api.post(`/leads/${lead.id}/disqualify`, { reason: reason.trim() });
        onDone();
      }}
    >
      <div className="dlg__body">
        <Field label="Reason" required hint="Say why. This is what makes the campaign numbers mean something later.">
          {(p) => <textarea {...p} className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={255} />}
        </Field>
      </div>
    </FormDialog>
  );
}

/* ───────────────────────── page ───────────────────────── */

export default function LeadDetailPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const employees = useEmployees();
  const canEdit = useCan('leads.edit');
  const canLog = useCan('activities.create');
  const [dlg, setDlg] = useState<'activity' | 'qualify' | 'disqualify' | null>(null);

  const query = useQuery({
    queryKey: ['lead', id],
    queryFn: () => api.get<{ data: Lead }>(`/leads/${id}`),
    select: (r) => r.data,
  });

  const reload = () => {
    void qc.invalidateQueries({ queryKey: ['lead', id] });
    void qc.invalidateQueries({ queryKey: ['leads'] });
    void qc.invalidateQueries({ queryKey: ['dealdesk'] });
  };

  async function patch(body: Record<string, unknown>, done: string) {
    try {
      await api.patch(`/leads/${id}`, body);
      toast.push('ok', done);
      reload();
    } catch (e) {
      toast.push('crit', e instanceof Error ? e.message : 'That change could not be saved.');
    }
  }

  return (
    <DataView query={query} label="Loading lead">
      {(l) => {
        const workable = WORKABLE.includes(l.status);
        return (
          <>
            <PageHead
              crumbs={<Link to="/deal-desk">Deal Desk</Link>}
              title={<>{l.company_name} <span className="id">{l.lead_no}</span></>}
              sub={
                <>
                  <StatusPill value={l.status} />{' '}
                  <Chip mono title={`Lead score ${l.score} of 100`}>Score {l.score}</Chip>{' '}
                  {l.campaign_code ? <Chip tone="accent">{l.campaign_code}</Chip> : null}{' '}
                  {l.consent_marketing
                    ? <Chip tone="ok" title={l.consent_at ? `Consent recorded ${fmtDateTime(l.consent_at)}` : undefined}>Opted in</Chip>
                    : <Chip tone="warn" title="No marketing consent on record — do not add to a sequence">No consent</Chip>}
                </>
              }
              actions={
                <>
                  {canLog && workable ? (
                    <button type="button" className="btn" onClick={() => setDlg('activity')}>Log activity</button>
                  ) : null}
                  {canEdit && workable ? (
                    <>
                      <button type="button" className="btn btn--primary" onClick={() => setDlg('qualify')}>Qualify</button>
                      <button type="button" className="btn btn--ghost" onClick={() => setDlg('disqualify')}>Disqualify</button>
                    </>
                  ) : null}
                </>
              }
            />

            {l.status === 'Qualified' && l.qualified_enquiry_id ? (
              <Notice tone="ok" title="Handed to sales">
                Qualified {l.qualified_at ? fmtDateTime(l.qualified_at) : ''} — now enquiry{' '}
                <Link to={`/enquiries/${l.qualified_enquiry_id}`} className="id">{l.qualified_enquiry_no ?? 'open it'}</Link>.
              </Notice>
            ) : null}
            {l.status === 'Disqualified' ? (
              <Notice tone="warn" title="Disqualified">{l.disqualify_reason}</Notice>
            ) : null}

            <div className="cols">
              <Panel title="Contact">
                <dl className="kv">
                  <dt>Name</dt><dd>{l.contact_name ?? <span className="muted">Not captured</span>}</dd>
                  <dt>Role</dt><dd>{l.designation ?? <span className="muted">Not captured</span>}</dd>
                  <dt>Email</dt><dd>{l.email ? <a href={`mailto:${l.email}`}>{l.email}</a> : <span className="muted">Not captured</span>}</dd>
                  <dt>Phone</dt><dd>{l.phone ?? <span className="muted">Not captured</span>}</dd>
                  <dt>Country</dt><dd>{l.country ?? <span className="muted">—</span>}</dd>
                  <dt>Account</dt>
                  <dd>{l.customer_id ? <Chip tone="ok">Existing customer</Chip> : <span className="muted">New name</span>}</dd>
                </dl>
              </Panel>

              <Panel title="Opportunity">
                <dl className="kv">
                  <dt>Source</dt><dd>{l.source ?? <span className="muted">Direct</span>}</dd>
                  <dt>Campaign</dt>
                  <dd>{l.campaign_code ? `${l.campaign_code} · ${l.campaign_name}` : <span className="muted">None</span>}</dd>
                  <dt>Technology</dt><dd>{l.technology_name ?? <span className="muted">Unmatched</span>}</dd>
                  <dt>SBU</dt><dd>{l.sbu_code ?? <span className="muted">Unrouted</span>}</dd>
                  <dt>Estimated value</dt>
                  <dd>{l.estimated_value != null ? fmtMoney(l.estimated_value, l.currency) : <span className="muted">Not sized</span>}</dd>
                  <dt>Age</dt><dd className="mono">{l.age_days} days</dd>
                  <dt>Owner</dt>
                  <dd>
                    {canEdit && workable ? (
                      <select
                        className="select"
                        value={l.owner_id ?? ''}
                        aria-label="Lead owner"
                        onChange={(e) => void patch({ ownerId: e.target.value || null }, 'Owner changed.')}
                      >
                        <option value="">Unassigned</option>
                        {(employees.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}
                      </select>
                    ) : (l.owner_name ?? <span className="muted">Unassigned</span>)}
                  </dd>
                  {canEdit && workable ? (
                    <>
                      <dt>Status</dt>
                      <dd>
                        <select
                          className="select"
                          value={l.status}
                          aria-label="Lead status"
                          onChange={(e) => void patch({ status: e.target.value }, 'Status changed.')}
                        >
                          {WORKABLE.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </dd>
                    </>
                  ) : null}
                </dl>
              </Panel>
            </div>

            <Panel title="Timeline" count={l.activities.length} flush>
              {l.activities.length === 0 ? (
                <EmptyState
                  title="Nothing logged yet"
                  hint={canLog ? 'Log the first call, email or meeting and this lead moves to Working.' : 'No activity has been recorded against this lead.'}
                />
              ) : (
                <ul className="timeline">
                  {l.activities.map((a) => (
                    <li key={a.id} className="timeline__item">
                      <div className="timeline__head">
                        <Chip tone="accent">{a.kind}</Chip>
                        <strong>{a.subject}</strong>
                        <span className="sub">
                          {fmtDateTime(a.occurred_at)}
                          {a.performed_by_name ? ` · ${a.performed_by_name}` : ''}
                          {a.duration_mins != null ? ` · ${a.duration_mins} min` : ''}
                        </span>
                      </div>
                      {a.body ? <p className="prewrap">{a.body}</p> : null}
                      {a.outcome ? <p className="sub">Outcome: {a.outcome}</p> : null}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title="Why this score" count={l.score_events.length} flush>
              {l.score_events.length === 0 ? (
                <EmptyState title="No scoring events" hint="The score is the starting value until a rule fires or someone sets it by hand." />
              ) : (
                <div className="table-wrap">
                  <table className="t">
                    <thead><tr><th className="num">Points</th><th>Reason</th><th>When</th></tr></thead>
                    <tbody>
                      {l.score_events.map((e) => (
                        <tr key={e.id}>
                          <td className="num"><Chip tone={e.points >= 0 ? 'ok' : 'crit'} mono>{e.points >= 0 ? `+${e.points}` : e.points}</Chip></td>
                          <td className="wrap">{e.reason ?? <span className="muted">—</span>}</td>
                          <td className="nowrap">{fmtDate(e.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>

            {dlg === 'activity' ? (
              <LogActivity lead={l} onClose={() => setDlg(null)} onDone={() => { toast.push('ok', 'Activity logged.'); reload(); }} />
            ) : null}
            {dlg === 'qualify' ? (
              <Qualify
                lead={l}
                onClose={() => setDlg(null)}
                onDone={(enquiryId) => { toast.push('ok', 'Qualified. The enquiry is now in the sales pipeline.'); reload(); nav(`/enquiries/${enquiryId}`); }}
              />
            ) : null}
            {dlg === 'disqualify' ? (
              <Disqualify lead={l} onClose={() => setDlg(null)} onDone={() => { toast.push('ok', 'Lead disqualified.'); reload(); }} />
            ) : null}
          </>
        );
      }}
    </DataView>
  );
}
