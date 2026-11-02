import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, downloadFile, errorMessage, openDocument, type One, UserError } from '../lib/api';
import { useCan, useSeesField } from '../lib/auth';
import { fmtDate, fmtDateTime, fmtDec, fmtMoney, fmtPct, humanize, isNum } from '../lib/format';
import { useBootstrap } from '../lib/hooks';
import type { MarginInfo, QuotationDetail, QuoteLineRow, QuoteVersion } from '../lib/types';
import { FormDialog, MessageDialog } from '../components/Dialog';
import { useToast } from '../components/Toast';
import {
  Chip, DataView, EmptyState, Field, Kpi, Masked, Notice, PageHead, Panel, PlusIcon, StatusPill,
} from '../components/ui';

/** Only a Draft may be changed; everything else is history (OD: a version that has left Draft is frozen). */
const isDraft = (v: QuoteVersion) => v.status === 'Draft';

type Dlg =
  | null
  | { kind: 'line'; line: QuoteLineRow | null }
  | { kind: 'remove'; line: QuoteLineRow }
  | { kind: 'terms' }
  | { kind: 'split' }
  | { kind: 'exception'; message: string };

/* ───────────────────────── the margin gate ───────────────────────── */

/**
 * Where the quoted margin sits against the two thresholds that decide what submitting does:
 * the business type's warn level (below it an approval chain is raised) and the hard floor
 * (below it the server refuses the submission outright).
 */
function MarginGate({ pct, floor, warn, draft }: { pct: number | null; floor: number; warn: number; draft: boolean }) {
  if (pct === null) {
    return <Notice tone="warn">This version totals zero, so no margin can be worked out yet. Price the lines before submitting.</Notice>;
  }
  const top = Math.max(Math.ceil(Math.max(warn, floor, pct) * 1.35), 20);
  const at = (v: number) => `${Math.min(100, Math.max(0, (v / top) * 100))}%`;
  const below = pct < floor;
  const needsApproval = !below && pct < warn;
  const tone = below ? 'crit' : needsApproval ? 'warn' : 'ok';

  return (
    <div className="stack" style={{ gap: 'var(--s2)' }}>
      <div className="row" style={{ alignItems: 'baseline' }}>
        <span className="margin-big" style={{ color: `var(--${tone}-ink)` }}>{fmtPct(pct, 2)}</span>
        <span className="muted">gross margin</span>
        <span className="right">
          <Chip tone={tone}>{below ? 'Below the floor' : needsApproval ? 'Needs approval' : 'Clear to submit'}</Chip>
        </span>
      </div>

      <div
        className="meter"
        role="img"
        aria-label={`Gross margin ${fmtPct(pct, 2)}. Hard floor ${fmtPct(floor, 1)}. Approval threshold ${fmtPct(warn, 1)}.`}
      >
        <div className="meter__zone meter__zone--crit" style={{ left: 0, width: at(floor) }} />
        <div className="meter__zone meter__zone--warn" style={{ left: at(floor), width: at(Math.max(warn - floor, 0)) }} />
        <div className="meter__zone meter__zone--ok" style={{ left: at(warn), right: 0 }} />
        <div className="meter__mark" style={{ left: at(pct) }} title={`Quoted margin ${fmtPct(pct, 2)}`} />
      </div>
      <div className="meter-scale" aria-hidden="true">
        <span>0%</span>
        <span style={{ left: at(floor) }}>floor {fmtDec(floor, 0)}%</span>
        <span style={{ left: at(warn) }}>approval {fmtDec(warn, 0)}%</span>
        <span className="edge-r" style={{ left: '100%' }}>{fmtDec(top, 0)}%</span>
      </div>

      {below ? (
        <Notice tone="crit" title="Below the hard floor.">
          {draft
            ? `At ${fmtPct(pct, 2)} this is under the ${fmtPct(floor, 1)} floor, so the server will refuse the submission. Raise the prices, or submit and ask a director for a written exception.`
            : `This version is at ${fmtPct(pct, 2)}, under the ${fmtPct(floor, 1)} floor, so it needs a director's written exception to go out.`}
        </Notice>
      ) : needsApproval ? (
        <Notice tone="warn" title={draft ? 'Submitting will need approval.' : 'Under the approval threshold.'}>
          {draft
            ? `${fmtPct(pct, 2)} is under the ${fmtPct(warn, 1)} threshold for this business type. Submitting raises an approval chain; the quotation does not go to the customer until a director approves it.`
            : `${fmtPct(pct, 2)} is under the ${fmtPct(warn, 1)} threshold for this business type, so this version needs a director's approval before it goes out.`}
        </Notice>
      ) : (
        <Notice tone="ok" title="Clear of both thresholds.">
          {draft
            ? `${fmtPct(pct, 2)} is at or above the ${fmtPct(warn, 1)} threshold, so submitting sends this version straight out.`
            : `${fmtPct(pct, 2)} is at or above the ${fmtPct(warn, 1)} threshold for this business type.`}
        </Notice>
      )}
    </div>
  );
}

