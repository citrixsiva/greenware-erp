/**
 * Reports.
 *
 * `reports` has been one of the RBAC modules since the beginning, with six
 * permissions seeded across ten roles — and nothing behind it. This is that
 * module.
 *
 * Two rules shape everything here.
 *
 * 1. MASKING IS NOT OPTIONAL IN AGGREGATE. A report is the easiest place in a
 *    system to leak what the field matrix protects: sum a column nobody may
 *    read and the total tells them most of it anyway. So every money figure on
 *    every row below is gated on the same field groups the record screens use,
 *    and a column the session may not see is ABSENT from the payload rather
 *    than nulled — the same contract as mask()/maskAll().
 *
 * 2. SCOPE APPLIES TO ROWS, NOT TO THE ANSWER. The scope predicate is ANDed
 *    into the query, so a salesperson's "win rate" is the win rate of the
 *    enquiries they can see. That is the honest reading: it is their number,
 *    not a partial view of the company's.
 *
 * Every report returns `{ data: { rows, totals, meta } }` so a screen can show
 * a table and a summary strip without a second request.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q } from '../core/db.js';
import type { Row } from '../core/db.js';
import { require_, scopeFor, scopeSql } from '../core/rbac.js';
import { audit } from '../core/audit.js';
import { AppError, badRequest } from '../core/errors.js';
import { pool } from '../core/db.js';
import type { AuthCtx, Scope } from '../core/types.js';

/* ───────────────────────── validation ───────────────────────── */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD');
const uuid = z.string().uuid();

const periodQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  sbuId: uuid.optional(),
  ownerId: uuid.optional(),
  customerId: uuid.optional(),
});
type Period = z.infer<typeof periodQuery>;

const groupQuery = periodQuery.extend({
  groupBy: z.enum(['owner', 'sbu', 'customer', 'business_type', 'month']).default('owner'),
});

function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    throw badRequest('validation_failed', 'Check the report filters',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AppError) throw e;
    const err = e as { code?: string } | null;
    if (err?.code === '22P02' || err?.code === '22007') {
      throw badRequest('invalid_value', 'A date or id in the filters is malformed.');
    }
    throw e;
  }
}

/* ───────────────────────── money visibility ───────────────────────── */

/**
 * What this session may be shown, in aggregate. `isOwn` cannot be evaluated
 * for a total spanning many records, so an own-only grant does NOT open a
 * report column: a figure covering other people's deals is not "own".
 */
function visibility(ctx: AuthCtx) {
  return {
    sell: ctx.fields.has('sell_price'),
    cost: ctx.fields.has('supplier_cost'),
    margin: ctx.fields.has('margin'),
  };
}

/** Removes the keys this session may not see, so they are absent rather than null. */
function redact<T extends Row>(rows: T[], drop: string[]): Partial<T>[] {
  if (!drop.length) return rows;
  return rows.map((r) => {
    const out: Row = { ...r };
    for (const k of drop) delete out[k];
    return out as Partial<T>;
  });
}

/* ───────────────────────── shared SQL ───────────────────────── */

/** Dubai governs "today" and therefore every period boundary (OD-18). */
const TODAY = `(now() AT TIME ZONE 'Asia/Dubai')::date`;

function periodWhere(f: Period, col: string, params: unknown[]): string[] {
  const w: string[] = [];
  if (f.from) { params.push(f.from); w.push(`${col} >= $${params.length}::date`); }
  if (f.to) { params.push(f.to); w.push(`${col} <= $${params.length}::date`); }
  return w;
}

const GROUP_SQL: Record<string, { key: string; label: string; join: string }> = {
  owner:         { key: 'e.account_manager_id::text', label: 'am.full_name',    join: 'LEFT JOIN gw.employees am ON am.id = e.account_manager_id' },
  sbu:           { key: 's.id::text',                 label: 's.code',          join: 'LEFT JOIN gw.sbus s ON s.id = e.primary_sbu_id' },
  customer:      { key: 'c.id::text',                 label: 'c.name',          join: 'JOIN gw.customers c ON c.id = e.customer_id' },
  business_type: { key: 'bt.id::text',                label: 'bt.name',         join: 'LEFT JOIN gw.business_types bt ON bt.id = e.business_type_id' },
  // The key sorts (YYYY-MM); the label is what a person reads (Nov 2026).
  month:         { key: `to_char(e.received_at, 'YYYY-MM')`, label: `to_char(e.received_at, 'Mon YYYY')`, join: '' },
};

