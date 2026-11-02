import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, type One, type Page, UserError } from '../lib/api';
import { useCan } from '../lib/auth';
import { dubaiToday, fmtDate, fmtDateTime, fmtDec, fmtMoney, fmtPct, isNum } from '../lib/format';
import { useBootstrap } from '../lib/hooks';
import type { EnquiryDetail, EstRequest, ProcRequest, QuotationDetail, QuoteVersionSummary } from '../lib/types';
import { FormDialog, MessageDialog } from '../components/Dialog';
import { StageDialog } from '../components/StageDialog';
import { useToast } from '../components/Toast';
import { Chip, DataView, EmptyState, Field, Kpi, PageHead, Panel, PlusIcon, SlaPill, StatusPill, UrgencyChip } from '../components/ui';

type Dlg = null | 'proc' | 'est' | 'follow' | 'stage';
const ALL_PROC = 'Raised,Assigned,Sourcing,AwaitingSupplier,Responded,Cancelled';
const ALL_EST = 'Raised,Assigned,InReview,ClarificationNeeded,Submitted,Cancelled';

function RaiseProcurement({ enq, onClose, onDone }: { enq: EnquiryDetail; onClose: () => void; onDone: () => void }) {
  const [urgency, setUrgency] = useState('Normal');
  const [requiredBy, setRequiredBy] = useState('');
  const [remarks, setRemarks] = useState('');
  const [rows, setRows] = useState(enq.lines.map((l) => ({ id: l.id, on: true, description: l.description, quantity: String(l.quantity), partNumber: '' })));
  const chosen = rows.filter((r) => r.on);
  return (
    <FormDialog
      wide
      title={`Raise procurement request for ${enq.enquiry_no}`}
      submitLabel="Raise request"
      onClose={onClose}
      disabled={chosen.length === 0}
      onSubmit={async () => {
        if (!chosen.length) throw new UserError('Choose at least one line to source.');
        await api.post('/procurement/requests', {
          enquiryId: enq.id,
          urgency,
          requiredBy: requiredBy || undefined,
          remarks: remarks || undefined,
          lines: chosen.map((r) => ({
            enquiryLineId: r.id,
            description: r.description,
            quantity: Number(r.quantity),
            partNumber: r.partNumber || undefined,
          })),
        });
        onDone();
      }}
    >
      <div className="form-grid">
        <Field label="Urgency">{(p) => <select {...p} className="select" value={urgency} onChange={(e) => setUrgency(e.target.value)}><option>Normal</option><option>Urgent</option></select>}</Field>
        <Field label="Needed by">{(p) => <input {...p} className="input" type="date" min={dubaiToday()} value={requiredBy} onChange={(e) => setRequiredBy(e.target.value)} />}</Field>
      </div>
      <div className="table-wrap">
        <table className="t">
          <thead><tr><th><span className="sr-only">Include</span></th><th>Line</th><th>Description</th><th>Part number</th><th className="num">Qty</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id}>
                <td><input type="checkbox" aria-label={`Include line ${i + 1}`} checked={r.on} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} /></td>
                <td className="mono">{enq.lines[i].line_no}</td>
                <td className="wrap"><input className="input input--cell" aria-label={`Description, line ${i + 1}`} value={r.description} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} /></td>
                <td><input className="input input--cell" aria-label={`Part number, line ${i + 1}`} value={r.partNumber} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, partNumber: e.target.value } : x)))} /></td>
                <td><input className="input input--cell input--num w-sm" aria-label={`Quantity, line ${i + 1}`} inputMode="decimal" value={r.quantity} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Field label="Remarks for procurement">{(p) => <textarea {...p} className="textarea" value={remarks} onChange={(e) => setRemarks(e.target.value)} />}</Field>
    </FormDialog>
  );
}

