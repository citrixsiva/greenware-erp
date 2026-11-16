import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useCan, useSeesField } from '../lib/auth';
import { fmtMoney } from '../lib/format';
import { usePagedList, useBootstrap, useEmployees } from '../lib/hooks';
import type { Customer, CustomerDetail } from '../lib/types';
import { FormDialog } from '../components/Dialog';
import { useToast } from '../components/Toast';
import {
  Chip, EmptyState, ErrorState, Field, LoadingState, Masked, MoreButton, PageHead, Panel, PlusIcon,
} from '../components/ui';

/* ───────────────────────── create / edit ───────────────────────── */

function CustomerForm({ existing, onClose, onDone }: {
  existing?: Customer | null;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const boot = useBootstrap();
  const employees = useEmployees();
  const seesCredit = useSeesField('credit');

  const [name, setName] = useState(existing?.name ?? '');
  const [industry, setIndustry] = useState(existing?.industry ?? '');
  const [location, setLocation] = useState(existing?.location ?? '');
  const [country, setCountry] = useState(existing?.country ?? 'AE');
  const [customerType, setCustomerType] = useState(existing?.customer_type ?? '');
  const [accountManagerId, setAccountManagerId] = useState(existing?.account_manager_id ?? '');
  const [paymentTermsDays, setPaymentTermsDays] = useState(String(existing?.payment_terms_days ?? 30));
  const [defaultCurrency, setDefaultCurrency] = useState(existing?.default_currency ?? 'AED');
  const [creditLimit, setCreditLimit] = useState(existing?.credit_limit != null ? String(existing.credit_limit) : '');
  const [taxRegistration, setTaxRegistration] = useState(existing?.tax_registration ?? '');

  return (
    <FormDialog
      title={existing ? `Edit ${existing.customer_code}` : 'New customer'}
      submitLabel={existing ? 'Save changes' : 'Create customer'}
      wide
      onClose={onClose}
      disabled={!name.trim()}
      onSubmit={async () => {
        const body: Record<string, unknown> = {
          name: name.trim(),
          industry: industry.trim() || null,
          location: location.trim() || null,
          country: country.trim() ? country.trim().toUpperCase() : null,
          customerType: customerType.trim() || null,
          accountManagerId: accountManagerId || null,
          paymentTermsDays: Number(paymentTermsDays) || 30,
          defaultCurrency,
          taxRegistration: taxRegistration.trim() || null,
        };
        // Only send credit when the session may see it — otherwise an editor
        // without the field group would blank it just by opening the form.
        if (seesCredit) {
          body.creditLimit = creditLimit ? Number(creditLimit) : null;
          body.creditCurrency = defaultCurrency;
        }
        if (existing) {
          body.rowVersion = existing.row_version;
          await api.patch(`/customers/${existing.id}`, body);
          onDone('Customer updated.');
        } else {
          const res = await api.post<{ data: Customer }>('/customers', body);
          onDone(`${res.data.customer_code} created.`);
        }
      }}
    >
      <div className="dlg__body">
        <Field label="Name" required>
          {(p) => <input {...p} className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={255} autoFocus />}
        </Field>

        <div className="cols">
          <Field label="Industry">
            {(p) => <input {...p} className="input" value={industry} onChange={(e) => setIndustry(e.target.value)} maxLength={255} placeholder="Banking, Logistics…" />}
          </Field>
          <Field label="Type" hint="End customer, partner, reseller — your own wording.">
            {(p) => <input {...p} className="input" value={customerType} onChange={(e) => setCustomerType(e.target.value)} maxLength={255} />}
          </Field>
        </div>

        <div className="cols">
          <Field label="Location">
            {(p) => <input {...p} className="input" value={location} onChange={(e) => setLocation(e.target.value)} maxLength={255} placeholder="Dubai" />}
          </Field>
          <Field label="Country">
            {(p) => <input {...p} className="input" value={country} onChange={(e) => setCountry(e.target.value)} maxLength={2} placeholder="AE" style={{ maxWidth: 90 }} />}
          </Field>
        </div>

        <div className="cols">
          <Field label="Account manager">
            {(p) => (
              <select {...p} className="select" value={accountManagerId} onChange={(e) => setAccountManagerId(e.target.value)}>
                <option value="">{existing ? 'Unassigned' : 'Me'}</option>
                {(employees.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}
              </select>
            )}
          </Field>
          <Field label="Payment terms (days)" hint="Drives invoice due dates and the ageing report.">
            {(p) => <input {...p} className="input" type="number" min={0} max={365} value={paymentTermsDays} onChange={(e) => setPaymentTermsDays(e.target.value)} />}
          </Field>
        </div>

        <div className="cols">
          <Field label="Default currency">
            {(p) => (
              <select {...p} className="select" value={defaultCurrency} onChange={(e) => setDefaultCurrency(e.target.value)}>
                {(boot.data?.currencies ?? [{ code: 'AED', name: 'UAE Dirham' }]).map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
              </select>
            )}
          </Field>
          {seesCredit ? (
            <Field label="Credit limit">
              {(p) => <input {...p} className="input" type="number" min={0} step={1000} value={creditLimit} onChange={(e) => setCreditLimit(e.target.value)} />}
            </Field>
          ) : <div />}
        </div>

        <Field label="Tax registration (TRN)">
          {(p) => <input {...p} className="input" value={taxRegistration} onChange={(e) => setTaxRegistration(e.target.value)} maxLength={255} />}
        </Field>
      </div>
    </FormDialog>
  );
}

/* ───────────────────────── contacts ───────────────────────── */

function ContactForm({ customerId, onClose, onDone }: {
  customerId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [fullName, setFullName] = useState('');
  const [designation, setDesignation] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);

  return (
    <FormDialog
      title="New contact"
      submitLabel="Add contact"
      onClose={onClose}
      disabled={!fullName.trim()}
      onSubmit={async () => {
        await api.post(`/customers/${customerId}/contacts`, {
          fullName: fullName.trim(),
          designation: designation.trim() || null,
          email: email.trim() || null,
          phone: phone.trim() || null,
          isPrimary,
        });
        onDone();
      }}
    >
      <div className="dlg__body">
        <Field label="Name" required>
          {(p) => <input {...p} className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={255} autoFocus />}
        </Field>
        <Field label="Role">
          {(p) => <input {...p} className="input" value={designation} onChange={(e) => setDesignation(e.target.value)} maxLength={255} />}
        </Field>
        <div className="cols">
          <Field label="Email">
            {(p) => <input {...p} className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={255} />}
          </Field>
          <Field label="Phone">
            {(p) => <input {...p} className="input" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={50} />}
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} />
          <span>Primary contact for this customer</span>
        </label>
      </div>
    </FormDialog>
  );
}

/* ───────────────────────── detail drawer ───────────────────────── */

function CustomerPanel({ id, onEdit, onChanged }: { id: string; onEdit: (c: Customer) => void; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const toast = useToast();
  const canEdit = useCan('customers.edit');
  const detail = useQuery({
    queryKey: ['customer', id],
    queryFn: () => api.get<{ data: CustomerDetail }>(`/customers/${id}`),
    select: (r) => r.data,
  });

  if (detail.isPending) return <Panel title="Customer"><LoadingState /></Panel>;
  if (detail.isError) return <Panel title="Customer"><ErrorState error={detail.error} onRetry={() => void detail.refetch()} /></Panel>;
  const c = detail.data;

  return (
    <>
      <Panel
        title={c.name}
        actions={canEdit ? <button type="button" className="btn btn--sm" onClick={() => onEdit(c)}>Edit</button> : null}
      >
        <dl className="kv">
          <dt>Code</dt><dd className="mono">{c.customer_code}</dd>
          <dt>Industry</dt><dd>{c.industry ?? <span className="muted">—</span>}</dd>
          <dt>Location</dt><dd>{[c.location, c.country].filter(Boolean).join(', ') || <span className="muted">—</span>}</dd>
          <dt>Account manager</dt><dd>{c.account_manager_name ?? <span className="muted">Unassigned</span>}</dd>
          <dt>Payment terms</dt><dd className="mono">{c.payment_terms_days} days</dd>
          <dt>Currency</dt><dd className="mono">{c.default_currency}</dd>
          <dt>Credit limit</dt>
          <dd>{'credit_limit' in c
            ? (c.credit_limit != null ? fmtMoney(c.credit_limit, c.credit_currency ?? c.default_currency) : <span className="muted">None set</span>)
            : <Masked what="credit limit" />}</dd>
          <dt>TRN</dt><dd className="mono">{c.tax_registration ?? <span className="muted">—</span>}</dd>
          <dt>Status</dt><dd>{c.is_active ? <Chip tone="ok">Active</Chip> : <Chip tone="warn">Inactive</Chip>}</dd>
        </dl>
      </Panel>

      <Panel
        title="Contacts"
        count={c.contacts.length}
        actions={canEdit ? <button type="button" className="btn btn--sm" onClick={() => setAdding(true)}><PlusIcon /> Add</button> : null}
        flush
      >
        {c.contacts.length === 0 ? (
          <EmptyState title="No contacts" hint="Add the people you actually deal with — quotations address them by name." />
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Name</th><th>Role</th><th>Email</th><th>Phone</th></tr></thead>
              <tbody>
                {c.contacts.map((p) => (
                  <tr key={p.id}>
                    <td className="wrap">{p.full_name}{p.is_primary ? <> <Chip tone="accent">Primary</Chip></> : null}</td>
                    <td>{p.designation ?? <span className="muted">—</span>}</td>
                    <td className="wrap">{p.email ? <a href={`mailto:${p.email}`}>{p.email}</a> : <span className="muted">—</span>}</td>
                    <td className="nowrap">{p.phone ?? <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {adding ? (
        <ContactForm
          customerId={id}
          onClose={() => setAdding(false)}
          onDone={() => { toast.push('ok', 'Contact added.'); void detail.refetch(); onChanged(); }}
        />
      ) : null}
    </>
  );
}

/* ───────────────────────── page ───────────────────────── */

export default function Customers() {
  const [sp, setSp] = useSearchParams();
  const q = sp.get('q') ?? '';
  const selected = sp.get('id');
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);

  const qc = useQueryClient();
  const toast = useToast();
  const canCreate = useCan('customers.create');
  const [dlg, setDlg] = useState<{ kind: 'new' } | { kind: 'edit'; customer: Customer } | null>(null);

  const list = usePagedList<Customer>(['customers'], '/customers', { q: q || undefined, active: 'true' });

  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    setSp(n, { replace: true });
  };
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['customers'] });
    if (selected) void qc.invalidateQueries({ queryKey: ['customer', selected] });
  };

  return (
    <>
      <PageHead
        title="Customers"
        sub="The account behind every enquiry, quotation and invoice. Payment terms set here drive invoice due dates."
        actions={canCreate ? (
          <button type="button" className="btn btn--primary" onClick={() => setDlg({ kind: 'new' })}>
            <PlusIcon /> New customer
          </button>
        ) : null}
      />

      <form className="filters" onSubmit={(e) => { e.preventDefault(); set('q', text.trim()); }}>
        <label className="field" style={{ minWidth: 260 }}>
          <span className="label">Search</span>
          <input className="input" type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Name or code" />
        </label>
        <button type="submit" className="btn">Search</button>
      </form>

      <div className="split">
        <Panel title="Customers" count={list.isPending ? '' : `${list.rows.length}${list.hasMore ? '+' : ''}`} flush>
          {list.isPending ? <LoadingState />
            : list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} />
            : list.rows.length === 0 ? (
              <EmptyState
                title={q ? 'No customers match' : 'No customers yet'}
                hint={q ? 'Clear the search.' : 'Add the first one, or qualify a lead and it will be created for you.'}
                action={canCreate && !q ? <button type="button" className="btn btn--primary" onClick={() => setDlg({ kind: 'new' })}><PlusIcon /> New customer</button> : undefined}
              />
            ) : (
              <>
                <div className="table-wrap">
                  <table className="t">
                    <thead><tr><th>Customer</th><th>Industry</th><th>Account manager</th><th className="num">Terms</th></tr></thead>
                    <tbody>
                      {list.rows.map((c) => (
                        <tr key={c.id} aria-selected={selected === c.id}>
                          <td className="wrap">
                            <button type="button" className="linklike" onClick={() => set('id', c.id)}>
                              <span className="id">{c.customer_code}</span>
                            </button>
                            <span className="sub">{c.name}{c.location ? ` · ${c.location}` : ''}</span>
                          </td>
                          <td>{c.industry ?? <span className="muted">—</span>}</td>
                          <td>{c.account_manager_name ?? <span className="muted">Unassigned</span>}</td>
                          <td className="num mono">{c.payment_terms_days}d</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <MoreButton cursor={list.hasMore ? 'y' : null} loading={list.isFetchingNextPage} onMore={list.more} />
              </>
            )}
        </Panel>

        <div>
          {selected
            ? <CustomerPanel id={selected} onEdit={(c) => setDlg({ kind: 'edit', customer: c })} onChanged={refresh} />
            : <Panel title="Details"><EmptyState title="Pick a customer" hint="Choose one on the left to see its contacts and terms." /></Panel>}
        </div>
      </div>

      {dlg ? (
        <CustomerForm
          existing={dlg.kind === 'edit' ? dlg.customer : null}
          onClose={() => setDlg(null)}
          onDone={(msg) => { toast.push('ok', msg); refresh(); }}
        />
      ) : null}
    </>
  );
}