function MarginPanel({ versionId, currency, draft, onSplit, canSplit }: {
  versionId: string; currency: string; draft: boolean; canSplit: boolean; onSplit: () => void;
}) {
  const q = useQuery({
    queryKey: ['quote-margin', versionId],
    queryFn: async () => (await api.get<One<MarginInfo>>(`/quotation-versions/${versionId}/margin`)).data,
  });
  return (
    <Panel
      title="Margin"
      id="margin"
      actions={canSplit ? <button type="button" className="btn btn--sm" onClick={onSplit}>Ask for a different split</button> : null}
    >
      <DataView query={q} label="Working out the margin">
        {(m) => {
          const pct = isNum(m.totals.grossMarginPct) ? Number(m.totals.grossMarginPct) : null;
          const floor = m.rule.minMarginPct;
          const warn = Math.max(m.rule.warnMarginPct ?? floor, floor);
          const ov = m.override;
          return (
            <div className="stack">
              <MarginGate pct={pct} floor={floor} warn={warn} draft={draft} />

              <div className="table-wrap">
                <table className="t">
                  <thead>
                    <tr><th>Gross profit goes to</th><th className="num">Share</th><th className="num">Amount</th></tr>
                  </thead>
                  <tbody>
                    <tr><td>Sales</td><td className="num">{fmtPct(ov?.applied ? ov.salesSharePct : m.rule.salesSharePct, 0)}</td><td className="num">{fmtMoney(m.attribution.sales, currency)}</td></tr>
                    <tr><td>Technical</td><td className="num">{fmtPct(ov?.applied ? ov.technicalSharePct : m.rule.technicalSharePct, 0)}</td><td className="num">{fmtMoney(m.attribution.technical, currency)}</td></tr>
                    <tr><td>Company</td><td className="num">{fmtPct(ov?.applied ? ov.companySharePct : m.rule.companySharePct, 0)}</td><td className="num">{fmtMoney(m.attribution.company, currency)}</td></tr>
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>Gross profit</td>
                      <td className="num">{m.attributionSource === 'override' ? 'exception' : 'standard rule'}</td>
                      <td className="num">{isNum(m.totals.grossProfit) ? fmtMoney(m.totals.grossProfit, currency) : <Masked what="Gross profit" />}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {ov ? (
                <Notice tone={ov.applied ? 'ok' : 'info'} title={ov.applied ? 'Exception in force.' : `Exception ${ov.approvalStatus ?? 'pending'}.`}>
                  {`${fmtDec(ov.salesSharePct, 0)} / ${fmtDec(ov.technicalSharePct, 0)} / ${fmtDec(ov.companySharePct, 0)} — ${ov.reason}`}
                  {ov.applied ? '' : ' The standard rule applies until it is approved.'}
                </Notice>
              ) : null}
            </div>
          );
        }}
      </DataView>
    </Panel>
  );
}

/* ───────────────────────── line editor ───────────────────────── */

interface LineForm { description: string; partNumber: string; quantity: string; unitPrice: string; discountPct: string; unitCost: string; taxCodeId: string }

const toForm = (l: QuoteLineRow | null): LineForm => ({
  description: l?.description ?? '',
  partNumber: l?.part_number ?? '',
  quantity: l ? String(l.quantity) : '1',
  unitPrice: isNum(l?.unit_price) ? String(l!.unit_price) : '',
  discountPct: isNum(l?.discount_pct) ? String(l!.discount_pct) : '0',
  unitCost: isNum(l?.unit_cost) ? String(l!.unit_cost) : '',
  taxCodeId: l?.tax_code_id ?? '',
});

/** A line whose cost was copied from a supplier quote or an estimate: the cost cannot be typed over. */
const derivedFrom = (l: QuoteLineRow | null): string | null => {
  if (!l) return null;
  if (l.supplier_quote_line_id) return 'a supplier quote line';
  if (l.technical_estimate_id) return 'a technical estimate';
  return null;
};