function RaiseEstimation({ enq, onClose, onDone }: { enq: EnquiryDetail; onClose: () => void; onDone: () => void }) {
  const boot = useBootstrap();
  const [urgency, setUrgency] = useState('Normal');
  const [requiredBy, setRequiredBy] = useState('');
  const [sbuId, setSbuId] = useState('');
  const [notes, setNotes] = useState('');
  return (
    <FormDialog
      title={`Raise estimation request for ${enq.enquiry_no}`}
      submitLabel="Raise request"
      onClose={onClose}
      onSubmit={async () => {
        await api.post('/estimation/requests', {
          enquiryId: enq.id,
          urgency,
          requiredBy: requiredBy || undefined,
          sbuId: sbuId || undefined,
          scopeNotes: notes || undefined,
        });
        onDone();
      }}
    >
      <div className="form-grid">
        <Field label="Urgency">{(p) => <select {...p} className="select" value={urgency} onChange={(e) => setUrgency(e.target.value)}><option>Normal</option><option>Urgent</option></select>}</Field>
        <Field label="Needed by">{(p) => <input {...p} className="input" type="date" min={dubaiToday()} value={requiredBy} onChange={(e) => setRequiredBy(e.target.value)} />}</Field>
        <Field label="SBU" hint="Leave on automatic to send one request to every SBU the lines route to.">
          {(p) => (
            <select {...p} className="select" value={sbuId} onChange={(e) => setSbuId(e.target.value)}>
              <option value="">Automatic, from the lines</option>
              {boot.data?.sbus.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}
            </select>
          )}
        </Field>
      </div>
      <Field label="Scope notes">{(p) => <textarea {...p} className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What the engineer needs to know to size this" />}</Field>
    </FormDialog>
  );
}

function LogFollowUp({ enq, onClose, onDone }: { enq: EnquiryDetail; onClose: () => void; onDone: () => void }) {
  const [remarks, setRemarks] = useState('');
  const [next, setNext] = useState('');
  const [channel, setChannel] = useState('Call');
  const [feedback, setFeedback] = useState('');
  return (
    <FormDialog
      title={`Log follow-up on ${enq.enquiry_no}`}
      submitLabel="Save follow-up"
      onClose={onClose}
      onSubmit={async () => {
        if (!remarks.trim()) throw new UserError('Write what was discussed before saving.');
        await api.post(`/enquiries/${enq.id}/follow-ups`, {
          remarks: remarks.trim(),
          nextFollowUp: next || undefined,
          channel: channel || undefined,
          customerFeedback: feedback.trim() || undefined,
        });
        onDone();
      }}
    >
      <div className="form-grid">
        <Field label="Channel">
          {(p) => <select {...p} className="select" value={channel} onChange={(e) => setChannel(e.target.value)}>{['Call', 'Email', 'Meeting', 'WhatsApp', 'Site visit', 'Other'].map((c) => <option key={c}>{c}</option>)}</select>}
        </Field>
        <Field label="Next follow-up on">{(p) => <input {...p} className="input" type="date" min={dubaiToday()} value={next} onChange={(e) => setNext(e.target.value)} />}</Field>
      </div>
      <Field label="What was discussed" required>{(p) => <textarea {...p} className="textarea" value={remarks} onChange={(e) => setRemarks(e.target.value)} />}</Field>
      <Field label="Customer feedback">{(p) => <textarea {...p} className="textarea" value={feedback} onChange={(e) => setFeedback(e.target.value)} />}</Field>
    </FormDialog>
  );
}

function VersionsTable({ versions, quotationId }: { versions: QuoteVersionSummary[]; quotationId: string }) {
  // Column exists only if the server sent that field for at least one version.
  const showTotal = versions.some((v) => v.total_sell !== undefined);
  const showGm = versions.some((v) => v.gross_margin_pct !== undefined);
  return (
    <div className="table-wrap">
      <table className="t">
        <thead>
          <tr><th>Version</th><th>Status</th><th>Valid until</th>{showTotal ? <th className="num">Total</th> : null}{showGm ? <th className="num">GM</th> : null}</tr>
        </thead>
        <tbody>
          {versions.map((v) => (
            <tr key={v.id}>
              <td><Link to={`/quotations/${quotationId}?v=${v.version_no}`} className="mono">v{v.version_no}</Link></td>
              <td><StatusPill value={v.status} /></td>
              <td>{fmtDate(v.valid_until)}</td>
              {showTotal ? <td className="num">{isNum(v.total_sell) ? fmtMoney(v.total_sell, v.currency) : null}</td> : null}
              {showGm ? <td className="num">{isNum(v.gross_margin_pct) ? fmtPct(v.gross_margin_pct) : null}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Enquiry360() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const canEdit = useCan('enquiries.edit');
  const canRaiseProc = useCan('procurement_requests.create');
  const canRaiseEst = useCan('technical_estimations.create');
  const canQuote = useCan('quotations.create');
  const [dlg, setDlg] = useState<Dlg>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);

  const enq = useQuery({ queryKey: ['enquiry', id], queryFn: async () => (await api.get<One<EnquiryDetail>>(`/enquiries/${id}`)).data });
  const hasProc = !!enq.data?.procurement_requests;
  const hasEst = !!enq.data?.estimation_requests;
  const procSla = useQuery({
    queryKey: ['proc-by-enq', id],
    enabled: hasProc,
    queryFn: async () => (await api.get<Page<ProcRequest>>('/procurement/requests', { enquiryId: id, status: ALL_PROC, limit: 100 })).data,
  });
  const estSla = useQuery({
    queryKey: ['est-by-enq', id],
    enabled: hasEst,
    queryFn: async () => (await api.get<Page<EstRequest>>('/estimation/requests', { enquiryId: id, status: ALL_EST, limit: 100 })).data,
  });

  const reload = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['enquiry', id] }),
      qc.invalidateQueries({ queryKey: ['proc-by-enq', id] }),
      qc.invalidateQueries({ queryKey: ['est-by-enq', id] }),
      qc.invalidateQueries({ queryKey: ['board'] }),
    ]);
  };

  async function buildQuotation() {
    setBuilding(true);
    try {
      const res = await api.post<{ data: QuotationDetail; seeded?: { supplierQuoteLines: number; technicalEstimates: number } | null }>('/quotations', { enquiryId: id, seedFromEnquiry: true });
      const s = res.seeded;
      toast.push('ok', s ? `Quotation ${res.data.quotation_no} started with ${s.supplierQuoteLines} supplier line(s) and ${s.technicalEstimates} estimate(s).` : `Quotation ${res.data.quotation_no} started.`);
      await reload();
      navigate(`/quotations/${res.data.id}`);
    } catch (e) {
      setBlocked(errorMessage(e));
    } finally {
      setBuilding(false);
    }
  }

  return (
    <DataView query={enq} label="Loading the enquiry chain">
      {(e) => {
        const procMap = new Map((procSla.data ?? []).map((r) => [r.id, r]));
        const estMap = new Map((estSla.data ?? []).map((r) => [r.id, r]));
        const open = !['Won', 'Lost', 'Cancelled', 'Dropped'].includes(e.stage);
        const done = () => {
          setDlg(null);
          void reload();
        };
        return (
          <>
            <PageHead
              crumbs={<><Link to="/pipeline">Pipeline</Link><span>/</span><span className="mono">{e.enquiry_no}</span></>}
              title={e.title}
              sub={<><StatusPill value={e.stage} /> <span className="muted"> · {e.customer_name}{e.end_customer_name ? ` (for ${e.end_customer_name})` : ''}</span></>}
              actions={
                <>
                  {canEdit ? <button type="button" className="btn" onClick={() => setDlg('follow')}><PlusIcon /> Log follow-up</button> : null}
                  {canRaiseProc && open ? <button type="button" className="btn" onClick={() => setDlg('proc')}>Raise procurement request</button> : null}
                  {canRaiseEst && open ? <button type="button" className="btn" onClick={() => setDlg('est')}>Raise estimation request</button> : null}
                  {canQuote && open ? <button type="button" className="btn" disabled={building} onClick={() => void buildQuotation()}>{building ? 'Building…' : 'Build quotation'}</button> : null}
                  {canEdit ? <button type="button" className="btn btn--primary" onClick={() => setDlg('stage')}>Change stage</button> : null}
                </>
              }
            />

            <div className="kpis">
              <Kpi label="Value" value={isNum(e.approx_budget) ? fmtMoney(e.approx_budget, e.budget_currency ?? 'AED', true) : <span className="muted">No budget</span>} sub={isNum(e.probability) ? `${fmtDec(e.probability, 0)}% probability` : undefined} />
              <Kpi label="In stage" value={`${e.days_in_stage} d`} sub={e.slip_count ? `Slipped ${e.slip_count}×` : 'No slips'} />
              <Kpi label="Quote by" value={fmtDate(e.expected_quote_date) || <span className="muted">Not set</span>} />
              <Kpi label="PO expected" value={fmtDate(e.expected_po_date) || <span className="muted">Not set</span>} />
              <Kpi
                label="Next follow-up"
                value={e.next_follow_up ? fmtDate(e.next_follow_up) : <span className="muted">None set</span>}
                sub={e.follow_up_overdue ? <Chip tone="crit">Overdue</Chip> : undefined}
              />
            </div>

            <div className="two-col">
              <div className="stack--lg stack" style={{ minWidth: 0 }}>
                <Panel title="Summary" id="sum">
                  <dl className="dl">
                    <div><dt>Owner</dt><dd>{e.account_manager_name}</dd></div>
                    <div><dt>Business type</dt><dd>{e.business_type_name}</dd></div>
                    <div><dt>SBU</dt><dd>{e.primary_sbu_code ?? <span className="muted">Not routed</span>}</dd></div>
                    <div><dt>Contact</dt><dd>{e.contact_name ? <>{e.contact_name}{e.contact_designation ? `, ${e.contact_designation}` : ''}<span className="muted break"> {e.contact_email ?? ''}</span></> : <span className="muted">None</span>}</dd></div>
                    <div><dt>Received</dt><dd>{fmtDateTime(e.received_at)}</dd></div>
                    {e.campaign_name ? <div><dt>Campaign</dt><dd>{e.campaign_name}</dd></div> : null}
                    {e.stage === 'Lost' ? <div><dt>Loss reason</dt><dd>{e.loss_reason ?? ''}{e.loss_remarks ? ` — ${e.loss_remarks}` : ''}</dd></div> : null}
                    {e.description ? <div style={{ gridColumn: '1 / -1' }}><dt>Description</dt><dd className="prewrap">{e.description}</dd></div> : null}
                    {e.remarks ? <div style={{ gridColumn: '1 / -1' }}><dt>Remarks</dt><dd className="prewrap">{e.remarks}</dd></div> : null}
                  </dl>
                </Panel>

                <Panel title="Lines" count={e.lines.length} flush id="lines">
                  <div className="table-wrap">
                    <table className="t">
                      <thead><tr><th className="num">#</th><th>Description</th><th>Technology</th><th>SBU</th><th className="num">Qty</th></tr></thead>
                      <tbody>
                        {e.lines.map((l) => (
                          <tr key={l.id}>
                            <td className="num">{l.line_no}</td>
                            <td className="wrap">{l.description}</td>
                            <td>{l.technology_name ?? <span className="muted">None</span>}{l.technology_category ? <span className="sub">{l.technology_category}</span> : null}</td>
                            <td>{l.sbu_code ? <Chip mono>{l.sbu_code}</Chip> : null}</td>
                            <td className="num">{fmtDec(l.quantity, 0)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Panel>

                {e.procurement_requests ? (
                  <Panel
                    title="Procurement requests"
                    count={e.procurement_requests.length}
                    flush
                    id="proc"
                    actions={canRaiseProc && open ? <button type="button" className="btn btn--sm" onClick={() => setDlg('proc')}><PlusIcon /> Raise</button> : null}
                  >
                    {e.procurement_requests.length === 0 ? (
                      <EmptyState title="No procurement requests" hint="Raise one when supplier pricing is needed for this enquiry." />
                    ) : (
                      <div className="table-wrap">
                        <table className="t">
                          <thead><tr><th>Request</th><th>SLA</th><th>Status</th><th>Urgency</th><th>Assigned</th><th>Raised</th></tr></thead>
                          <tbody>
                            {e.procurement_requests.map((r) => {
                              const live = procMap.get(r.id);
                              return (
                                <tr key={r.id}>
                                  <td><Link to={`/procurement/${r.id}`} className="id">{r.request_no}</Link></td>
                                  <td>{live ? <SlaPill state={live.sla_state} clock={live.sla_clock} elapsed={live.elapsed_working_hours} target={live.target_hours} /> : procSla.isPending ? <span className="muted">Checking…</span> : null}</td>
                                  <td><StatusPill value={r.status} /></td>
                                  <td><UrgencyChip urgency={r.urgency} /></td>
                                  <td>{live?.assigned_to_name ?? <span className="muted">Unassigned</span>}</td>
                                  <td className="nowrap">{fmtDateTime(r.raised_at)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Panel>
                ) : null}

                {e.estimation_requests ? (
                  <Panel
                    title="Estimation requests"
                    count={e.estimation_requests.length}
                    flush
                    id="est"
                    actions={canRaiseEst && open ? <button type="button" className="btn btn--sm" onClick={() => setDlg('est')}><PlusIcon /> Raise</button> : null}
                  >
                    {e.estimation_requests.length === 0 ? (
                      <EmptyState title="No estimation requests" hint="Raise one when an engineer must size the services." />
                    ) : (
                      <div className="table-wrap">
                        <table className="t">
                          <thead><tr><th>Request</th><th>SBU</th><th>SLA</th><th>Status</th><th>Urgency</th><th>Engineer</th><th>Raised</th></tr></thead>
                          <tbody>
                            {e.estimation_requests.map((r) => {
                              const live = estMap.get(r.id);
                              return (
                                <tr key={r.id}>
                                  <td><Link to={`/estimation/${r.id}`} className="id">{r.request_no}</Link></td>
                                  <td>{r.sbu_code ? <Chip mono>{r.sbu_code}</Chip> : null}</td>
                                  <td>{live ? <SlaPill state={live.sla_state} clock={live.sla_clock} elapsed={live.elapsed_working_hours} target={live.target_hours} /> : estSla.isPending ? <span className="muted">Checking…</span> : null}</td>
                                  <td><StatusPill value={r.status} /></td>
                                  <td><UrgencyChip urgency={r.urgency} /></td>
                                  <td>{live?.assigned_to_name ?? <span className="muted">Unassigned</span>}</td>
                                  <td className="nowrap">{fmtDateTime(r.raised_at)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Panel>
                ) : null}

                {e.quotations ? (
                  <Panel
                    title="Quotations"
                    count={e.quotations.length}
                    flush
                    id="quo"
                    actions={canQuote && open ? <button type="button" className="btn btn--sm" disabled={building} onClick={() => void buildQuotation()}><PlusIcon /> Build</button> : null}
                  >
                    {e.quotations.length === 0 ? (
                      <EmptyState title="No quotations yet" hint="Build one to price this enquiry from the supplier quotes and estimates already on file." />
                    ) : (
                      e.quotations.map((qt) => (
                        <div key={qt.id}>
                          <div className="row" style={{ padding: '8px 12px', background: 'var(--surface-2)', borderBottom: '1px solid var(--line)' }}>
                            <Link to={`/quotations/${qt.id}`} className="id"><b>{qt.quotation_no}</b></Link>
                            <span className="muted">current version v{qt.current_version}</span>
                            <Link to={`/quotations/${qt.id}`} className="btn btn--sm right">Open builder</Link>
                          </div>
                          {qt.versions.length ? <VersionsTable versions={qt.versions} quotationId={qt.id} /> : <EmptyState title="No versions" />}
                        </div>
                      ))
                    )}
                  </Panel>
                ) : null}

                {e.customer_pos && e.customer_pos.length > 0 ? (
                  <Panel title="Customer POs" count={e.customer_pos.length} flush id="pos">
                    <div className="table-wrap">
                      <table className="t">
                        <thead><tr><th>PO</th><th>Customer PO no.</th><th>Date</th><th className="num">Amount</th></tr></thead>
                        <tbody>
                          {e.customer_pos.map((p) => (
                            <tr key={p.id}><td className="id">{p.po_ref}</td><td className="id">{p.customer_po_number}</td><td>{fmtDate(p.po_date)}</td><td className="num">{fmtMoney(p.po_amount, p.currency)}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Panel>
                ) : null}
              </div>

              <div className="side-stack">
                <Panel title="Follow-ups" count={e.follow_ups.length} id="fu" actions={canEdit ? <button type="button" className="btn btn--sm" onClick={() => setDlg('follow')}><PlusIcon /> Log</button> : null}>
                  {e.follow_ups.length === 0 ? (
                    <EmptyState title="No follow-ups logged" hint="Log each customer touch so the next step is never lost." />
                  ) : (
                    <ol className="timeline">
                      {e.follow_ups.map((f) => (
                        <li key={f.id}>
                          <div className="when">{fmtDateTime(f.followed_up_at)} · {f.created_by_name ?? 'System'}{f.channel ? ` · ${f.channel}` : ''}</div>
                          <div className="prewrap">{f.remarks}</div>
                          {f.customer_feedback ? <div className="muted prewrap">Customer: {f.customer_feedback}</div> : null}
                          {f.next_follow_up ? <div className="muted">Next: {fmtDate(f.next_follow_up)}</div> : null}
                        </li>
                      ))}
                    </ol>
                  )}
                </Panel>

                <Panel title="Stage history" count={e.stage_history.length} id="hist">
                  {e.stage_history.length === 0 ? (
                    <EmptyState title="No stage changes recorded" />
                  ) : (
                    <ol className="timeline">
                      {e.stage_history.map((h) => (
                        <li key={h.id} data-kind="stage">
                          <div className="when">{fmtDateTime(h.changed_at)} · {h.changed_by_name ?? 'System'}</div>
                          <div>{h.from_stage ? <>{h.from_stage} → <b>{h.to_stage}</b></> : <>Created as <b>{h.to_stage}</b></>}</div>
                          {h.remarks ? <div className="muted prewrap">{h.remarks}</div> : null}
                        </li>
                      ))}
                    </ol>
                  )}
                </Panel>

                {e.competitors.length > 0 ? (
                  <Panel title="Competitors" count={e.competitors.length} flush id="comp">
                    <div className="table-wrap">
                      <table className="t">
                        <thead><tr><th>Competitor</th><th className="num">Known price</th></tr></thead>
                        <tbody>
                          {e.competitors.map((c) => (
                            <tr key={c.id}><td>{c.competitor}{c.notes ? <span className="sub">{c.notes}</span> : null}</td><td className="num">{isNum(c.known_price) ? fmtMoney(c.known_price, c.currency, true) : null}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Panel>
                ) : null}
              </div>
            </div>

            {dlg === 'proc' ? <RaiseProcurement enq={e} onClose={() => setDlg(null)} onDone={() => { toast.push('ok', 'Procurement request raised. Its SLA clock has started.'); done(); }} /> : null}
            {dlg === 'est' ? <RaiseEstimation enq={e} onClose={() => setDlg(null)} onDone={() => { toast.push('ok', 'Estimation request raised. Its SLA clock has started.'); done(); }} /> : null}
            {dlg === 'follow' ? <LogFollowUp enq={e} onClose={() => setDlg(null)} onDone={() => { toast.push('ok', 'Follow-up saved.'); done(); }} /> : null}
            {dlg === 'stage' ? <StageDialog enquiry={e} onClose={() => setDlg(null)} onChanged={() => { toast.push('ok', 'Stage changed.'); void reload(); }} /> : null}
            {blocked ? <MessageDialog title="That could not be done" message={blocked} onClose={() => setBlocked(null)} /> : null}
          </>
        );
      }}
    </DataView>
  );
}
