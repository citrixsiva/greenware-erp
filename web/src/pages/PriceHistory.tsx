import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type One, type Page } from '../lib/api';
import { useSeesField } from '../lib/auth';
import { fmtDate, fmtDec, fmtInt, fmtMoney, fmtPct, isNum } from '../lib/format';
import type { PriceItem, TrendPoint } from '../lib/types';
import { Chip, DataView, EmptyState, ErrorState, Kpi, LoadingState, Masked, Notice, PageHead, Panel } from '../components/ui';

/* ───────────────────────── trend chart ───────────────────────── */

const W = 560;
const H = 200;
const PAD = { top: 12, right: 12, bottom: 26, left: 52 };

interface Series { key: 'cost' | 'sell'; points: TrendPoint[] }

/**
 * Cost and sell history by month, each drawn as a min–max band with the average through it.
 * Both bands are in AED, which is what the API converts them to.
 */
function TrendChart({ cost, sell, currency }: { cost: TrendPoint[]; sell: TrendPoint[]; currency: string }) {
  const [hover, setHover] = useState<number | null>(null);

  const months = useMemo(() => {
    const set = new Set<string>([...cost.map((p) => p.month), ...sell.map((p) => p.month)]);
    return [...set].sort();
  }, [cost, sell]);

  const series: Series[] = [{ key: 'cost', points: cost }, { key: 'sell', points: sell }];
  const values = [...cost, ...sell].flatMap((p) => [p.min, p.max]);
  if (!months.length || !values.length) return null;

  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi === lo) { hi = lo + Math.max(Math.abs(lo) * 0.1, 1); lo -= Math.max(Math.abs(lo) * 0.1, 1); }
  const pad = (hi - lo) * 0.08;
  lo -= pad; hi += pad;

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (months.length === 1 ? plotW / 2 : (i / (months.length - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - ((v - lo) / (hi - lo)) * plotH;

  const at = (s: Series, m: string) => s.points.find((p) => p.month === m) ?? null;
  const path = (s: Series, pick: (p: TrendPoint) => number) =>
    months.map((m, i) => { const p = at(s, m); return p ? `${i === 0 || !at(s, months[i - 1]) ? 'M' : 'L'}${x(i)} ${y(pick(p))}` : ''; }).join(' ');

  function band(s: Series): string {
    const present = months.map((m, i) => ({ p: at(s, m), i })).filter((e) => e.p) as { p: TrendPoint; i: number }[];
    if (present.length < 2) return '';
    const top = present.map(({ p, i }) => `${x(i)},${y(p.max)}`).join(' ');
    const bottom = [...present].reverse().map(({ p, i }) => `${x(i)},${y(p.min)}`).join(' ');
    return `${top} ${bottom}`;
  }

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => lo + (hi - lo) * f);
  const every = Math.max(1, Math.ceil(months.length / 6));
  const hm = hover !== null ? months[hover] : null;

  return (
    <div className="stack" style={{ gap: 'var(--s2)' }}>
      <div className="chart-box">
        <svg
          className="chart"
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          role="img"
          aria-label={`Monthly price history in ${currency}: ${months.length} month${months.length === 1 ? '' : 's'} from ${months[0]} to ${months[months.length - 1]}.`}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            const px = ((e.clientX - box.left) / box.width) * W;
            let best = 0;
            for (let i = 1; i < months.length; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
            setHover(best);
          }}
        >
          {ticks.map((t, i) => (
            <g key={i}>
              <line className="gridline" x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
              <text x={PAD.left - 6} y={y(t) + 3} textAnchor="end">{fmtDec(t, 0)}</text>
            </g>
          ))}
          <line className="axisline" x1={PAD.left} x2={W - PAD.right} y1={H - PAD.bottom} y2={H - PAD.bottom} />
          <line className="axisline" x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={H - PAD.bottom} />

          {band({ key: 'cost', points: cost }) ? <polygon className="band-cost" points={band({ key: 'cost', points: cost })} /> : null}
          {band({ key: 'sell', points: sell }) ? <polygon className="band-sell" points={band({ key: 'sell', points: sell })} /> : null}

          {series.map((s) => (s.points.length ? <path key={s.key} className={`line-${s.key}`} d={path(s, (p) => p.avg)} /> : null))}
          {series.map((s) =>
            months.map((m, i) => {
              const p = at(s, m);
              return p ? <circle key={`${s.key}-${m}`} className={`dot-${s.key}`} cx={x(i)} cy={y(p.avg)} r={3} /> : null;
            }),
          )}

          {hover !== null ? <line className="cursor" x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={H - PAD.bottom} /> : null}

          {months.map((m, i) =>
            i % every === 0 || i === months.length - 1 ? (
              <text key={m} x={x(i)} y={H - PAD.bottom + 14} textAnchor="middle">{m}</text>
            ) : null,
          )}
        </svg>
      </div>

      <div className="legend">
        {cost.length ? <span><i className="cost" />Supplier cost ({currency})</span> : null}
        {sell.length ? <span><i className="sell" />Quoted price ({currency})</span> : null}
      </div>
      <div className="readout">
        {hm ? (
          <>
            {hm}
            {(() => { const p = at(series[0], hm); return p ? ` · cost avg ${fmtDec(p.avg, 2)} (${fmtDec(p.min, 2)}–${fmtDec(p.max, 2)}, ${p.points} pt)` : ''; })()}
            {(() => { const p = at(series[1], hm); return p ? ` · quoted avg ${fmtDec(p.avg, 2)} (${fmtDec(p.min, 2)}–${fmtDec(p.max, 2)}, ${p.points} pt)` : ''; })()}
          </>
        ) : (
          <span className="muted">Move across the chart to read a month.</span>
        )}
      </div>
    </div>
  );
}

