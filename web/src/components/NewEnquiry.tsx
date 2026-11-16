import { useState } from 'react';
import { api } from '../lib/api';
import { useBootstrap, useEmployees } from '../lib/hooks';
import { dubaiToday } from '../lib/format';
import type { Customer } from '../lib/types';
import { CustomerPicker } from './CustomerPicker';
import { FormDialog } from './Dialog';
import { Field, Notice, PlusIcon } from './ui';

interface LineDraft { description: string; quantity: string }

/**
 * Create an enquiry.
 *
 * Until now the only way into the pipeline was to qualify a lead, which meant
 * walk-in business, a phone call from an existing customer or anything that
 * never passed through marketing had no door. The API has always supported
 * this; there was simply no form.
 *
 * At least one line is required by the server, and rightly so: an enquiry with
 * nothing in it cannot be costed, estimated or quoted, and would sit in the
 * pipeline looking like work.
 */
export function NewEnquiry({ onClose, onDone }: {
  onClose: () => void;
  onDone: (id: string, enquiryNo: string) => void;
}) {
  const boot = useBootstrap();
  const employees = useEmployees();

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [businessTypeId, setBusinessTypeId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [accountManagerId, setAccountManagerId] = useState('');
  const [approxBudget, setApproxBudget] = useState('');
  const [budgetCurrency, setBudgetCurrency] = useState('AED');
  const [expectedQuoteDate, setExpectedQuoteDate] = useState('');
  const [expectedPoDate, setExpectedPoDate] = useState('');
  const [source, setSource] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([{ description: '', quantity: '1' }]);

  const setLine = (i: number, patch: Partial<LineDraft>) =>
    setLines((ls) => ls.map((l, n) => (n === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines((ls) => [...ls, { description: '', quantity: '1' }]);
  const dropLine = (i: number) => setLines((ls) => (ls.length === 1 ? ls : ls.filter((_, n) => n !== i)));

  const filled = lines.filter((l) => l.description.trim());
  const ready = !!customer && !!businessTypeId && !!title.trim() && filled.length > 0;

  return (
    <FormDialog
      title="New enquiry"
      submitLabel="Create enquiry"
      wide
      onClose={onClose}
      disabled={!ready}
      onSubmit={async () => {
        const res = await api.post<{ data: { id: string; enquiry_no: string } }>('/enquiries', {
          customerId: customer!.id,
          businessTypeId,
          title: title.trim(),
          description: description.trim() || null,
          accountManagerId: accountManagerId || undefined,
          approxBudget: approxBudget ? Number(approxBudget) : null,
          budgetCurrency,
          expectedQuoteDate: expectedQuoteDate || null,
          expectedPoDate: expectedPoDate || null,
          source: source.trim() || null,
          lines: filled.map((l) => ({
            description: l.description.trim(),
            quantity: Number(l.quantity) || 1,
          })),
        });
        onDone(res.data.id, res.data.enquiry_no);
      }}
    >
      <div className="dlg__body">
        <CustomerPicker value={customer} onChange={setCustomer} required />

        <div className="cols">
          <Field label="Business type" required hint="Decides whether procurement and estimation are needed, and the margin rule.">
            {(p) => (
              <select {...p} className="select" value={businessTypeId} onChange={(e) => setBusinessTypeId(e.target.value)}>
                <option value="">Choose…</option>
                {(boot.data?.business_types ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            )}
          </Field>
          <Field label="Account manager" hint="Defaults to you.">
            {(p) => (
              <select {...p} className="select" value={accountManagerId} onChange={(e) => setAccountManagerId(e.target.value)}>
                <option value="">Me</option>
                {(employees.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}
              </select>
            )}
          </Field>
        </div>

        <Field label="Title" required hint="What the customer is asking for, in a line.">
          {(p) => <input {...p} className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={255} placeholder="Backup and DR refresh — 3 sites" />}
        </Field>

        <Field label="Description">
          {(p) => <textarea {...p} className="input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={10_000} />}
        </Field>

        <div className="cols">
          <Field label="Approximate budget" hint="The customer's figure, if they gave one.">
            {(p) => <input {...p} className="input" type="number" min={0} step={1000} value={approxBudget} onChange={(e) => setApproxBudget(e.target.value)} />}
          </Field>
          <Field label="Currency">
            {(p) => (
              <select {...p} className="select" value={budgetCurrency} onChange={(e) => setBudgetCurrency(e.target.value)}>
                {(boot.data?.currencies ?? [{ code: 'AED', name: 'UAE Dirham' }]).map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
              </select>
            )}
          </Field>
        </div>

        <div className="cols">
          <Field label="Quote expected by" hint="Drives the follow-up clock.">
            {(p) => <input {...p} className="input" type="date" min={dubaiToday()} value={expectedQuoteDate} onChange={(e) => setExpectedQuoteDate(e.target.value)} />}
          </Field>
          <Field label="PO expected by">
            {(p) => <input {...p} className="input" type="date" min={dubaiToday()} value={expectedPoDate} onChange={(e) => setExpectedPoDate(e.target.value)} />}
          </Field>
        </div>

        <Field label="Source">
          {(p) => <input {...p} className="input" value={source} onChange={(e) => setSource(e.target.value)} maxLength={255} placeholder="Customer call, referral, existing contract…" />}
        </Field>

        <div className="lines-edit">
          <div className="lines-edit__head">
            <span className="label">Lines <span className="req" aria-hidden="true">*</span></span>
            <button type="button" className="btn btn--sm" onClick={addLine}><PlusIcon /> Add line</button>
          </div>
          {lines.map((l, i) => (
            <div className="lines-edit__row" key={i}>
              <input
                className="input"
                value={l.description}
                onChange={(e) => setLine(i, { description: e.target.value })}
                placeholder={i === 0 ? 'What is being asked for' : 'Another item'}
                maxLength={2000}
                aria-label={`Line ${i + 1} description`}
              />
              <input
                className="input lines-edit__qty"
                type="number"
                min={1}
                step={1}
                value={l.quantity}
                onChange={(e) => setLine(i, { quantity: e.target.value })}
                aria-label={`Line ${i + 1} quantity`}
              />
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => dropLine(i)}
                disabled={lines.length === 1}
                aria-label={`Remove line ${i + 1}`}
              >
                Remove
              </button>
            </div>
          ))}
          <span className="hint">
            Rough lines are fine — procurement and estimation refine them. Technology routing happens from the
            line once an SBU picks it up.
          </span>
        </div>

        {customer && !customer.is_active ? (
          <Notice tone="warn">This customer is marked inactive. Check before promising anything.</Notice>
        ) : null}
      </div>
    </FormDialog>
  );
}