function LineDialog({ versionId, line, currency, onClose, onDone }: {
  versionId: string; line: QuoteLineRow | null; currency: string; onClose: () => void; onDone: () => void;
}) {
  const boot = useBootstrap();
  const seesCost = useSeesField('supplier_cost');
  const seesSell = useSeesField('sell_price');
  const [f, setF] = useState<LineForm>(() => toForm(line));
  const [taxTouched, setTaxTouched] = useState(false);
  const set = (patch: Partial<LineForm>) => setF((x) => ({ ...x, ...patch }));
  const derived = derivedFrom(line);
  // A new line starts on the standard rate, which is what the server would pick anyway.
  const defaultTax = boot.data?.tax_codes.find((t) => t.code === 'VAT5')?.id ?? '';
  const taxCodeId = line || taxTouched ? f.taxCodeId : f.taxCodeId || defaultTax;

  return (
    <FormDialog
      wide
      title={line ? `Line ${line.line_no}` : 'Add a line'}
      submitLabel={line ? 'Save line' : 'Add line'}
      onClose={onClose}
      onSubmit={async () => {
        const num = (s: string, what: string) => {
          const n = Number(s);
          if (s.trim() === '' || !Number.isFinite(n)) throw new UserError(`${what} must be a number.`);
          return n;
        };
        if (!f.description.trim()) throw new UserError('Every line needs a description.');
        const qty = num(f.quantity, 'Quantity');
        if (qty <= 0) throw new UserError('Quantity must be more than zero.');

        const body: Record<string, unknown> = {
          description: f.description.trim(),
          partNumber: f.partNumber.trim() || null,
          quantity: qty,
          taxCodeId: taxCodeId || null,
        };
        if (seesSell) {
          const price = num(f.unitPrice, 'Unit price');
          if (price < 0) throw new UserError('The unit price cannot be negative.');
          const disc = num(f.discountPct || '0', 'Discount');
          if (disc < 0 || disc > 100) throw new UserError('The discount must be between 0 and 100 percent.');
          body.unitPrice = price;
          body.discountPct = disc;
        }
        // Cost is never sent for a derived line: the server copies it from the source and refuses an override.
        if (seesCost && !derived) {
          const cost = num(f.unitCost || '0', 'Unit cost');
          if (cost < 0) throw new UserError('The unit cost cannot be negative.');
          body.unitCost = cost;
        }
        if (line) await api.patch(`/quotation-lines/${line.id}`, body);
        else await api.post(`/quotation-versions/${versionId}/lines`, body);
        onDone();
      }}
    >
      <div className="form-grid">
        <Field label="Description" required className="span-all">
          {(p) => <input {...p} className="input" value={f.description} onChange={(e) => set({ description: e.target.value })} />}
        </Field>
        <Field label="Part number">{(p) => <input {...p} className="input" value={f.partNumber} onChange={(e) => set({ partNumber: e.target.value })} />}</Field>
        <Field label="Quantity" required>{(p) => <input {...p} className="input input--num" inputMode="decimal" value={f.quantity} onChange={(e) => set({ quantity: e.target.value })} />}</Field>
        {seesSell ? (
          <>
            <Field label={`Unit price (${currency})`} required>
              {(p) => <input {...p} className="input input--num" inputMode="decimal" value={f.unitPrice} onChange={(e) => set({ unitPrice: e.target.value })} />}
            </Field>
            <Field label="Discount %">
              {(p) => <input {...p} className="input input--num" inputMode="decimal" value={f.discountPct} onChange={(e) => set({ discountPct: e.target.value })} />}
            </Field>
          </>
        ) : null}
        {seesCost ? (
          <Field
            label={`Unit cost (${currency})`}
            hint={derived ? `Copied from ${derived}. Unlink the line to price it by hand.` : 'From the supplier quote, or typed in for a line with no quote behind it.'}
          >
            {(p) => <input {...p} className="input input--num" inputMode="decimal" disabled={!!derived} value={f.unitCost} onChange={(e) => set({ unitCost: e.target.value })} />}
          </Field>
        ) : null}
        <Field label="Tax code">
          {(p) => (
            <select {...p} className="select" value={taxCodeId} onChange={(e) => { setTaxTouched(true); set({ taxCodeId: e.target.value }); }}>
              <option value="">No tax code</option>
              {boot.data?.tax_codes.map((t) => <option key={t.id} value={t.id}>{t.code} · {t.description}</option>)}
            </select>
          )}
        </Field>
      </div>
      {!seesSell ? <p className="muted">Prices are not visible to your role, so this line keeps the price it already has.</p> : null}
    </FormDialog>
  );
}

