import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, q1 } from '../core/db.js';
import type { Row } from '../core/db.js';
import { require_, scopeSql, mask } from '../core/rbac.js';
import { badRequest, notFound } from '../core/errors.js';
import type { AuthCtx, FieldGroup, Scope } from '../core/types.js';

/* ───────────────────────── constants ───────────────────────── */

const BASE_CCY = 'AED';
const DUBAI_TODAY = `(now() AT TIME ZONE 'Asia/Dubai')::date`;
const BAND_LIMIT = 500;          // most recent points per band
const TREND_MONTHS = 24;
const fxRate = (ccy: string) =>
  `(CASE WHEN ${ccy} = '${BASE_CCY}' THEN 1 ELSE ` +
  `(SELECT f.rate FROM gw.fx_rates f WHERE f.from_currency = ${ccy} AND f.to_currency = '${BASE_CCY}' ` +
  `ORDER BY f.rate_date DESC LIMIT 1) END)`;

/* ───────────────────────── validation ───────────────────────── */

const uuid = z.string().uuid();
const searchQuery = z.object({
  q: z.string().trim().min(2, 'Type at least two characters of a part number, product or manufacturer.').max(100),
  limit: z.coerce.number().int().min(1).max(25).default(10),
});
const skuParam = z.object({ skuId: uuid });

