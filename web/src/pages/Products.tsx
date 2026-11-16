import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useCan } from '../lib/auth';
import { fmtMoney } from '../lib/format';
import { usePagedList, useBootstrap } from '../lib/hooks';
import type { ProductSku } from '../lib/types';
import { FormDialog } from '../components/Dialog';
import { useToast } from '../components/Toast';
import {
  EmptyState, ErrorState, Field, LoadingState, MoreButton, PageHead, Panel, PlusIcon,
} from '../components/ui';

/**
 * A SKU belongs to a product. Most of the time the product already exists and
 * you are adding another part number to it; occasionally it does not, and
 * making someone create the product on a separate screen first would be the
 * kind of two-step that stops people entering data at all. The API takes
 * either an existing productId or the details of a new one — never both — so
 * the form offers exactly that choice.
 */
function SkuForm({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const boot = useBootstrap();
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [productQ, setProductQ] = useState('');
  const [productId, setProductId] = useState('');
  const [newProductName, setNewProductName] = useState('');
  const [partNumber, setPartNumber] = useState('');
  const [description, setDescription] = useState('');
  const [uom, setUom] = useState('EA');
  const [listPrice, setListPrice] = useState('');
  const [listCurrency, setListCurrency] = useState('AED');

  // Reuse the SKU list endpoint to find products: it searches part number and
  // product name together, which is how people actually look for them.
  const matches = usePagedList<ProductSku>(['sku-search', productQ], '/product-skus',
    { q: productQ.trim() || undefined, limit: 20 }, productQ.trim().length >= 2);
  const products = Array.from(
    new Map(matches.rows.map((s) => [s.product_id, s.product_name])).entries(),
  );

  const ready = partNumber.trim() && (mode === 'existing' ? !!productId : !!newProductName.trim());

  return (
    <FormDialog
      title="New part number"
      submitLabel="Create"
      wide
      onClose={onClose}
      disabled={!ready}
      onSubmit={async () => {
        await api.post('/product-skus', {
          ...(mode === 'existing'
            ? { productId }
            : { newProduct: { name: newProductName.trim() } }),
          partNumber: partNumber.trim(),
          description: description.trim() || null,
          uom: uom.trim() || 'EA',
          listPrice: listPrice ? Number(listPrice) : null,
          listCurrency: listPrice ? listCurrency : null,
        });
        onDone(`${partNumber.trim()} added.`);
      }}
    >
      <div className="dlg__body">
        <div className="field">
          <span className="label" id="sku-mode">Product</span>
          <div className="seg" role="group" aria-labelledby="sku-mode">
            <button type="button" aria-pressed={mode === 'existing'} onClick={() => setMode('existing')}>Existing</button>
            <button type="button" aria-pressed={mode === 'new'} onClick={() => setMode('new')}>New product</button>
          </div>
        </div>

        {mode === 'existing' ? (
          <>
            <Field label="Find the product" hint="Search by product name or any of its part numbers.">
              {(p) => <input {...p} className="input" type="search" value={productQ} onChange={(e) => { setProductQ(e.target.value); setProductId(''); }} placeholder="Search…" />}
            </Field>
            {productQ.trim().length >= 2 ? (
              <Field label="Matching products" required>
                {(p) => (
                  <select {...p} className="select" value={productId} onChange={(e) => setProductId(e.target.value)} size={Math.min(6, Math.max(2, products.length + 1))}>
                    <option value="">{matches.isPending ? 'Searching…' : products.length ? 'Choose…' : 'No match — switch to New product'}</option>
                    {products.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                  </select>
                )}
              </Field>
            ) : null}
          </>
        ) : (
          <Field label="Product name" required hint="The family this part belongs to, e.g. “Veeam Backup & Replication”.">
            {(p) => <input {...p} className="input" value={newProductName} onChange={(e) => setNewProductName(e.target.value)} maxLength={255} />}
          </Field>
        )}

        <div className="cols">
          <Field label="Part number" required>
            {(p) => <input {...p} className="input" value={partNumber} onChange={(e) => setPartNumber(e.target.value)} maxLength={255} />}
          </Field>
          <Field label="Unit of measure">
            {(p) => <input {...p} className="input" value={uom} onChange={(e) => setUom(e.target.value)} maxLength={12} placeholder="EA" style={{ maxWidth: 110 }} />}
          </Field>
        </div>

        <Field label="Description">
          {(p) => <textarea {...p} className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} />}
        </Field>

        <div className="cols">
          <Field label="List price" hint="Optional. Quotations still price from the supplier quote, not this.">
            {(p) => <input {...p} className="input" type="number" min={0} step={0.01} value={listPrice} onChange={(e) => setListPrice(e.target.value)} />}
          </Field>
          <Field label="Currency">
            {(p) => (
              <select {...p} className="select" value={listCurrency} onChange={(e) => setListCurrency(e.target.value)} disabled={!listPrice}>
                {(boot.data?.currencies ?? [{ code: 'AED', name: 'UAE Dirham' }]).map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
              </select>
            )}
          </Field>
        </div>
      </div>
    </FormDialog>
  );
}

export default function Products() {
  const [sp, setSp] = useSearchParams();
  const q = sp.get('q') ?? '';
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);

  const qc = useQueryClient();
  const toast = useToast();
  const canCreate = useCan('products.create');
  const [adding, setAdding] = useState(false);

  const list = usePagedList<ProductSku>(['product-skus'], '/product-skus', { q: q || undefined });

  return (
    <>
      <PageHead
        title="Products"
        sub="Part numbers quotations and supplier quotes are priced against. Price history is keyed on these."
        actions={canCreate ? (
          <button type="button" className="btn btn--primary" onClick={() => setAdding(true)}>
            <PlusIcon /> New part number
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
        <label className="field" style={{ minWidth: 280 }}>
          <span className="label">Search</span>
          <input className="input" type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Part number or product name" />
        </label>
        <button type="submit" className="btn">Search</button>
      </form>

      <Panel title="Part numbers" count={list.isPending ? '' : `${list.rows.length}${list.hasMore ? '+' : ''}`} flush>
        {list.isPending ? <LoadingState />
          : list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          : list.rows.length === 0 ? (
            <EmptyState
              title={q ? 'Nothing matches' : 'No part numbers yet'}
              hint={q ? 'Clear the search.' : 'Add the parts you quote most often; the rest can be typed free-text on a quotation line.'}
              action={canCreate && !q ? <button type="button" className="btn btn--primary" onClick={() => setAdding(true)}><PlusIcon /> New part number</button> : undefined}
            />
          ) : (
            <>
              <div className="table-wrap">
                <table className="t">
                  <thead><tr><th>Part number</th><th>Product</th><th>UoM</th><th className="num">List price</th><th>Price history</th></tr></thead>
                  <tbody>
                    {list.rows.map((s) => (
                      <tr key={s.id}>
                        <td className="wrap"><span className="id">{s.part_number}</span>{s.description ? <span className="sub">{s.description}</span> : null}</td>
                        <td className="wrap">{s.product_name}{s.manufacturer_name ? <span className="sub">{s.manufacturer_name}</span> : null}</td>
                        <td className="mono">{s.uom}</td>
                        <td className="num">{s.list_price != null ? fmtMoney(s.list_price, s.list_currency ?? 'AED', true) : <span className="muted">—</span>}</td>
                        <td><Link to={`/price-history?sku=${s.id}`} className="btn btn--sm btn--ghost">What we paid</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <MoreButton cursor={list.hasMore ? 'y' : null} loading={list.isFetchingNextPage} onMore={list.more} />
            </>
          )}
      </Panel>

      {adding ? (
        <SkuForm
          onClose={() => setAdding(false)}
          onDone={(msg) => { toast.push('ok', msg); void qc.invalidateQueries({ queryKey: ['product-skus'] }); }}
        />
      ) : null}
    </>
  );
}