/* ───────────────────────── detail bands ───────────────────────── */

function CostTable({ rows, seesCost }: { rows: PriceItem['cost']; seesCost: boolean }) {
  if (!rows) {
    return (
      <EmptyState
        title="Supplier cost is not visible to your role"
        hint={seesCost ? 'You can see cost on your own records only, and none of these were raised by you.' : 'Ask a director for supplier-cost access if you need to see what this part costs.'}
      />
    );
  }
  if (!rows.length) return <EmptyState title="No supplier price on file" hint="Record a supplier quote against a procurement request and it lands here." />;
  return (
    <div className="table-wrap">
      <table className="t">
        <thead>
          <tr><th>Supplier</th><th className="num">Unit cost</th><th className="num">In AED</th><th className="num">Qty</th><th>Lead</th><th>Valid until</th><th>Quoted</th><th>Enquiry</th></tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id}>
              <td>
                {c.supplier_name}
                <span className="sub tag-list">
                  {c.superseded ? <Chip title="A newer price exists for this part">Superseded</Chip> : null}
                  {isNum(c.payment_terms_days) ? <Chip mono>{fmtDec(c.payment_terms_days, 0)} d terms</Chip> : null}
                  {c.availability ? <Chip>{c.availability}</Chip> : null}
                </span>
              </td>
              <td className="num">{isNum(c.unit_cost) ? fmtMoney(c.unit_cost, c.currency) : <Masked what="Supplier cost" />}</td>
              <td className="num">{isNum(c.unit_cost_base) ? fmtMoney(c.unit_cost_base, 'AED') : <Masked what="The base-currency cost" />}</td>
              <td className="num">{isNum(c.quantity) ? fmtDec(c.quantity, 0) : <span className="muted">Any</span>}</td>
              <td className="num">{isNum(c.lead_time_days) ? `${fmtDec(c.lead_time_days, 0)} d` : <span className="muted">Not given</span>}</td>
              <td className="nowrap">{c.valid_until ? fmtDate(c.valid_until) : <span className="muted">Not given</span>}</td>
              <td className="nowrap">{fmtDate(c.quoted_on)}</td>
              <td className="id">{c.enquiry_no ?? <span className="muted">Catalogue</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SellTable({ rows, margins }: { rows: PriceItem['sell']; margins: PriceItem['margin'] }) {
  if (!rows) {
    return <EmptyState title="Quoted prices are not visible to your role" hint="Ask a director for selling-price access if you need to see what this part was quoted at." />;
  }
  if (!rows.length) return <EmptyState title="This part has never been quoted" hint="Submit a quotation containing it and the price point is written here." />;
  const byPoint = new Map((margins ?? []).map((m) => [m.sell_point_id, m]));
  const showMargin = !!margins;
  return (
    <div className="table-wrap">
      <table className="t">
        <thead>
          <tr><th>Customer</th><th className="num">Unit price</th><th className="num">Disc.</th><th className="num">Qty</th><th>Quoted</th><th>Outcome</th>{showMargin ? <th className="num">Margin</th> : null}<th>Enquiry</th></tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const m = byPoint.get(s.id);
            return (
              <tr key={s.id}>
                <td>{s.customer_name}</td>
                <td className="num">{isNum(s.unit_price) ? fmtMoney(s.unit_price, s.currency) : <Masked what="The quoted price" />}</td>
                <td className="num">{isNum(s.discount_pct) ? fmtPct(s.discount_pct, 1) : <Masked what="The discount" />}</td>
                <td className="num">{isNum(s.quantity) ? fmtDec(s.quantity, 0) : <span className="muted">Any</span>}</td>
                <td className="nowrap">{fmtDate(s.quoted_on)}</td>
                <td>{s.outcome ? <Chip tone={s.outcome === 'Won' ? 'ok' : s.outcome === 'Lost' ? 'crit' : undefined}>{s.outcome}</Chip> : <span className="muted">Open</span>}</td>
                {showMargin ? <td className="num">{isNum(m?.margin_pct) ? fmtPct(m!.margin_pct, 1) : <Masked what="Margin" />}</td> : null}
                <td className="id">{s.enquiry_no ?? ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ItemDetail({ item, seesCost }: { item: PriceItem; seesCost: boolean }) {
  const s = item.summary;
  const trend = item.trend;
  const hasTrend = !!trend && ((trend.cost?.length ?? 0) + (trend.sell?.length ?? 0)) > 0;

  return (
    <div className="stack--lg stack" style={{ minWidth: 0 }}>
      <Panel title={item.sku ? item.sku.part_number : item.part_number} id="hdr">
        <dl className="dl">
          <div><dt>Part number</dt><dd className="mono">{item.part_number}</dd></div>
          <div><dt>Product</dt><dd>{item.sku?.product.name ?? <span className="muted">Not in the catalogue</span>}</dd></div>
          <div><dt>Manufacturer</dt><dd>{item.sku?.manufacturer?.name ?? <span className="muted">Unknown</span>}</dd></div>
          <div><dt>Unit of measure</dt><dd>{item.sku?.uom ?? <span className="muted">Not set</span>}</dd></div>
          {item.sku?.description ? <div style={{ gridColumn: '1 / -1' }}><dt>Description</dt><dd className="prewrap">{item.sku.description}</dd></div> : null}
        </dl>
        {!item.sku ? (
          <Notice tone="info" title="No catalogue SKU.">
            These prices were recorded against the bare part number. Create a SKU for it to tie the history to a product and manufacturer.
          </Notice>
        ) : null}
      </Panel>

      <div className="kpis">
        <Kpi
          label="Last purchase"
          value={
            s?.last_purchase
              ? (isNum(s.last_purchase.unit_cost) ? fmtMoney(s.last_purchase.unit_cost, s.last_purchase.currency, true) : <Masked what="Supplier cost" />)
              : s?.last_purchase === null ? <span className="muted">None</span> : <Masked what="Purchase history" />
          }
          sub={s?.last_purchase ? `${s.last_purchase.supplier_name} · ${fmtDate(s.last_purchase.date)}` : undefined}
        />
        <Kpi
          label="Best live price"
          value={
            s?.best_current_price
              ? (isNum(s.best_current_price.unit_cost) ? fmtMoney(s.best_current_price.unit_cost, s.best_current_price.currency, true) : <Masked what="Supplier cost" />)
              : s?.best_current_price === null ? <span className="muted">Nothing in date</span> : <Masked what="Supplier pricing" />
          }
          sub={s?.best_current_price ? `${s.best_current_price.supplier_name}${isNum(s.best_current_price.lead_time_days) ? ` · ${fmtDec(s.best_current_price.lead_time_days, 0)} d lead` : ''}` : undefined}
        />
        <Kpi label="Customers quoted" value={isNum(s?.customers_quoted) ? fmtInt(s!.customers_quoted) : <Masked what="Quoting history" />} />
        <Kpi
          label="Win rate"
          value={isNum(s?.win_rate_pct) ? fmtPct(s!.win_rate_pct, 0) : s && s.win_rate_pct === null ? <span className="muted">Nothing decided</span> : <Masked what="Win rate" />}
          sub={s && isNum(s.won) ? `${fmtInt(s.won)} won · ${fmtInt(s.lost)} lost` : undefined}
        />
      </div>

      <Panel title="Price over time" id="trend">
        {hasTrend ? (
          <TrendChart cost={trend!.cost ?? []} sell={trend!.sell ?? []} currency={trend!.currency} />
        ) : (
          <EmptyState title="Not enough history to chart" hint="One price point does not make a trend. It will appear once there are more." />
        )}
      </Panel>

      <Panel title="Supplier prices" count={item.cost?.length ?? ''} id="cost" flush>
        <CostTable rows={item.cost} seesCost={seesCost} />
      </Panel>

      <Panel title="Quoted to customers" count={item.sell?.length ?? ''} id="sell" flush>
        <SellTable rows={item.sell} margins={item.margin} />
      </Panel>
    </div>
  );
}

/* ───────────────────────── page ───────────────────────── */

export default function PriceHistory() {
  const [sp, setSp] = useSearchParams();
  const term = sp.get('q') ?? '';
  const selected = sp.get('part') ?? '';
  const seesCost = useSeesField('supplier_cost');
  const [text, setText] = useState(term);
  useEffect(() => setText(term), [term]);

  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setSp(next, { replace: true });
  };

  const search = useQuery({
    queryKey: ['price-search', term],
    enabled: term.trim().length >= 2,
    queryFn: async () => (await api.get<Page<PriceItem>>('/price-history/search', { q: term.trim(), limit: 25 })).data,
  });

  const rows = search.data ?? [];
  const chosen = rows.find((r) => r.part_number === selected) ?? rows[0] ?? null;

  // A catalogue SKU has its own endpoint, which stays correct when the search text changes.
  const skuId = chosen?.sku?.id ?? null;
  const sku = useQuery({
    queryKey: ['price-sku', skuId],
    enabled: !!skuId,
    queryFn: async () => (await api.get<One<PriceItem>>(`/price-history/sku/${skuId}`)).data,
  });

  return (
    <>
      <PageHead
        title="Price history"
        sub="What a part has cost from suppliers and what it has been quoted at, so the next price is not guessed."
      />

      <form className="filters" onSubmit={(e) => { e.preventDefault(); set({ q: text.trim(), part: '' }); }}>
        <label className="field" style={{ minWidth: 320 }}>
          <span className="label">Part number, product or manufacturer</span>
          <input className="input" type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="At least two characters" />
        </label>
        <button type="submit" className="btn btn--primary" disabled={text.trim().length < 2}>Search</button>
        {term ? <button type="button" className="btn" onClick={() => { setText(''); set({ q: '', part: '' }); }}>Clear</button> : null}
      </form>

      {term.trim().length < 2 ? (
        <Panel>
          <EmptyState title="Search for a part" hint="Type at least two characters of a part number, a product name or a manufacturer. Exact part numbers come first." />
        </Panel>
      ) : (
        <div className="two-col">
          <div className="stack--lg stack" style={{ minWidth: 0 }}>
            {search.isPending ? (
              <Panel><LoadingState label="Searching" /></Panel>
            ) : search.isError ? (
              <Panel><ErrorState error={search.error} onRetry={() => void search.refetch()} /></Panel>
            ) : !chosen ? (
              <Panel><EmptyState title={`Nothing matches “${term}”`} hint="Try a shorter fragment of the part number, or the manufacturer's name." /></Panel>
            ) : skuId ? (
              <DataView query={sku} label="Loading the price history">{(d) => <ItemDetail item={d} seesCost={seesCost} />}</DataView>
            ) : (
              <ItemDetail item={chosen} seesCost={seesCost} />
            )}
          </div>

          <div className="side-stack">
            <Panel title="Matches" count={search.isPending ? '' : rows.length} flush id="matches">
              {search.isPending ? (
                <LoadingState />
              ) : rows.length === 0 ? (
                <EmptyState title="No match" />
              ) : (
                <ul className="result-list">
                  {rows.map((r) => (
                    <li key={r.part_number}>
                      <button
                        type="button"
                        className="result-btn"
                        aria-current={chosen?.part_number === r.part_number}
                        onClick={() => set({ part: r.part_number })}
                      >
                        <span className="id">{r.part_number}</span>
                        <span className="muted">{r.sku ? `${r.sku.product.name}${r.sku.manufacturer ? ` · ${r.sku.manufacturer.name}` : ''}` : 'Not in the catalogue'}</span>
                        <span className="tag-list">
                          {r.cost ? <Chip mono title="Supplier prices on file">{fmtInt(r.cost.length)} cost</Chip> : null}
                          {r.sell ? <Chip mono title="Times quoted to a customer">{fmtInt(r.sell.length)} quoted</Chip> : null}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </div>
      )}
    </>
  );
}