function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    throw badRequest(
      'validation_failed',
      'Check the highlighted fields',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

const likeTerm = (s: string) => `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

/* ───────────────────────── visibility ───────────────────────── */

/** 'all' = the whole group, 'own' = only records on the caller's own enquiries, null = no access (band omitted). */
type Mode = 'all' | 'own' | null;
const modeOf = (ctx: AuthCtx, g: FieldGroup): Mode =>
  ctx.fields.has(g) ? 'all' : ctx.fieldsOwnOnly.has(g) ? 'own' : null;

interface Vis { cost: Mode; sell: Mode; margin: Mode }

/**
 * A predicate over the enquiry joined as `e`, plus its params, numbered from `startIdx`.
 *   - sell-side bands also respect the record scope of price_history.view (A/D = everything);
 *   - 'own' mode restricts to enquiries the caller is account manager of.
 * Cost points are catalogue facts governed by the field group alone, except in 'own' mode.
 */
function visSql(
  ctx: AuthCtx, scope: Scope, mode: Exclude<Mode, null>, applyScope: boolean, startIdx: number,
): { sql: string; params: any[] } {
  const parts: string[] = [];
  const params: any[] = [];
  if (applyScope) {
    const sc = scopeSql(ctx, scope, { alias: 'e', ownerCol: 'account_manager_id', sbuCol: 'primary_sbu_id', entity: 'enquiries' }, startIdx + params.length);
    parts.push(sc.sql);
    params.push(...sc.params);
  }
  if (mode === 'own') {
    if (ctx.employeeId) { params.push(ctx.employeeId); parts.push(`e.account_manager_id = $${startIdx + params.length - 1}`); }
    else parts.push('FALSE');
  }
  return { sql: parts.length ? parts.join(' AND ') : 'TRUE', params };
}

/* ───────────────────────── item model ───────────────────────── */

/** Either a catalogue SKU, or a bare part number that has price points but no SKU row. */
interface Item {
  sku: Row | null;
  part_number: string;
  match_score: number;
}

/** Points belong to a SKU directly, or by part number when they were recorded before the SKU was linked. */
const matchSql = (a: string) =>
  `(($1::uuid IS NOT NULL AND ${a}.product_sku_id = $1::uuid) OR (${a}.product_sku_id IS NULL AND ${a}.part_number = $2::text))`;

const SKU_COLS = `
  k.id AS sku_id, k.part_number, k.description AS sku_description, k.uom, k.is_active AS sku_is_active,
  p.id AS product_id, p.name AS product_name, m.id AS manufacturer_id, m.name AS manufacturer_name`;
const SKU_FROM = `
  FROM gw.product_skus k
  JOIN gw.products p ON p.id = k.product_id
  LEFT JOIN gw.manufacturers m ON m.id = p.manufacturer_id`;

const toSkuItem = (r: Row, score: number): Item => ({
  part_number: r.part_number,
  match_score: score,
  sku: {
    id: r.sku_id, part_number: r.part_number, description: r.sku_description, uom: r.uom, is_active: r.sku_is_active,
    product: { id: r.product_id, name: r.product_name },
    manufacturer: r.manufacturer_id ? { id: r.manufacturer_id, name: r.manufacturer_name } : null,
  },
});

/* ───────────────────────── payload builder ───────────────────────── */

async function buildPayload(ctx: AuthCtx, scope: Scope, vis: Vis, item: Item): Promise<Row> {
  const skuId = (item.sku?.id ?? null) as string | null;
  const base: unknown[] = [skuId, item.part_number];

  /* ---- cost side ---- */
  const costQ = (async () => {
    if (!vis.cost) return null;
    const v = visSql(ctx, scope, vis.cost, false, 3);
    const params = [...base, ...v.params];
    const where = `${matchSql('cp')} AND NOT cp.is_archived AND ${v.sql}`;
    const from = `FROM gw.cost_price_points cp
                  JOIN gw.suppliers s ON s.id = cp.supplier_id
                  LEFT JOIN gw.enquiries e ON e.id = cp.enquiry_id`;
    const costBase = `COALESCE(cp.unit_cost_base, CASE WHEN cp.currency = '${BASE_CCY}' THEN cp.unit_cost END)`;
    const [band, trend, last, best] = await Promise.all([
      q(`SELECT cp.id, cp.supplier_id, s.name AS supplier_name, cp.unit_cost, cp.currency, cp.unit_cost_base, cp.quantity,
                cp.availability, cp.lead_time_days, cp.payment_terms_days, cp.valid_until::text AS valid_until,
                cp.quoted_on::text AS quoted_on, cp.enquiry_id, e.enquiry_no, (cp.superseded_by IS NOT NULL) AS superseded
           ${from} WHERE ${where}
          ORDER BY cp.quoted_on DESC, cp.recorded_at DESC LIMIT ${BAND_LIMIT}`, params),
      q(`SELECT to_char(date_trunc('month', x.quoted_on), 'YYYY-MM') AS month,
                min(x.v) AS "min", round(avg(x.v), 4) AS "avg", max(x.v) AS "max", count(*)::int AS points
           FROM (SELECT cp.quoted_on, ${costBase} AS v ${from}
                  WHERE ${where} AND cp.quoted_on >= date_trunc('month', ${DUBAI_TODAY} - interval '${TREND_MONTHS - 1} months')::date) x
          WHERE x.v IS NOT NULL
          GROUP BY 1 ORDER BY 1`, params),
      // "Last purchase": the latest actual supplier PO if there is one, otherwise the latest quotation.
      q1(`SELECT cp.supplier_id, s.name AS supplier_name,
                 COALESCE(pur.unit_cost, cp.unit_cost) AS unit_cost, COALESCE(pur.currency, cp.currency) AS currency,
                 COALESCE(pur.po_date, cp.quoted_on)::text AS date,
                 CASE WHEN pur.po_date IS NOT NULL THEN 'purchase_order' ELSE 'quotation' END AS basis,
                 e.enquiry_no
            ${from}
            LEFT JOIN LATERAL (
              SELECT po.po_date, pl.unit_cost, po.currency
                FROM gw.supplier_po_lines pl JOIN gw.supplier_pos po ON po.id = pl.supplier_po_id
               WHERE pl.supplier_quote_line_id = cp.supplier_quote_line_id
               ORDER BY po.po_date DESC LIMIT 1
            ) pur ON true
           WHERE ${where}
           ORDER BY (pur.po_date IS NOT NULL) DESC, COALESCE(pur.po_date, cp.quoted_on) DESC, cp.recorded_at DESC
           LIMIT 1`, params),
      q1(`SELECT cp.supplier_id, s.name AS supplier_name, cp.unit_cost, cp.currency, cp.unit_cost_base,
                 cp.lead_time_days, cp.availability, cp.valid_until::text AS valid_until, cp.quoted_on::text AS quoted_on
            ${from}
           WHERE ${where} AND cp.superseded_by IS NULL AND cp.valid_until >= ${DUBAI_TODAY}
           ORDER BY ${costBase} ASC NULLS LAST, cp.quoted_on DESC
           LIMIT 1`, params),
    ]);
    return { band, trend, last, best };
  })();

  /* ---- sell side (and margin) ---- */
  const sellQ = (async () => {
    if (!vis.sell && !vis.margin) return null;
    const sellV = vis.sell ? visSql(ctx, scope, vis.sell, true, 3) : null;
    const marginV = vis.margin ? visSql(ctx, scope, vis.margin, true, 3) : null;
    const from = `FROM gw.sell_price_points sp
                  LEFT JOIN gw.enquiries e ON e.id = sp.enquiry_id`;
    const sellParams = sellV ? [...base, ...sellV.params] : [];
    const marginParams = marginV ? [...base, ...marginV.params] : [];
    const sellWhere = sellV ? `${matchSql('sp')} AND ${sellV.sql}` : 'FALSE';
    const marginWhere = marginV ? `${matchSql('sp')} AND sp.margin_pct IS NOT NULL AND ${marginV.sql}` : 'FALSE';
    const net = `(sp.unit_price * (1 - sp.discount_pct / 100) * ${fxRate('sp.currency')})`;

    const [band, trend, stats, margin] = await Promise.all([
      sellV
        ? q(`SELECT sp.id, sp.customer_id, c.name AS customer_name, sp.unit_price, sp.discount_pct, sp.currency, sp.quantity,
                    sp.quoted_on::text AS quoted_on, sp.outcome::text AS outcome, sp.enquiry_id, e.enquiry_no
               ${from} JOIN gw.customers c ON c.id = sp.customer_id
              WHERE ${sellWhere}
              ORDER BY sp.quoted_on DESC, sp.recorded_at DESC LIMIT ${BAND_LIMIT}`, sellParams)
        : Promise.resolve(null),
      sellV
        ? q(`SELECT to_char(date_trunc('month', x.quoted_on), 'YYYY-MM') AS month,
                    min(x.v) AS "min", round(avg(x.v), 4) AS "avg", max(x.v) AS "max", count(*)::int AS points
               FROM (SELECT sp.quoted_on, ${net} AS v ${from}
                      WHERE ${sellWhere} AND sp.quoted_on >= date_trunc('month', ${DUBAI_TODAY} - interval '${TREND_MONTHS - 1} months')::date) x
              WHERE x.v IS NOT NULL
              GROUP BY 1 ORDER BY 1`, sellParams)
        : Promise.resolve(null),
      sellV
        ? q1(`SELECT count(DISTINCT sp.customer_id)::int AS customers_quoted,
                     count(DISTINCT sp.enquiry_id) FILTER (WHERE sp.outcome = 'Won')::int AS won,
                     count(DISTINCT sp.enquiry_id) FILTER (WHERE sp.outcome = 'Lost')::int AS lost,
                     ROUND(100.0 * count(DISTINCT sp.enquiry_id) FILTER (WHERE sp.outcome = 'Won')
                           / NULLIF(count(DISTINCT sp.enquiry_id) FILTER (WHERE sp.outcome IN ('Won','Lost')), 0), 1) AS win_rate_pct
                ${from} WHERE ${sellWhere}`, sellParams)
        : Promise.resolve(null),
      marginV
        ? q(`SELECT sp.id AS sell_point_id, sp.quoted_on::text AS quoted_on, sp.quantity, sp.outcome::text AS outcome,
                    sp.margin_pct, sp.enquiry_id, e.enquiry_no
               ${from} WHERE ${marginWhere}
              ORDER BY sp.quoted_on DESC, sp.recorded_at DESC LIMIT ${BAND_LIMIT}`, marginParams)
        : Promise.resolve(null),
    ]);
    return { band, trend, stats, margin };
  })();

  const [cost, sell] = await Promise.all([costQ, sellQ]);

  /* ---- assemble: a band the caller may not see is ABSENT, never null or empty ---- */
  const out: Row = {
    sku: item.sku,
    part_number: item.part_number,
    match_score: item.match_score,
  };

  if (cost) {
    // cost_price_points.unit_cost/_base → supplier_cost; payment terms → supplier_terms (same rule as supplier_quotes).
    out.cost = cost.band.map((r) => mask(ctx, 'supplier_quotes', mask(ctx, 'cost_price_points', r, vis.cost === 'own')));
  }
  if (sell?.band) {
    out.sell = sell.band.map((r) => mask(ctx, 'sell_price_points', r, vis.sell === 'own'));
  }
  if (sell?.margin) {
    out.margin = sell.margin.map((r) => mask(ctx, 'sell_price_points', r, vis.margin === 'own'));
  }

  if (cost || sell?.trend) {
    const trend: Row = {};
    if (cost) trend.cost = cost.trend;
    if (sell?.trend) trend.sell = sell.trend;
    trend.currency = BASE_CCY;
    out.trend = trend;
  }

  const summary: Row = {};
  if (cost) {
    summary.last_purchase = cost.last;
    summary.best_current_price = cost.best;
  }
  if (sell?.stats) {
    summary.customers_quoted = sell.stats.customers_quoted;
    summary.win_rate_pct = sell.stats.win_rate_pct;
    summary.won = sell.stats.won;
    summary.lost = sell.stats.lost;
  }
  if (Object.keys(summary).length) out.summary = summary;

  return out;
}

function visibility(ctx: AuthCtx): Vis {
  return { cost: modeOf(ctx, 'supplier_cost'), sell: modeOf(ctx, 'sell_price'), margin: modeOf(ctx, 'margin') };
}

/* ───────────────────────── routes ───────────────────────── */

export async function priceHistoryRoutes(app: FastifyInstance) {
  /* ═════════════ Search ═════════════ */

  app.get('/api/v1/price-history/search', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'price_history.view');
    const qs = parse(searchQuery, req.query);
    const like = likeTerm(qs.q);

    // SKUs by part number (trigram + substring), product name or manufacturer. Exact part numbers first.
    const skus = await q(
      `SELECT ${SKU_COLS},
              (GREATEST(similarity(k.part_number, $1::text),
                        word_similarity($1::text, p.name),
                        word_similarity($1::text, COALESCE(m.name, '')))
               + CASE WHEN lower(k.part_number) = lower($1::text) THEN 2
                      WHEN k.part_number ILIKE $2 OR p.name ILIKE $2 OR m.name ILIKE $2 THEN 1 ELSE 0 END)::float8 AS score
         ${SKU_FROM}
        WHERE k.part_number ILIKE $2 OR p.name ILIKE $2 OR m.name ILIKE $2
           OR k.part_number % $1::text OR $1::text <% p.name OR $1::text <% COALESCE(m.name, '')
        ORDER BY score DESC, k.part_number
        LIMIT $3`, [qs.q, like, qs.limit]);

    const items: Item[] = skus.map((r) => toSkuItem(r, Math.round(r.score * 100) / 100));

    // Part numbers that carry price points but were never linked to a catalogue SKU still deserve a hit.
    if (items.length < qs.limit) {
      const orphans = await q(
        `SELECT x.part_number, similarity(x.part_number, $1::text)::float8 AS score
           FROM (SELECT part_number FROM gw.cost_price_points
                  WHERE product_sku_id IS NULL AND part_number <> 'UNSPECIFIED' AND (part_number ILIKE $2 OR part_number % $1::text)
                 UNION
                 SELECT part_number FROM gw.sell_price_points
                  WHERE product_sku_id IS NULL AND part_number IS NOT NULL AND (part_number ILIKE $2 OR part_number % $1::text)) x
          WHERE NOT EXISTS (SELECT 1 FROM gw.product_skus k WHERE k.part_number = x.part_number)
          ORDER BY score DESC, x.part_number
          LIMIT $3`, [qs.q, like, qs.limit - items.length]);
      for (const o of orphans) items.push({ sku: null, part_number: o.part_number, match_score: Math.round(o.score * 100) / 100 });
    }

    const vis = visibility(ctx);
    const data = await Promise.all(items.map((i) => buildPayload(ctx, scope, vis, i)));
    return { data, nextCursor: null };
  });

  /* ═════════════ One SKU ═════════════ */

  app.get('/api/v1/price-history/sku/:skuId', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'price_history.view');
    const { skuId } = parse(skuParam, req.params);

    const r = await q1(`SELECT ${SKU_COLS} ${SKU_FROM} WHERE k.id = $1`, [skuId]);
    if (!r) throw notFound('Product SKU');
    const data = await buildPayload(ctx, scope, visibility(ctx), toSkuItem(r, 1));
    return { data };
  });
}