function LinesPanel({ version, editable, currency, onEdit, onRemove, onAdd }: {
  version: QuoteVersion; editable: boolean; currency: string;
  onEdit: (l: QuoteLineRow) => void; onRemove: (l: QuoteLineRow) => void; onAdd: () => void;
}) {
  const lines = version.lines;
  // A column exists only when the server sent that field for at least one line.
  const showCost = lines.some((l) => l.unit_cost !== undefined);
  const showPrice = lines.some((l) => l.unit_price !== undefined);
  const showGp = lines.some((l) => l.line_gp !== undefined);

  return (
    <Panel
      title={`Lines, version ${version.version_no}`}
      count={lines.length}
      flush
      id="lines"
      actions={editable ? <button type="button" className="btn btn--sm" onClick={onAdd}><PlusIcon /> Add line</button> : null}
    >
      {lines.length === 0 ? (
        <EmptyState
          title="This version has no lines"
          hint={editable ? 'Add the first line, or go back to the enquiry and build a quotation from the supplier quotes already on file.' : 'Nothing was priced on this version.'}
        />
      ) : (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Part number</th>
                <th>Description</th>
                <th className="num">Qty</th>
                {showCost ? <th className="num">Unit cost</th> : null}
                {showPrice ? <th className="num">Unit price</th> : null}
                {showPrice ? <th className="num">Disc.</th> : null}
                <th>Tax</th>
                {showPrice ? <th className="num">Line total</th> : null}
                {showGp ? <th className="num">GP</th> : null}
                {editable ? <th><span className="sr-only">Actions</span></th> : null}
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const src = derivedFrom(l);
                return (
                  <tr key={l.id}>
                    <td className="num">{l.line_no}</td>
                    <td className="id">{l.part_number ?? <span className="muted">None</span>}</td>
                    <td className="wrap">
                      {l.description}
                      {src ? <span className="sub">cost from {src}</span> : null}
                    </td>
                    <td className="num">{fmtDec(l.quantity, 0)}</td>
                    {showCost ? <td className="num">{isNum(l.unit_cost) ? fmtMoney(l.unit_cost, currency) : <Masked what="Supplier cost" />}</td> : null}
                    {showPrice ? <td className="num">{isNum(l.unit_price) ? fmtMoney(l.unit_price, currency) : <Masked what="The selling price" />}</td> : null}
                    {showPrice ? <td className="num">{isNum(l.discount_pct) ? fmtPct(l.discount_pct, 1) : <Masked what="The discount" />}</td> : null}
                    <td>{l.tax_code ? <Chip mono title={isNum(l.tax_rate_pct) ? `${fmtDec(l.tax_rate_pct, 0)}%` : undefined}>{l.tax_code}</Chip> : <span className="muted">None</span>}</td>
                    {showPrice ? <td className="num">{isNum(l.line_sell) ? fmtMoney(l.line_sell, currency) : <Masked what="The line total" />}</td> : null}
                    {showGp ? <td className="num">{isNum(l.line_gp) ? fmtMoney(l.line_gp, currency) : <Masked what="Gross profit" />}</td> : null}
                    {editable ? (
                      <td className="nowrap">
                        <span className="row row--tight">
                          <button type="button" className="btn btn--sm" onClick={() => onEdit(l)}>Edit</button>
                          <button type="button" className="btn btn--sm btn--danger" onClick={() => onRemove(l)}>Remove</button>
                        </span>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/* ───────────────────────── terms ───────────────────────── */

const TERM_FIELDS: { key: keyof QuoteVersion; api: string; label: string }[] = [
  { key: 'payment_terms', api: 'paymentTerms', label: 'Payment terms' },
  { key: 'delivery_terms', api: 'deliveryTerms', label: 'Delivery terms' },
  { key: 'scope', api: 'scope', label: 'Scope' },
  { key: 'assumptions', api: 'assumptions', label: 'Assumptions' },
  { key: 'exclusions', api: 'exclusions', label: 'Exclusions' },
  { key: 'warranty', api: 'warranty', label: 'Warranty' },
  { key: 'commercial_terms', api: 'commercialTerms', label: 'Commercial terms' },
];

function TermsDialog({ version, onClose, onDone }: { version: QuoteVersion; onClose: () => void; onDone: () => void }) {
  const seesCost = useSeesField('supplier_cost');
  const [validUntil, setValidUntil] = useState(version.valid_until ?? '');
  const [text, setText] = useState<Record<string, string>>(() =>
    Object.fromEntries(TERM_FIELDS.map((f) => [f.api, (version[f.key] as string | null) ?? ''])));
  const [adders, setAdders] = useState({
    otherProjectCost: isNum(version.other_project_cost) ? String(version.other_project_cost) : '',
    operationCharges: isNum(version.operation_charges) ? String(version.operation_charges) : '',
    trainingCharges: isNum(version.training_charges) ? String(version.training_charges) : '',
  });

  return (
    <FormDialog
      wide
      title={`Terms on version ${version.version_no}`}
      submitLabel="Save terms"
      onClose={onClose}
      onSubmit={async () => {
        const body: Record<string, unknown> = { validUntil: validUntil || null };
        for (const f of TERM_FIELDS) body[f.api] = text[f.api].trim() || null;
        if (seesCost) {
          for (const [k, v] of Object.entries(adders)) {
            if (v.trim() === '') { body[k] = 0; continue; }
            const n = Number(v);
            if (!Number.isFinite(n) || n < 0) throw new UserError('Project, operation and training charges must be zero or more.');
            body[k] = n;
          }
        }
        await api.patch(`/quotation-versions/${version.id}`, body);
        onDone();
      }}
    >
      <div className="form-grid">
        <Field label="Valid until">{(p) => <input {...p} className="input" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />}</Field>
        {seesCost ? (
          <>
            <Field label={`Other project cost (${version.currency})`} hint="Counts towards the cost side of the margin.">
              {(p) => <input {...p} className="input input--num" inputMode="decimal" value={adders.otherProjectCost} onChange={(e) => setAdders({ ...adders, otherProjectCost: e.target.value })} />}
            </Field>
            <Field label={`Operation charges (${version.currency})`}>
              {(p) => <input {...p} className="input input--num" inputMode="decimal" value={adders.operationCharges} onChange={(e) => setAdders({ ...adders, operationCharges: e.target.value })} />}
            </Field>
            <Field label={`Training charges (${version.currency})`}>
              {(p) => <input {...p} className="input input--num" inputMode="decimal" value={adders.trainingCharges} onChange={(e) => setAdders({ ...adders, trainingCharges: e.target.value })} />}
            </Field>
          </>
        ) : null}
      </div>
      {TERM_FIELDS.map((f) => (
        <Field key={f.api} label={f.label}>
          {(p) => <textarea {...p} className="textarea" value={text[f.api]} onChange={(e) => setText({ ...text, [f.api]: e.target.value })} />}
        </Field>
      ))}
    </FormDialog>
  );
}

/* ───────────────────────── split exception ───────────────────────── */

function SplitDialog({ versionId, onClose, onDone }: { versionId: string; onClose: () => void; onDone: () => void }) {
  const [sales, setSales] = useState('');
  const [tech, setTech] = useState('');
  const [company, setCompany] = useState('');
  const [reason, setReason] = useState('');
  const sum = [sales, tech, company].reduce((a, s) => a + (Number(s) || 0), 0);

  return (
    <FormDialog
      title="Ask for a different margin split"
      submitLabel="Request the exception"
      onClose={onClose}
      onSubmit={async () => {
        const n = (s: string, what: string) => {
          const v = Number(s);
          if (s.trim() === '' || !Number.isFinite(v) || v < 0 || v > 100) throw new UserError(`${what} must be a percentage between 0 and 100.`);
          return v;
        };
        const body = {
          salesSharePct: n(sales, 'The sales share'),
          technicalSharePct: n(tech, 'The technical share'),
          companySharePct: n(company, 'The company share'),
          reason: reason.trim(),
        };
        if (Math.abs(body.salesSharePct + body.technicalSharePct + body.companySharePct - 100) > 1e-6) {
          throw new UserError('The three shares must add up to exactly 100.');
        }
        if (body.reason.length < 5) throw new UserError('Explain why this deal needs a different split.');
        await api.post(`/quotation-versions/${versionId}/margin-override`, body);
        onDone();
      }}
    >
      <p className="muted">The standard split keeps applying until a director approves the exception.</p>
      <div className="form-grid">
        <Field label="Sales %" required>{(p) => <input {...p} className="input input--num" inputMode="decimal" value={sales} onChange={(e) => setSales(e.target.value)} />}</Field>
        <Field label="Technical %" required>{(p) => <input {...p} className="input input--num" inputMode="decimal" value={tech} onChange={(e) => setTech(e.target.value)} />}</Field>
        <Field label="Company %" required error={sum > 0 && Math.abs(sum - 100) > 1e-6 ? `These add up to ${fmtDec(sum, 1)}, not 100.` : null}>
          {(p) => <input {...p} className="input input--num" inputMode="decimal" value={company} onChange={(e) => setCompany(e.target.value)} />}
        </Field>
      </div>
      <Field label="Why this deal is different" required>
        {(p) => <textarea {...p} className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} />}
      </Field>
    </FormDialog>
  );
}

function ExceptionDialog({ versionId, message, onClose, onDone }: {
  versionId: string; message: string; onClose: () => void; onDone: (msg: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <FormDialog
      title="Ask for an exception below the margin floor"
      submitLabel="Send for a director's decision"
      onClose={onClose}
      onSubmit={async () => {
        if (reason.trim().length < 5) throw new UserError('Say why this quotation must go out below the floor.');
        const res = await api.postFull<{ data: { message?: string } }>(`/quotation-versions/${versionId}/submit`, {
          requestException: true, reason: reason.trim(),
        });
        onDone(res.body.data?.message ?? 'The exception has gone for approval.');
      }}
    >
      <div className="notice notice--crit" role="alert"><span className="prewrap">{message}</span></div>
      <p className="muted">Nothing goes to the customer. The version moves to Pending approval and waits for a director.</p>
      <Field label="Why this must go out below the floor" required>
        {(p) => <textarea {...p} className="textarea" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />}
      </Field>
    </FormDialog>
  );
}

/* ───────────────────────── approvals on this version ───────────────────────── */

function ApprovalsPanel({ version }: { version: QuoteVersion }) {
  if (!version.approvals.length) return null;
  return (
    <Panel title="Approvals" count={version.approvals.length} id="appr" flush>
      {version.approvals.map((a) => (
        <div key={a.id}>
          <div className="row" style={{ padding: '8px 12px', background: 'var(--surface-2)', borderBottom: '1px solid var(--line)' }}>
            <b>{a.trigger_code === 'LOW_MARGIN' ? 'Low margin' : a.trigger_code === 'MARGIN_OVERRIDE' ? 'Margin split exception' : a.trigger_code}</b>
            <StatusPill value={a.status} />
            <span className="muted right">raised by {a.requested_by_name} · {fmtDateTime(a.requested_at)}</span>
          </div>
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th className="num">Step</th><th>Approver</th><th>Status</th><th>Decided</th><th>Comments</th></tr></thead>
              <tbody>
                {a.steps.map((s) => (
                  <tr key={s.id}>
                    <td className="num">{s.step_no}</td>
                    <td>{s.approver_name}</td>
                    <td><StatusPill value={s.status} /></td>
                    <td className="nowrap">{s.acted_at ? fmtDateTime(s.acted_at) : <span className="muted">Waiting</span>}</td>
                    <td className="wrap">{s.comments ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </Panel>
  );
}

/* ───────────────────────── page ───────────────────────── */

export default function QuotationBuilder() {
  const { id = '' } = useParams();
  const [sp, setSp] = useSearchParams();
  const qc = useQueryClient();
  const toast = useToast();
  const canEdit = useCan('quotations.edit');
  const canExport = useCan('quotations.export');
  const canSeeProc = useCan('procurement_requests.view');
  const seesMargin = useSeesField('margin');
  const seesSell = useSeesField('sell_price');
  const [dlg, setDlg] = useState<Dlg>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const quote = useQuery({
    queryKey: ['quotation', id],
    queryFn: async () => (await api.get<One<QuotationDetail>>(`/quotations/${id}`)).data,
  });

  const reload = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['quotation', id] }),
      qc.invalidateQueries({ queryKey: ['quote-margin'] }),
      qc.invalidateQueries({ queryKey: ['quotations'] }),
      qc.invalidateQueries({ queryKey: ['approvals'] }),
      qc.invalidateQueries({ queryKey: ['enquiry'] }),
    ]);
  };

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    try {
      toast.push('ok', await fn());
      await reload();
    } catch (e) {
      setBlocked(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  /** Submit is the gate. 200 = it went out, 202 = it went for approval, 422 below the floor = refused. */
  async function submit(versionId: string) {
    setBusy(true);
    try {
      const res = await api.postFull<{ data: { message?: string } }>(`/quotation-versions/${versionId}/submit`, {});
      if (res.status === 202) toast.push('warn', res.body.data?.message ?? 'This version has gone for approval and has not been submitted.');
      else toast.push('ok', 'Submitted. Earlier submitted versions are now superseded.');
      await reload();
    } catch (e) {
      const floorBlocked = e instanceof ApiError && e.code === 'gate_blocked'
        && !!(e.details as { minMarginPct?: number } | undefined)?.minMarginPct;
      if (floorBlocked) setDlg({ kind: 'exception', message: errorMessage(e) });
      else setBlocked(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <DataView query={quote} label="Loading the quotation">
      {(d) => {
        const wanted = Number(sp.get('v'));
        const version =
          d.versions.find((v) => v.version_no === wanted)
          ?? d.versions.find((v) => v.version_no === d.current_version)
          ?? d.versions[d.versions.length - 1];
        if (!version) return <EmptyState title="This quotation has no versions" hint="That should not happen. Tell an administrator the quotation number." />;

        const latest = d.versions[d.versions.length - 1];
        const draft = isDraft(version);
        const editable = canEdit && draft;
        const ccy = version.currency;
        const pickVersion = (n: number) => {
          const next = new URLSearchParams(sp);
          next.set('v', String(n));
          setSp(next, { replace: true });
        };

        return (
          <>
            <PageHead
              crumbs={<><Link to="/quotations">Quotations</Link><span>/</span><span className="mono">{d.quotation_no}</span></>}
              title={<span className="id">{d.quotation_no}</span>}
              sub={
                <>
                  <StatusPill value={version.status} />{' '}
                  <span className="muted">
                    version {version.version_no} of {d.versions.length} · {d.customer_name} ·{' '}
                    <Link to={`/enquiries/${d.enquiry_id}`}>{d.enquiry_no}</Link> · {d.business_type_name} · owner {d.owner_name}
                  </span>
                </>
              }
              actions={
                <>
                  <label className="field" style={{ minWidth: 150 }}>
                    <span className="sr-only">Version</span>
                    <select className="select" value={version.version_no} onChange={(e) => pickVersion(Number(e.target.value))}>
                      {d.versions.map((v) => (
                        <option key={v.id} value={v.version_no}>v{v.version_no} · {v.status}{v.version_no === d.current_version ? ' (current)' : ''}</option>
                      ))}
                    </select>
                  </label>
                  {canEdit && !isDraft(latest) ? (
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => void run(async () => {
                        await api.post(`/quotations/${id}/versions`, {});
                        return `Version ${latest.version_no + 1} started as a copy of v${latest.version_no}.`;
                      })}
                    >
                      Create version {latest.version_no + 1}
                    </button>
                  ) : null}
                  {canExport && seesSell ? (
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => void downloadFile(`/quotation-versions/${version.id}/pdf`, `${d.quotation_no}-v${version.version_no}.pdf`)
                        .catch((e) => setBlocked(errorMessage(e)))}
                    >
                      Download PDF
                    </button>
                  ) : null}
                  {canSeeProc ? (
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => void openDocument(`/quotation-versions/${version.id}/rfq-preview`).catch((e) => setBlocked(errorMessage(e)))}
                    >
                      RFQ preview
                    </button>
                  ) : null}
                  {editable ? <button type="button" className="btn" onClick={() => setDlg({ kind: 'terms' })}>Edit terms</button> : null}
                  {editable ? (
                    <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void submit(version.id)}>
                      {busy ? 'Working…' : 'Submit this version'}
                    </button>
                  ) : null}
                </>
              }
            />

            <div className="kpis">
              <Kpi
                label="Total sell"
                value={isNum(version.total_sell) ? fmtMoney(version.total_sell, ccy, true) : <Masked what="The selling total" />}
                sub={`${version.lines.length} line${version.lines.length === 1 ? '' : 's'}`}
              />
              <Kpi
                label="Total cost"
                value={isNum(version.total_cost) ? fmtMoney(version.total_cost, ccy, true) : <Masked what="The cost total" />}
                sub="lines plus project, operation and training charges"
              />
              <Kpi
                label="Gross profit"
                value={isNum(version.gross_profit) ? fmtMoney(version.gross_profit, ccy, true) : <Masked what="Gross profit" />}
              />
              <Kpi
                label="Gross margin"
                value={isNum(version.gross_margin_pct) ? fmtPct(version.gross_margin_pct, 2) : <Masked what="Margin" />}
              />
              <Kpi label="VAT" value={fmtMoney(version.total_tax, ccy, true)} />
              <Kpi
                label="Valid until"
                value={version.valid_until ? fmtDate(version.valid_until) : <span className="muted">Not set</span>}
                sub={version.quote_date ? `quoted ${fmtDate(version.quote_date)}` : undefined}
              />
            </div>

            {!draft ? (
              <Notice tone="info" title={`Version ${version.version_no} is ${humanize(version.status).toLowerCase()}.`}>
                {version.status === 'PendingApproval'
                  ? 'It is waiting for a director and cannot be changed. Approvals are decided on the Approvals screen.'
                  : `A version that has left Draft is a record of what was quoted and is never edited.${canEdit && !isDraft(latest) ? ` Use “Create version ${latest.version_no + 1}” to quote again.` : ''}`}
              </Notice>
            ) : null}
            {canEdit && isDraft(latest) && latest.version_no !== version.version_no ? (
              <Notice tone="info">
                {`Version ${latest.version_no} is still an open draft. Finish or submit it before starting another.`}
              </Notice>
            ) : null}
            {version.requires_approval && draft ? (
              <Notice tone="warn">This version has already been through an approval. Changing it may put it below the threshold again.</Notice>
            ) : null}

            <div className="two-col">
              <div className="stack--lg stack" style={{ minWidth: 0 }}>
                <LinesPanel
                  version={version}
                  editable={editable}
                  currency={ccy}
                  onAdd={() => setDlg({ kind: 'line', line: null })}
                  onEdit={(l) => setDlg({ kind: 'line', line: l })}
                  onRemove={(l) => setDlg({ kind: 'remove', line: l })}
                />

                <Panel
                  title="Terms"
                  id="terms"
                  actions={editable ? <button type="button" className="btn btn--sm" onClick={() => setDlg({ kind: 'terms' })}>Edit</button> : null}
                >
                  <dl className="dl">
                    {TERM_FIELDS.map((f) => {
                      const v = version[f.key] as string | null;
                      return <div key={f.api} style={{ gridColumn: '1 / -1' }}><dt>{f.label}</dt><dd className="prewrap">{v || <span className="muted">Not set</span>}</dd></div>;
                    })}
                    {version.other_project_cost !== undefined ? (
                      <div><dt>Other project cost</dt><dd className="mono">{fmtMoney(version.other_project_cost, ccy)}</dd></div>
                    ) : null}
                    {version.operation_charges !== undefined ? (
                      <div><dt>Operation charges</dt><dd className="mono">{fmtMoney(version.operation_charges, ccy)}</dd></div>
                    ) : null}
                    {version.training_charges !== undefined ? (
                      <div><dt>Training charges</dt><dd className="mono">{fmtMoney(version.training_charges, ccy)}</dd></div>
                    ) : null}
                  </dl>
                </Panel>

                <ApprovalsPanel version={version} />
              </div>

              <div className="side-stack">
                {seesMargin ? (
                  <MarginPanel
                    versionId={version.id}
                    currency={ccy}
                    draft={draft}
                    canSplit={canEdit && version.status !== 'Superseded' && version.status !== 'Rejected'}
                    onSplit={() => setDlg({ kind: 'split' })}
                  />
                ) : (
                  <Panel title="Margin" id="margin">
                    <EmptyState title="Margin is not visible to your role" hint="Ask a director for margin access if you need to see what this quotation earns." />
                  </Panel>
                )}

                <Panel title="Versions" count={d.versions.length} flush id="vers">
                  <div className="table-wrap">
                    <table className="t">
                      <thead><tr><th>Version</th><th>Status</th><th>Created</th></tr></thead>
                      <tbody>
                        {d.versions.map((v) => (
                          <tr key={v.id} className={v.id === version.id ? 'is-selected' : undefined}>
                            <td>
                              <button type="button" className="btn btn--sm btn--ghost" onClick={() => pickVersion(v.version_no)}>
                                <span className="mono">v{v.version_no}</span>
                              </button>
                            </td>
                            <td><StatusPill value={v.status} /></td>
                            <td className="nowrap">{fmtDate(v.created_at)}<span className="sub">{v.created_by_name ?? ''}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              </div>
            </div>

            {dlg?.kind === 'line' ? (
              <LineDialog
                versionId={version.id}
                line={dlg.line}
                currency={ccy}
                onClose={() => setDlg(null)}
                onDone={() => { toast.push('ok', dlg.line ? 'Line saved.' : 'Line added.'); void reload(); }}
              />
            ) : null}
            {dlg?.kind === 'remove' ? (
              <FormDialog
                title={`Remove line ${dlg.line.line_no}?`}
                submitLabel="Remove line"
                danger
                onClose={() => setDlg(null)}
                onSubmit={async () => {
                  await api.del(`/quotation-lines/${dlg.line.id}`);
                  toast.push('ok', 'Line removed.');
                  void reload();
                }}
              >
                <p className="prewrap">{dlg.line.description}</p>
                <p className="muted">The totals and the margin are worked out again as soon as it goes.</p>
              </FormDialog>
            ) : null}
            {dlg?.kind === 'terms' ? (
              <TermsDialog version={version} onClose={() => setDlg(null)} onDone={() => { toast.push('ok', 'Terms saved.'); void reload(); }} />
            ) : null}
            {dlg?.kind === 'split' ? (
              <SplitDialog versionId={version.id} onClose={() => setDlg(null)} onDone={() => { toast.push('info', 'The exception has gone for approval. The standard split applies until it is decided.'); void reload(); }} />
            ) : null}
            {dlg?.kind === 'exception' ? (
              <ExceptionDialog
                versionId={version.id}
                message={dlg.message}
                onClose={() => setDlg(null)}
                onDone={(msg) => { toast.push('warn', msg); void reload(); }}
              />
            ) : null}
            {blocked ? <MessageDialog title="That could not be done" message={blocked} onClose={() => setBlocked(null)} /> : null}
          </>
        );
      }}
    </DataView>
  );
}
