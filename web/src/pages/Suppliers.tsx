import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useCan, useSeesField } from '../lib/auth';
import { fmtDec, fmtMoney } from '../lib/format';
import { usePagedList, useBootstrap } from '../lib/hooks';
import type { SupplierRow } from '../lib/types';
import { FormDialog } from '../components/Dialog';
import { useToast } from '../components/Toast';
import {
  Chip, EmptyState, ErrorState, Field, LoadingState, Masked, MoreButton, PageHead, Panel, PlusIcon,
} from '../components/ui';

function SupplierForm({ existing, onClose, onDone }: {
  existing?: SupplierRow | null;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const boot = useBootstrap();
  const seesTerms = useSeesField('supplier_terms');

  const [name, setName] = useState(existing?.name ?? '');
  const [country, setCountry] = useState(existing?.country ?? 'AE');
  const [defaultCurrency, setDefaultCurrency] = useState(existing?.default_currency ?? 'AED');
  const [paymentTermsDays, setPaymentTermsDays] = useState(
    existing?.payment_terms_days != null ? String(existing.payment_terms_days) : '30');
  const [creditLimit, setCreditLimit] = useState(existing?.credit_limit != null ? String(existing.credit_limit) : '');
  const [rating, setRating] = useState(existing?.rating != null ? String(existing.rating) : '');

  return (
    <FormDialog
      title={existing ? `Edit ${existing.supplier_code}` : 'New supplier'}
      submitLabel={existing ? 'Save changes' : 'Create supplier'}
      onClose={onClose}
      disabled={!name.trim()}
      onSubmit={async () => {
        const body: Record<string, unknown> = {
          name: name.trim(),
          country: country.trim() ? country.trim().toUpperCase() : null,
          defaultCurrency,
          rating: rating ? Number(rating) : null,
        };
        // Payment terms and credit are the `supplier_terms` field group. Sending
        // them from a session that cannot see them would overwrite real values
        // with whatever the blank form happened to hold.
        if (seesTerms) {
          body.paymentTermsDays = Number(paymentTermsDays) || 30;
          body.creditLimit = creditLimit ? Number(creditLimit) : null;
        }
        if (existing) {
          body.rowVersion = existing.row_version;
          await api.patch(`/suppliers/${existing.id}`, body);
          onDone('Supplier updated.');
        } else {
          const res = await api.post<{ data: SupplierRow }>('/suppliers', body);
          onDone(`${res.data.supplier_code} created.`);
        }
      }}
    >
      <div className="dlg__body">
        <Field label="Name" required>
          {(p) => <input {...p} className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={255} autoFocus />}
        </Field>
        <div className="cols">
          <Field label="Country">
            {(p) => <input {...p} className="input" value={country} onChange={(e) => setCountry(e.target.value)} maxLength={2} placeholder="AE" style={{ maxWidth: 90 }} />}
          </Field>
          <Field label="Default currency" hint="What they quote in. Cost comparison converts to AED.">
            {(p) => (
              <select {...p} className="select" value={defaultCurrency} onChange={(e) => setDefaultCurrency(e.target.value)}>
                {(boot.data?.currencies ?? [{ code: 'AED', name: 'UAE Dirham' }]).map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
              </select>
            )}
          </Field>
        </div>
        {seesTerms ? (
          <div className="cols">
            <Field label="Payment terms (days)">
              {(p) => <input {...p} className="input" type="number" min={0} max={365} value={paymentTermsDays} onChange={(e) => setPaymentTermsDays(e.target.value)} />}
            </Field>
            <Field label="Credit limit">
              {(p) => <input {...p} className="input" type="number" min={0} step={1000} value={creditLimit} onChange={(e) => setCreditLimit(e.target.value)} />}
            </Field>
          </div>
        ) : null}
        <Field label="Rating" hint="0 to 5. Your own judgement of reliability — it is shown beside their quotes.">
          {(p) => <input {...p} className="input" type="number" min={0} max={5} step={0.5} value={rating} onChange={(e) => setRating(e.target.value)} style={{ maxWidth: 120 }} />}
        </Field>
      </div>
    </FormDialog>
  );
}

export default function Suppliers() {
  const [sp, setSp] = useSearchParams();
  const q = sp.get('q') ?? '';
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);

  const qc = useQueryClient();
  const toast = useToast();
  const canCreate = useCan('suppliers.create');
  const canEdit = useCan('suppliers.edit');
  const seesTerms = useSeesField('supplier_terms');
  const [dlg, setDlg] = useState<{ kind: 'new' } | { kind: 'edit'; supplier: SupplierRow } | null>(null);

  const list = usePagedList<SupplierRow>(['suppliers'], '/suppliers', { q: q || undefined, active: 'true' });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['suppliers'] });

  return (
    <>
      <PageHead
        title="Suppliers"
        sub="Who procurement asks for pricing. Terms and ratings here show up beside every supplier quote."
        actions={canCreate ? (
          <button type="button" className="btn btn--primary" onClick={() => setDlg({ kind: 'new' })}>
            <PlusIcon /> New supplier
          </button>
        ) : null}
      />

      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          const n = new URLSearchParams(sp);
          if (text.trim()) n.set('q', text.trim()); else n.delete('q');
          setSp(n, { replace: true });
        }}
      >
        <label className="field" style={{ minWidth: 260 }}>
          <span className="label">Search</span>
          <input className="input" type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Name or code" />
        </label>
        <button type="submit" className="btn">Search</button>
      </form>

      <Panel title="Suppliers" count={list.isPending ? '' : `${list.rows.length}${list.hasMore ? '+' : ''}`} flush>
        {list.isPending ? <LoadingState />
          : list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          : list.rows.length === 0 ? (
            <EmptyState
              title={q ? 'No suppliers match' : 'No suppliers yet'}
              hint={q ? 'Clear the search.' : 'Procurement needs at least one before it can record a quote.'}
              action={canCreate && !q ? <button type="button" className="btn btn--primary" onClick={() => setDlg({ kind: 'new' })}><PlusIcon /> New supplier</button> : undefined}
            />
          ) : (
            <>
              <div className="table-wrap">
                <table className="t">
                  <thead>
                    <tr>
                      <th>Supplier</th><th>Country</th><th>Currency</th>
                      {seesTerms ? <th className="num">Terms</th> : null}
                      <th className="num">Rating</th>
                      {canEdit ? <th aria-label="Actions" /> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {list.rows.map((s) => (
                      <tr key={s.id}>
                        <td className="wrap"><span className="id">{s.supplier_code}</span><span className="sub">{s.name}</span></td>
                        <td className="mono">{s.country ?? <span className="muted">—</span>}</td>
                        <td className="mono">{s.default_currency}</td>
                        {seesTerms ? (
                          <td className="num mono">
                            {s.payment_terms_days != null ? `${s.payment_terms_days}d` : <Masked what="terms" />}
                            {s.credit_limit != null ? <span className="sub">{fmtMoney(s.credit_limit, s.default_currency, true)}</span> : null}
                          </td>
                        ) : null}
                        <td className="num">{s.rating != null ? <Chip tone={s.rating >= 4 ? 'ok' : s.rating >= 2.5 ? 'warn' : 'crit'} mono>{fmtDec(s.rating, 1)}</Chip> : <span className="muted">—</span>}</td>
                        {canEdit ? (
                          <td><button type="button" className="btn btn--sm btn--ghost" onClick={() => setDlg({ kind: 'edit', supplier: s })}>Edit</button></td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <MoreButton cursor={list.hasMore ? 'y' : null} loading={list.isFetchingNextPage} onMore={list.more} />
            </>
          )}
      </Panel>

      {dlg ? (
        <SupplierForm
          existing={dlg.kind === 'edit' ? dlg.supplier : null}
          onClose={() => setDlg(null)}
          onDone={(msg) => { toast.push('ok', msg); refresh(); }}
        />
      ) : null}
    </>
  );
}