/* ───────────────────────── routes ───────────────────────── */

export async function reportRoutes(app: FastifyInstance) {
  /* ═════════════ 1. Three-point margin ═════════════
   *
   * Quoted at the quotation, Booked when the PO lands, Realised when the money
   * and the costs are both in. The gap between them is the number the three
   * spreadsheets could never produce, because no two of them shared a key.
   */
  app.get('/api/v1/reports/margin', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'reports.view');
    const f = parse(periodQuery, req.query);
    const vis = visibility(ctx);

    if (!vis.margin && !vis.sell) {
      throw badRequest('not_visible',
        'Your role cannot see selling prices or margin, so this report would be empty. Ask an administrator for the margin field group.');
    }

    const sc = scopeSql(ctx, scope, { alias: 'e', ownerCol: 'account_manager_id', sbuCol: 'primary_sbu_id', entity: 'enquiries' }, 1);
    const params: unknown[] = [...sc.params];
    const w = [sc.sql, ...periodWhere(f, 'po.po_date', params)];
    if (f.customerId) { params.push(f.customerId); w.push(`po.customer_id = $${params.length}`); }
    if (f.ownerId) { params.push(f.ownerId); w.push(`po.account_manager_id = $${params.length}`); }
    if (f.sbuId) { params.push(f.sbuId); w.push(`e.primary_sbu_id = $${params.length}`); }

    const rows = await guard(() => q(
      `SELECT po.id, po.po_ref, po.po_date::text AS po_date, po.customer_po_number,
              c.name AS customer_name, am.full_name AS account_manager_name, s.code AS sbu_code,
              e.enquiry_no, e.id AS enquiry_id,
              m.quoted_sell, m.quoted_margin_pct, po.net_value AS booked_sell, m.booked_margin_pct,
              m.realised_sell, m.realised_margin_pct,
              (m.booked_margin_pct - m.quoted_margin_pct)   AS quote_to_book_pts,
              (m.realised_margin_pct - m.booked_margin_pct) AS book_to_actual_pts
         FROM gw.v_margin_snapshots m
         JOIN gw.customer_pos po ON po.id = m.customer_po_id
         JOIN gw.enquiries e ON e.id = po.enquiry_id
         JOIN gw.customers c ON c.id = po.customer_id
         LEFT JOIN gw.employees am ON am.id = po.account_manager_id
         LEFT JOIN gw.sbus s ON s.id = e.primary_sbu_id
        WHERE ${w.join(' AND ')}
        ORDER BY po.po_date DESC, po.po_ref
        LIMIT 500`, params));

    const num = (v: unknown) => (v == null ? null : Number(v));
    const sum = (k: string) => rows.reduce((a, r) => a + (num(r[k]) ?? 0), 0);
    const avg = (k: string) => {
      const vals = rows.map((r) => num(r[k])).filter((v): v is number => v != null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };

    const drop: string[] = [];
    if (!vis.sell) drop.push('quoted_sell', 'booked_sell', 'realised_sell');
    if (!vis.margin) drop.push('quoted_margin_pct', 'booked_margin_pct', 'realised_margin_pct', 'quote_to_book_pts', 'book_to_actual_pts');

    const totals: Row = { orders: rows.length };
    if (vis.sell) { totals.quoted_sell = sum('quoted_sell'); totals.booked_sell = sum('booked_sell'); totals.realised_sell = sum('realised_sell'); }
    if (vis.margin) {
      totals.quoted_margin_pct = avg('quoted_margin_pct');
      totals.booked_margin_pct = avg('booked_margin_pct');
      totals.realised_margin_pct = avg('realised_margin_pct');
      // Slippage is the point of the report: where the margin actually goes.
      totals.quote_to_book_pts = avg('quote_to_book_pts');
      totals.book_to_actual_pts = avg('book_to_actual_pts');
      totals.eroded = rows.filter((r) => (num(r.book_to_actual_pts) ?? 0) < 0).length;
    }

    return {
      data: {
        rows: redact(rows, drop),
        totals,
        meta: { currency: 'AED', sees: vis, awaiting_close: rows.filter((r) => r.realised_margin_pct == null).length },
      },
    };
  });

  /* ═════════════ 2. Win / loss ═════════════ */
  app.get('/api/v1/reports/win-loss', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'reports.view');
    const f = parse(groupQuery, req.query);
    const g = GROUP_SQL[f.groupBy];

    const sc = scopeSql(ctx, scope, { alias: 'e', ownerCol: 'account_manager_id', sbuCol: 'primary_sbu_id', entity: 'enquiries' }, 1);
    const params: unknown[] = [...sc.params];
    const w = [sc.sql, ...periodWhere(f, 'e.received_at::date', params)];
    if (f.sbuId) { params.push(f.sbuId); w.push(`e.primary_sbu_id = $${params.length}`); }
    if (f.ownerId) { params.push(f.ownerId); w.push(`e.account_manager_id = $${params.length}`); }
    if (f.customerId) { params.push(f.customerId); w.push(`e.customer_id = $${params.length}`); }

    const joins = new Set([g.join, 'LEFT JOIN gw.sbus s ON s.id = e.primary_sbu_id', 'JOIN gw.customers c ON c.id = e.customer_id',
      'LEFT JOIN gw.employees am ON am.id = e.account_manager_id', 'LEFT JOIN gw.business_types bt ON bt.id = e.business_type_id']);

    const rows = await guard(() => q(
      `SELECT ${g.key} AS group_key, ${g.label} AS group_label,
              COUNT(*)::int                                            AS enquiries,
              COUNT(*) FILTER (WHERE e.stage = 'Won')::int             AS won,
              COUNT(*) FILTER (WHERE e.stage = 'Lost')::int            AS lost,
              COUNT(*) FILTER (WHERE e.stage NOT IN
                   ('Won','Lost','Cancelled','Dropped'))::int          AS open,
              COALESCE(SUM(e.approx_budget) FILTER (WHERE e.stage = 'Won'), 0) AS won_budget,
              CASE WHEN COUNT(*) FILTER (WHERE e.stage IN ('Won','Lost')) > 0
                   THEN ROUND(100.0 * COUNT(*) FILTER (WHERE e.stage = 'Won')
                              / COUNT(*) FILTER (WHERE e.stage IN ('Won','Lost')), 1)
              END                                                      AS win_rate_pct
         FROM gw.enquiries e
         ${[...joins].filter(Boolean).join('\n         ')}
        WHERE ${w.join(' AND ')}
        GROUP BY 1, 2
        ORDER BY enquiries DESC, 2
        LIMIT 200`, params));

    // Why the lost ones were lost. Without this the win rate is a number with
    // no action attached to it.
    const reasons = await guard(() => q(
      `SELECT COALESCE(lr.name, 'Not recorded') AS reason, COUNT(*)::int AS lost
         FROM gw.enquiries e
         LEFT JOIN gw.loss_reasons lr ON lr.id = e.loss_reason_id
        WHERE ${w.join(' AND ')} AND e.stage = 'Lost'
        GROUP BY 1 ORDER BY lost DESC, 1 LIMIT 20`, params));

    const t = rows.reduce((a, r) => ({
      enquiries: a.enquiries + Number(r.enquiries), won: a.won + Number(r.won),
      lost: a.lost + Number(r.lost), open: a.open + Number(r.open),
    }), { enquiries: 0, won: 0, lost: 0, open: 0 });

    return {
      data: {
        rows,
        totals: {
          ...t,
          win_rate_pct: t.won + t.lost > 0 ? Math.round((1000 * t.won) / (t.won + t.lost)) / 10 : null,
        },
        meta: { groupBy: f.groupBy, loss_reasons: reasons },
      },
    };
  });

  /* ═════════════ 3. Pipeline by stage ═════════════ */
  app.get('/api/v1/reports/pipeline', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'reports.view');
    const f = parse(periodQuery, req.query);

    const sc = scopeSql(ctx, scope, { alias: 'e', ownerCol: 'account_manager_id', sbuCol: 'primary_sbu_id', entity: 'enquiries' }, 1);
    const params: unknown[] = [...sc.params];
    const w = [sc.sql, ...periodWhere(f, 'e.received_at::date', params)];
    if (f.sbuId) { params.push(f.sbuId); w.push(`e.primary_sbu_id = $${params.length}`); }
    if (f.ownerId) { params.push(f.ownerId); w.push(`e.account_manager_id = $${params.length}`); }

    // Stage age comes from the last stage_history row, not a column on the
    // enquiry — the schema records stage changes as events (design rule 2), so
    // there is no stage_since to read. The next follow-up date lives on the
    // latest follow_ups row for the same reason.
    const rows = await guard(() => q(
      `SELECT e.stage::text AS stage, COUNT(*)::int AS enquiries,
              COALESCE(SUM(e.approx_budget), 0) AS budget,
              ROUND(AVG(${TODAY} - COALESCE(sh.changed_at, e.created_at)::date), 1) AS avg_days_in_stage,
              COUNT(*) FILTER (WHERE fu.next_follow_up < ${TODAY})::int AS overdue_follow_ups
         FROM gw.enquiries e
         LEFT JOIN LATERAL (SELECT changed_at FROM gw.stage_history
                             WHERE enquiry_id = e.id ORDER BY changed_at DESC LIMIT 1) sh ON TRUE
         LEFT JOIN LATERAL (SELECT next_follow_up FROM gw.follow_ups
                             WHERE enquiry_id = e.id AND next_follow_up IS NOT NULL
                             ORDER BY followed_up_at DESC LIMIT 1) fu ON TRUE
        WHERE ${w.join(' AND ')}
        GROUP BY 1
        ORDER BY 1`, params));

    return {
      data: {
        rows,
        totals: {
          enquiries: rows.reduce((a, r) => a + Number(r.enquiries), 0),
          budget: rows.reduce((a, r) => a + Number(r.budget ?? 0), 0),
          overdue_follow_ups: rows.reduce((a, r) => a + Number(r.overdue_follow_ups), 0),
        },
        meta: { currency: 'AED' },
      },
    };
  });

  /* ═════════════ 4. SLA performance ═════════════
   *
   * Procurement and estimation turnaround against target, from the timers the
   * SLA engine already keeps. Breaches are counted, not averaged away.
   */
  app.get('/api/v1/reports/sla', async (req) => {
    const ctx = req.auth;
    require_(ctx, 'reports.view');
    const f = parse(periodQuery, req.query);
    const params: unknown[] = [];
    const w = ['TRUE', ...periodWhere(f, 't.started_at::date', params)];

    const rows = await guard(() => q(
      `SELECT t.timer_code, t.entity_type,
              COUNT(*)::int                                              AS timers,
              COUNT(*) FILTER (WHERE t.stopped_at IS NOT NULL)::int      AS finished,
              COUNT(*) FILTER (WHERE t.state = 'Breached')::int          AS breached,
              COUNT(*) FILTER (WHERE t.state = 'Approaching')::int       AS approaching,
              ROUND(AVG(t.elapsed_working_hours), 1)                     AS avg_hours,
              ROUND(AVG(t.target_hours), 1)                              AS target_hours,
              CASE WHEN COUNT(*) > 0
                   THEN ROUND(100.0 * COUNT(*) FILTER (WHERE t.state <> 'Breached') / COUNT(*), 1)
              END                                                        AS met_pct
         FROM gw.sla_timers t
        WHERE ${w.join(' AND ')}
        GROUP BY 1, 2
        ORDER BY breached DESC, 1`, params));

    const timers = rows.reduce((a, r) => a + Number(r.timers), 0);
    const breached = rows.reduce((a, r) => a + Number(r.breached), 0);
    return {
      data: {
        rows,
        totals: { timers, breached, met_pct: timers ? Math.round((1000 * (timers - breached)) / timers) / 10 : null },
        meta: { calendar: 'Dubai' },
      },
    };
  });

  /* ═════════════ 5. Receivables ageing ═════════════ */
  app.get('/api/v1/reports/receivables', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'reports.view');
    // Ageing is a finance report; seeing it needs the invoice module too.
    if (scopeFor(ctx, 'customer_invoices.view') === null) {
      throw badRequest('not_visible', 'Your role cannot see customer invoices, so there is no ageing to show.');
    }
    const f = parse(periodQuery, req.query);
    const sc = scopeSql(ctx, scope, { alias: 'cu', ownerCol: 'account_manager_id', entity: 'customers' }, 1);
    const params: unknown[] = [...sc.params];
    const w = [sc.sql];
    if (f.customerId) { params.push(f.customerId); w.push(`v.customer_id = $${params.length}`); }

    const rows = await guard(() => q(
      `SELECT v.ageing_bucket, COUNT(*)::int AS invoices,
              COALESCE(SUM(v.balance), 0) AS balance
         FROM gw.v_receivables_ageing v
         JOIN gw.customers cu ON cu.id = v.customer_id
        WHERE ${w.join(' AND ')}
        GROUP BY 1 ORDER BY 1`, params));

    const worst = await guard(() => q(
      `SELECT cu.name AS customer_name, COUNT(*)::int AS invoices,
              COALESCE(SUM(v.balance), 0) AS balance,
              MAX(v.days_overdue)::int AS worst_days
         FROM gw.v_receivables_ageing v
         JOIN gw.customers cu ON cu.id = v.customer_id
        WHERE ${w.join(' AND ')} AND v.balance > 0
        GROUP BY 1 ORDER BY balance DESC LIMIT 15`, params));

    return {
      data: {
        rows,
        totals: {
          invoices: rows.reduce((a, r) => a + Number(r.invoices), 0),
          balance: rows.reduce((a, r) => a + Number(r.balance ?? 0), 0),
          overdue: rows.filter((r) => !String(r.ageing_bucket).startsWith('0') && !String(r.ageing_bucket).startsWith('1'))
            .reduce((a, r) => a + Number(r.balance ?? 0), 0),
        },
        meta: { currency: 'AED', worst_customers: worst },
      },
    };
  });

  /* ═════════════ 6. What is available ═════════════
   *
   * The screen asks this first rather than hard-coding a list, so a report the
   * session cannot see is never offered and then refused.
   */
  app.get('/api/v1/reports', async (req) => {
    const ctx = req.auth;
    require_(ctx, 'reports.view');
    const vis = visibility(ctx);
    const catalogue = [
      { key: 'margin', name: 'Margin analysis', sub: 'Quoted, booked and realised on every order', available: vis.margin || vis.sell },
      { key: 'win-loss', name: 'Win / loss', sub: 'Win rate and why deals were lost', available: true },
      { key: 'pipeline', name: 'Pipeline', sub: 'Value and ageing by stage', available: true },
      { key: 'sla', name: 'SLA performance', sub: 'Procurement and estimation turnaround', available: true },
      { key: 'receivables', name: 'Receivables ageing', sub: 'What is owed and how late', available: scopeFor(ctx, 'customer_invoices.view') !== null },
    ];
    return { data: catalogue, meta: { sees: vis } };
  });

  /* ═════════════ Export ═════════════
   *
   * CSV of any report above. Exporting is its own permission and its own audit
   * row — a spreadsheet of margins leaving the building is exactly the event
   * you want a record of.
   */
  app.get('/api/v1/reports/:key/export', async (req, reply) => {
    const ctx = req.auth;
    require_(ctx, 'reports.export');
    const { key } = parse(z.object({ key: z.enum(['margin', 'win-loss', 'pipeline', 'sla', 'receivables']) }), req.params);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/${key}`,
      query: req.query as Record<string, string>,
      headers: { authorization: req.headers.authorization ?? '' },
    });
    if (res.statusCode !== 200) {
      reply.code(res.statusCode);
      return JSON.parse(res.payload);
    }
    const rows = (JSON.parse(res.payload).data.rows ?? []) as Row[];
    if (!rows.length) {
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="${key}-empty.csv"`);
      return 'No rows for these filters\n';
    }

    const cols = Object.keys(rows[0]);
    const esc = (v: unknown) => {
      if (v == null) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');

    const client = await pool.connect();
    try {
      await audit(client, ctx, { entityType: 'reports', entityId: null, action: 'export', reason: key });
    } finally {
      client.release();
    }

    const stamp = new Date().toISOString().slice(0, 10);
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="greenware-${key}-${stamp}.csv"`);
    return csv + '\n';
  });
}
