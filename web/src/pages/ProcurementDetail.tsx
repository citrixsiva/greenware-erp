import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, type One, UserError } from '../lib/api';
import { useAuth, useCan } from '../lib/auth';
import { dubaiToday, fmtDate, fmtDateTime, fmtDec, fmtMoney, isNum } from '../lib/format';
import { useSuppliers } from '../lib/hooks';
import type { Comparison, Offer, ProcDetail, SupplierQuote } from '../lib/types';
import { FormDialog, MessageDialog } from '../components/Dialog';
import { useToast } from '../components/Toast';
import { Chip, DataView, EmptyState, Field, Kpi, LoadingState, PageHead, Panel, PlusIcon, SlaPill, StatusPill, UrgencyChip } from '../components/ui';

type Dlg = null | { kind: 'quote' } | { kind: 'rfq' } | { kind: 'cancel' } | { kind: 'recommend'; quote: SupplierQuote };

/* ---------- supplier quote form ---------- */

function QuoteForm({ req, onClose, onDone }: { req: ProcDetail; onClose: () => void; onDone: () => void }) {
  const sup = useSuppliers();
  const [supplierId, setSupplierId] = useState('');
  const [ref, setRef] = useState('');
  const [quoteDate, setQuoteDate] = useState(dubaiToday());
  const [validUntil, setValidUntil] = useState('');
  const [currency, setCurrency] = useState('AED');
  const [fx, setFx] = useState('');
  const [terms, setTerms] = useState('');
  const [remarks, setRemarks] = useState('');
  const [rows, setRows] = useState(req.lines.map((l) => ({ id: l.id, qty: String(l.quantity), cost: '', avail: '', lead: '' })));
  const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <FormDialog
      wide
      title={`Record supplier quote for ${req.request_no}`}
      submitLabel="Record quote"
      onClose={onClose}
      onSubmit={async () => {
        if (!supplierId) throw new UserError('Choose the supplier that sent this quotation.');
        const lines = rows
          .map((r, i) => ({ r, line: req.lines[i] }))
          .filter(({ r }) => r.cost.trim() !== '')
          .map(({ r, line }) => ({
            requestLineId: line.id,
            quantity: Number(r.qty),
            unitCost: Number(r.cost),
            availability: r.avail.trim() || undefined,
            leadTimeDays: r.lead.trim() === '' ? undefined : Number(r.lead),
          }));
        if (!lines.length) throw new UserError('Enter a unit cost for at least one line.');
        if (lines.some((l) => !Number.isFinite(l.unitCost) || l.unitCost < 0)) throw new UserError('Unit costs must be numbers, zero or more.');
        await api.post(`/procurement/requests/${req.id}/supplier-quotes`, {
          supplierId,
          supplierRef: ref.trim() || undefined,
          quoteDate: quoteDate || undefined,
          validUntil: validUntil || undefined,
          currency,
          fxRate: currency !== 'AED' && fx.trim() ? Number(fx) : undefined,
          paymentTermsDays: terms.trim() === '' ? undefined : Number(terms),
          remarks: remarks.trim() || undefined,
          lines,
        });
        onDone();
      }}
    >
      <div className="form-grid">
        <Field label="Supplier" required>
          {(p) => (
            <select
              {...p}
              className="select"
              value={supplierId}
              onChange={(e) => {
                setSupplierId(e.target.value);
                const s = sup.data?.find((x) => x.id === e.target.value);
                if (s?.default_currency) setCurrency(s.default_currency.trim());
              }}
            >
              <option value="">{sup.isPending ? 'Loading suppliers…' : 'Choose a supplier…'}</option>
              {sup.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
        </Field>
        <Field label="Supplier reference">{(p) => <input {...p} className="input" value={ref} onChange={(e) => setRef(e.target.value)} />}</Field>
        <Field label="Quote date">{(p) => <input {...p} className="input" type="date" value={quoteDate} onChange={(e) => setQuoteDate(e.target.value)} />}</Field>
        <Field label="Valid until">{(p) => <input {...p} className="input" type="date" min={quoteDate} value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />}</Field>
        <Field label="Currency">
          {(p) => (
            <select {...p} className="select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {['AED', 'USD', 'EUR', 'INR'].map((c) => <option key={c}>{c}</option>)}
            </select>
          )}
        </Field>
        {currency !== 'AED' ? (
          <Field label={`Rate to AED`} hint="Leave empty to use the latest rate on file.">
            {(p) => <input {...p} className="input input--num" inputMode="decimal" value={fx} onChange={(e) => setFx(e.target.value)} />}
          </Field>
        ) : null}
        <Field label="Payment terms (days)">{(p) => <input {...p} className="input input--num" inputMode="numeric" value={terms} onChange={(e) => setTerms(e.target.value)} />}</Field>
      </div>

      <div className="table-wrap">
        <table className="t">
          <thead><tr><th>Request line</th><th className="num">Qty</th><th className="num">Unit cost ({currency})</th><th>Availability</th><th className="num">Lead (days)</th></tr></thead>
          <tbody>
            {req.lines.map((l, i) => (
              <tr key={l.id}>
                <td className="wrap">{l.part_number ? <span className="id">{l.part_number}</span> : null}<span className="sub" style={{ color: 'var(--ink)' }}>{l.description}</span></td>
                <td><input className="input input--cell input--num w-sm" aria-label={`Quantity, ${l.description}`} inputMode="decimal" value={rows[i].qty} onChange={(e) => set(i, { qty: e.target.value })} /></td>
                <td><input className="input input--cell input--num" aria-label={`Unit cost, ${l.description}`} inputMode="decimal" value={rows[i].cost} onChange={(e) => set(i, { cost: e.target.value })} /></td>
                <td><input className="input input--cell" aria-label={`Availability, ${l.description}`} placeholder="In stock" value={rows[i].avail} onChange={(e) => set(i, { avail: e.target.value })} /></td>
                <td><input className="input input--cell input--num w-sm" aria-label={`Lead time, ${l.description}`} inputMode="numeric" value={rows[i].lead} onChange={(e) => set(i, { lead: e.target.value })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Field label="Remarks">{(p) => <textarea {...p} className="textarea" value={remarks} onChange={(e) => setRemarks(e.target.value)} />}</Field>
    </FormDialog>
  );
}

function RfqDialog({ req, onClose, onDone }: { req: ProcDetail; onClose: () => void; onDone: () => void }) {
  const sup = useSuppliers();
  const [picked, setPicked] = useState<string[]>([]);
  const [reference, setReference] = useState('');
  return (
    <FormDialog
      title="Waiting on suppliers"
      submitLabel="Pause the SLA clock"
      onClose={onClose}
      onSubmit={async () => {
        await api.post(`/procurement/requests/${req.id}/status`, { status: 'AwaitingSupplier', rfq: { supplierIds: picked, reference: reference.trim() || undefined } });
        onDone();
      }}
    >
      <p className="muted">The SLA clock pauses only while an RFQ is genuinely open with a supplier. Say who it went to.</p>
      <Field label="Suppliers the RFQ went to" required>
        {() => (
          <div className="stack" style={{ gap: 6, maxHeight: 220, overflow: 'auto' }}>
            {sup.isPending ? <LoadingState /> : sup.data?.length ? sup.data.map((s) => (
              <label key={s.id} className="check">
                <input type="checkbox" checked={picked.includes(s.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, s.id] : picked.filter((x) => x !== s.id))} />
                {s.name}
              </label>
            )) : <span className="muted">No suppliers are set up yet.</span>}
          </div>
        )}
      </Field>
      <Field label="RFQ reference">{(p) => <input {...p} className="input" value={reference} onChange={(e) => setReference(e.target.value)} />}</Field>
    </FormDialog>
  );
}

function ReasonDialog({ title, label, submit, danger, minLen = 0, onClose, run }: { title: string; label: string; submit: string; danger?: boolean; minLen?: number; onClose: () => void; run: (text: string) => Promise<void> }) {
  const [text, setText] = useState('');
  return (
    <FormDialog
      title={title}
      submitLabel={submit}
      danger={danger}
      onClose={onClose}
      onSubmit={async () => {
        if (text.trim().length < minLen) throw new UserError(`Write at least ${minLen} characters.`);
        await run(text.trim());
      }}
    >
      <Field label={label} required={minLen > 0}>{(p) => <textarea {...p} className="textarea" autoFocus value={text} onChange={(e) => setText(e.target.value)} />}</Field>
    </FormDialog>
  );
}

/* ---------- comparison grid ---------- */

function Delta({ pct }: { pct: number }) {
  const tone = pct <= 0 ? 'ok' : pct > 10 ? 'crit' : 'warn';
  const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '=';
  return <Chip tone={tone} mono title="Change against the most recent purchase of this part">{arrow} {pct > 0 ? '+' : ''}{fmtDec(pct, 1)}%</Chip>;
}

function OfferRows({ offers, lowest }: { offers: Offer[]; lowest: string | null }) {
  const hasCost = offers.some((o) => o.unit_cost !== undefined);
  const hasBase = offers.some((o) => o.unit_cost_base !== undefined);
  const hasDelta = offers.some((o) => o.delta_pct_vs_last_purchase !== undefined);
  return (
    <div className="table-wrap">
      <table className="t">
        <thead>
          <tr>
            <th>Supplier</th>
            {hasCost ? <th className="num">Unit cost</th> : null}
            {hasBase ? <th className="num">In AED</th> : null}
            <th className="num">Lead time</th><th>Availability</th><th>Valid until</th>
            <th>Last purchase</th>
            {hasDelta ? <th className="num">Δ vs last purchase</th> : null}
          </tr>
        </thead>
        <tbody>
          {offers.map((o) => (
            <tr key={o.quote_id} className={o.quote_id === lowest ? 'is-selected' : undefined}>
              <td>
                {o.supplier_name} <span className="id muted">{o.quote_no}</span>
                <span className="sub tag-list" style={{ marginTop: 2 }}>
                  {o.is_recommended ? <Chip tone="accent">Recommended</Chip> : null}
                  {o.quote_id === lowest ? <Chip tone="ok">Lowest</Chip> : null}
                </span>
              </td>
              {hasCost ? <td className="num">{isNum(o.unit_cost) ? fmtMoney(o.unit_cost, o.currency) : null}</td> : null}
              {hasBase ? <td className="num">{isNum(o.unit_cost_base) ? fmtMoney(o.unit_cost_base, 'AED') : null}</td> : null}
              <td className="num">{isNum(o.lead_time_days) ? `${o.lead_time_days} d` : <span className="muted">Not given</span>}</td>
              <td>{o.availability ?? <span className="muted">Not given</span>}</td>
              <td className="nowrap">{o.valid_until ? fmtDate(o.valid_until) : <span className="muted">Not given</span>}</td>
              <td>
                {o.last_purchase ? (
                  <>
                    {isNum(o.last_purchase.unit_cost) ? <span className="mono">{fmtMoney(o.last_purchase.unit_cost, o.last_purchase.currency)}</span> : null}
                    <span className="sub">{o.last_purchase.supplier_name} · {fmtDate(o.last_purchase.quoted_on)}</span>
                  </>
                ) : (
                  <span className="muted">No earlier purchase on file</span>
                )}
              </td>
              {hasDelta ? <td className="num">{isNum(o.delta_pct_vs_last_purchase) ? <Delta pct={Number(o.delta_pct_vs_last_purchase)} /> : null}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ComparisonGrid({ id, quoteCount }: { id: string; quoteCount: number }) {
  const q = useQuery({ queryKey: ['comparison', id, quoteCount], queryFn: async () => (await api.get<One<Comparison>>(`/procurement/requests/${id}/comparison`)).data });
  return (
    <Panel title="Supplier comparison" id="cmp" flush>
      <DataView query={q} label="Building the comparison" isEmpty={(d) => d.lines.every((l) => l.offers.length === 0) && d.other_offers.length === 0} empty={<EmptyState title="Nothing to compare yet" hint="Record a supplier quote and it will appear here, line by line, against the last purchase price." />}>
        {(d) => (
          <div className="stack--lg stack" style={{ padding: 0 }}>
            {d.lines.filter((l) => l.offers.length).map((l) => (
              <div key={l.request_line_id}>
                <div className="row" style={{ padding: '8px 12px', background: 'var(--surface-2)', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)' }}>
                  {l.part_number ? <span className="id"><b>{l.part_number}</b></span> : null}
                  <span>{l.description}</span>
                  <span className="muted right">Qty <span className="mono">{fmtDec(l.quantity, 0)}</span></span>
                </div>
                <OfferRows offers={l.offers} lowest={l.lowest_quote_id} />
              </div>
            ))}
            {d.other_offers.length ? (
              <div>
                <div className="row" style={{ padding: '8px 12px', background: 'var(--surface-2)', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)' }}>
                  <b>Quoted lines that answer no request line</b><span className="muted">alternates and add-ons</span>
                </div>
                <OfferRows offers={d.other_offers} lowest={null} />
              </div>
            ) : null}
          </div>
        )}
      </DataView>
    </Panel>
  );
}

/* ---------- page ---------- */

export default function ProcurementDetail() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const canEdit = useCan('procurement_requests.edit');
  const canQuote = useCan('supplier_quotes.create');
  const canRecommend = useCan('supplier_quotes.edit');
  const [dlg, setDlg] = useState<Dlg>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const q = useQuery({ queryKey: ['proc', id], queryFn: async () => (await api.get<One<ProcDetail>>(`/procurement/requests/${id}`)).data });
  const reload = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['proc', id] }),
      qc.invalidateQueries({ queryKey: ['comparison', id] }),
      qc.invalidateQueries({ queryKey: ['proc-by-enq'] }),
      qc.invalidateQueries({ queryKey: ['sla'] }),
    ]);
  };
  async function direct(fn: () => Promise<unknown>, okText: string) {
    setBusy(true);
    try {
      await fn();
      toast.push('ok', okText);
      await reload();
    } catch (e) {
      setBlocked(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <DataView query={q} label="Loading the request">
      {(r) => {
        const closed = r.status === 'Responded' || r.status === 'Cancelled';
        const mine = r.assigned_to === user?.id;
        return (
          <>
            <PageHead
              crumbs={<><Link to="/procurement">Procurement</Link><span>/</span><span className="mono">{r.request_no}</span></>}
              title={<span className="id">{r.request_no}</span>}
              sub={<><SlaPill state={r.sla_state} clock={r.sla_clock} elapsed={r.elapsed_working_hours} target={r.target_hours} /> <StatusPill value={r.status} /> <span className="muted"> · <Link to={`/enquiries/${r.enquiry_id}`}>{r.enquiry_no}</Link> · {r.customer_name}</span></>}
              actions={
                <>
                  {canEdit && !closed && !mine ? (
                    <button type="button" className="btn" disabled={busy} onClick={() => void direct(() => api.patch(`/procurement/requests/${id}/assign`, { assignedTo: user!.id }), 'Assigned to you.')}>Assign to me</button>
                  ) : null}
                  {canEdit && r.status === 'Assigned' ? (
                    <button type="button" className="btn" disabled={busy} onClick={() => void direct(() => api.post(`/procurement/requests/${id}/status`, { status: 'Sourcing' }), 'Sourcing started.')}>Start sourcing</button>
                  ) : null}
                  {canEdit && r.status === 'Sourcing' ? <button type="button" className="btn" onClick={() => setDlg({ kind: 'rfq' })}>Waiting on suppliers</button> : null}
                  {canEdit && r.status === 'AwaitingSupplier' ? (
                    <button type="button" className="btn" disabled={busy} onClick={() => void direct(() => api.post(`/procurement/requests/${id}/status`, { status: 'Sourcing' }), 'Back to sourcing. The SLA clock is running again.')}>Resume sourcing</button>
                  ) : null}
                  {canQuote && r.status !== 'Cancelled' ? <button type="button" className="btn btn--primary" onClick={() => setDlg({ kind: 'quote' })}><PlusIcon /> Record supplier quote</button> : null}
                  {canEdit && !closed ? <button type="button" className="btn btn--danger" onClick={() => setDlg({ kind: 'cancel' })}>Cancel request</button> : null}
                </>
              }
            />

            <div className="kpis">
              <Kpi label="Elapsed" value={`${fmtDec(r.elapsed_working_hours, 1)} h`} sub={isNum(r.target_hours) ? `of ${fmtDec(r.target_hours, 0)} h target` : 'No target set'} />
              <Kpi label="Urgency" value={<UrgencyChip urgency={r.urgency} />} />
              <Kpi label="Assigned to" value={r.assigned_to_name ?? <span className="muted">Unassigned</span>} />
              <Kpi label="Needed by" value={r.required_by ? fmtDate(r.required_by) : <span className="muted">Not set</span>} />
              <Kpi label="Raised" value={<span style={{ fontSize: 13 }}>{fmtDateTime(r.raised_at)}</span>} sub={r.requested_by_name ? `by ${r.requested_by_name}` : undefined} />
            </div>

            {r.sla_clock === 'paused' && r.open_rfq ? (
              <div className="notice notice--info" role="status">
                <span>The clock is paused while an RFQ is open{r.open_rfq.suppliers?.length ? ` with ${r.open_rfq.suppliers.map((s) => s.name).join(', ')}` : ''}{r.open_rfq.reference ? ` (ref ${r.open_rfq.reference})` : ''}.</span>
              </div>
            ) : null}
            {r.remarks ? <div className="notice notice--info"><span className="prewrap">{r.remarks}</span></div> : null}

            <Panel title="Lines to source" count={r.lines.length} flush id="lines">
              {r.lines.length === 0 ? <EmptyState title="No lines on this request" /> : (
                <div className="table-wrap">
                  <table className="t">
                    <thead><tr><th className="num">Enq. line</th><th>Part number</th><th>Manufacturer</th><th>Description</th><th className="num">Qty</th></tr></thead>
                    <tbody>
                      {r.lines.map((l) => (
                        <tr key={l.id}>
                          <td className="num">{l.enquiry_line_no ?? ''}</td>
                          <td className="id">{l.part_number}</td>
                          <td>{l.manufacturer_name}</td>
                          <td className="wrap">{l.description}</td>
                          <td className="num">{fmtDec(l.quantity, 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>

            {r.supplier_quotes ? (
              <Panel title="Supplier quotes" count={r.supplier_quotes.length} flush id="sq">
                {r.supplier_quotes.length === 0 ? (
                  <EmptyState title="No supplier quote recorded" hint={r.status === 'Raised' ? 'Assign the request to a buyer first, then record the quotes as they arrive.' : 'Record the first quote to stop the SLA clock and open the comparison.'} />
                ) : (
                  <div className="table-wrap">
                    <table className="t">
                      <thead>
                        <tr>
                          <th>Quote</th><th>Supplier</th><th>Quoted</th><th>Valid until</th>
                          {r.supplier_quotes.some((s) => s.payment_terms_days !== undefined) ? <th className="num">Terms</th> : null}
                          <th className="num">Lines</th><th>Recommendation</th>
                        </tr>
                      </thead>
                      <tbody>
                        {r.supplier_quotes.map((s) => (
                          <tr key={s.id}>
                            <td className="id">{s.quote_no}{s.supplier_ref ? <span className="sub">{s.supplier_ref}</span> : null}</td>
                            <td>{s.supplier_name}</td>
                            <td className="nowrap">{fmtDate(s.quote_date)}</td>
                            <td className="nowrap">{s.valid_until ? fmtDate(s.valid_until) : <span className="muted">Not given</span>}</td>
                            {r.supplier_quotes!.some((x) => x.payment_terms_days !== undefined) ? <td className="num">{isNum(s.payment_terms_days) ? `${s.payment_terms_days} d` : null}</td> : null}
                            <td className="num">{s.lines.length}</td>
                            <td className="wrap">
                              {s.is_recommended ? <><Chip tone="accent">Recommended</Chip><span className="sub">{s.recommendation_reason}</span></> : canRecommend ? <button type="button" className="btn btn--sm" onClick={() => setDlg({ kind: 'recommend', quote: s })}>Recommend</button> : null}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            ) : null}

            {r.supplier_quotes ? <ComparisonGrid id={id} quoteCount={r.supplier_quotes.length} /> : null}

            {dlg?.kind === 'quote' ? <QuoteForm req={r} onClose={() => setDlg(null)} onDone={() => { toast.push('ok', 'Supplier quote recorded.'); void reload(); }} /> : null}
            {dlg?.kind === 'rfq' ? <RfqDialog req={r} onClose={() => setDlg(null)} onDone={() => { toast.push('ok', 'RFQ logged. The SLA clock is paused.'); void reload(); }} /> : null}
            {dlg?.kind === 'cancel' ? (
              <ReasonDialog title={`Cancel ${r.request_no}`} label="Why is this request being cancelled?" submit="Cancel request" danger onClose={() => setDlg(null)}
                run={async (t) => { await api.post(`/procurement/requests/${id}/status`, { status: 'Cancelled', remarks: t || undefined }); toast.push('ok', 'Request cancelled.'); void reload(); }} />
            ) : null}
            {dlg?.kind === 'recommend' ? (
              <ReasonDialog title={`Recommend ${dlg.quote.supplier_name}`} label="Why this supplier? (price, lead time, terms, risk)" submit="Recommend" minLen={5} onClose={() => setDlg(null)}
                run={async (t) => { await api.post(`/supplier-quotes/${dlg.quote.id}/recommend`, { reason: t }); toast.push('ok', 'Recommendation saved.'); void reload(); }} />
            ) : null}
            {blocked ? <MessageDialog title="That could not be done" message={blocked} onClose={() => setBlocked(null)} /> : null}
          </>
        );
      }}
    </DataView>
  );
}
