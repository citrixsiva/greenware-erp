import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { q, q1, tx } from '../core/db.js';
import type { Row } from '../core/db.js';
import { require_, scopeFor, scopeSql, mask } from '../core/rbac.js';
import { audit } from '../core/audit.js';
import { AppError, badRequest, notFound, gateBlocked, conflict } from '../core/errors.js';
import { nextNumber } from '../core/numbering.js';
import { startTimer, stopTimer, workingHoursBetween, slaState } from '../core/sla.js';
import type { AuthCtx, Scope } from '../core/types.js';

/* ───────────────────────── constants ───────────────────────── */

// Verified against enum_range(null::gw.proc_req_status).
const STATUSES = ['Raised', 'Assigned', 'Sourcing', 'AwaitingSupplier', 'Responded', 'Cancelled'] as const;
type Status = typeof STATUSES[number];
const OPEN_STATUSES: readonly Status[] = ['Raised', 'Assigned', 'Sourcing', 'AwaitingSupplier'];

/**
 * Raised → Assigned → Sourcing → AwaitingSupplier ↔ Sourcing → Responded.
 * Cancelled is reachable from every status that has not yet Responded.
 * Responded is reached from Sourcing only (or implicitly, by recording a supplier quotation).
 */
const NEXT: Record<Status, readonly Status[]> = {
  Raised: ['Assigned', 'Cancelled'],
  Assigned: ['Sourcing', 'Cancelled'],
  Sourcing: ['AwaitingSupplier', 'Responded', 'Cancelled'],
  AwaitingSupplier: ['Sourcing', 'Cancelled'],
  Responded: [],
  Cancelled: [],
};

const TIMER = 'PROC_RESPONSE';
const ENTITY = 'procurement_requests';
const BASE_CCY = 'AED';
const MAX_QUEUE_SCAN = 2000;

/* ───────────────────────── validation ───────────────────────── */

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD');
const ccy = z.string().length(3).transform((s) => s.toUpperCase());
const money = z.number().nonnegative().max(1e14);
const text = (max = 255) => z.string().trim().min(1).max(max);
const urgencyEnum = z.enum(['Normal', 'Urgent']);
const statusEnum = z.enum(STATUSES);
const statusList = z
  .string()
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
  .pipe(z.array(statusEnum).min(1));

const idParam = z.object({ id: uuid });

const queueQuery = z.object({
  status: statusList.optional(),
  assignedTo: uuid.optional(),
  urgency: urgencyEnum.optional(),
  enquiryId: uuid.optional(),
  slaState: z.enum(['Within', 'Approaching', 'Breached']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(500).optional(),
});

const slaQuery = z.object({
  days: z.coerce.number().int().min(1).max(730).default(90),
});

const requestLineIn = z.object({
  enquiryLineId: uuid.nullish(),
  productSkuId: uuid.nullish(),
  manufacturerId: uuid.nullish(),
  partNumber: text().nullish(),
  description: text(2000),
  quantity: z.number().positive().max(1e9),
});

const createRequestBody = z.object({
  enquiryId: uuid,
  urgency: urgencyEnum.default('Normal'),
  requiredBy: isoDate.nullish(),
  remarks: z.string().trim().max(10000).nullish(),
  lines: z.array(requestLineIn).min(1, 'Add at least one line to source'),
});

const assignBody = z.object({ assignedTo: uuid });

const statusBody = z.object({
  status: statusEnum,
  remarks: z.string().trim().max(10000).nullish(),
  // Required when moving to AwaitingSupplier: the clock only pauses while an outbound RFQ is really open.
  rfq: z
    .object({
      supplierIds: z.array(uuid).min(1).max(50),
      reference: text().nullish(),
    })
    .optional(),
});

const quoteLineIn = z.object({
  requestLineId: uuid.nullish(),
  productSkuId: uuid.nullish(),
  partNumber: text().nullish(),
  description: text(2000).nullish(),
  quantity: z.number().positive().max(1e9).optional(),
  unitCost: money,
  availability: text().nullish(),
  leadTimeDays: z.number().int().min(0).max(3650).nullish(),
  taxCodeId: uuid.nullish(),
});

const createQuoteBody = z.object({
  supplierId: uuid,
  supplierRef: text().nullish(),
  quoteDate: isoDate.optional(),
  validUntil: isoDate.nullish(),
  currency: ccy.optional(),
  fxRate: z.number().positive().max(1e9).nullish(),
  fxRateDate: isoDate.nullish(),
  paymentTermsDays: z.number().int().min(0).max(1000).nullish(),
  remarks: z.string().trim().max(10000).nullish(),
  lines: z.array(quoteLineIn).min(1, 'Add at least one quoted line'),
});

const recommendBody = z.object({
  reason: z.string().trim().min(5, 'Say why this supplier is recommended (price, lead time, terms, risk).').max(5000),
});

/* ───────────────────────── small helpers ───────────────────────── */

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

/** Turns database constraint failures into messages a person can act on. */
function pgToApp(e: unknown): unknown {
  if (e instanceof AppError) return e;
  const err = e as { code?: string } | null;
  switch (err?.code) {
    case '23503':
      return badRequest(
        'invalid_reference',
        'A linked record (enquiry, enquiry line, supplier, product, manufacturer or assignee) does not exist or is no longer available. Refresh the form and pick it again.',
      );
    case '23505':
      return conflict('duplicate', 'A record with the same unique reference already exists. Refresh and try again.');
    case '23514':
      return badRequest('constraint_failed', 'One of the values breaks a business rule. Check the amounts and dates and try again.');
    case '22007':
    case '22008':
    case '22P02':
    case '22003':
      return badRequest('invalid_value', 'A date, number or ID in the request is malformed or out of range.');
    default:
      return e;
  }
}
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw pgToApp(e);
  }
}

const txCtx = (ctx: AuthCtx, scope: Scope) => ({
  userId: ctx.userId,
  employeeId: ctx.employeeId,
  sbuId: ctx.sbuIds[0] ?? null,
  scope,
});

const encodeCursor = (o: Record<string, unknown>) => Buffer.from(JSON.stringify(o)).toString('base64url');
function decodeOffset(c: string | undefined): number {
  if (!c) return 0;
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as { o?: unknown };
    if (typeof v?.o === 'number' && Number.isInteger(v.o) && v.o >= 0) return v.o;
  } catch { /* fall through */ }
  throw badRequest('bad_cursor', 'That page marker is no longer valid. Reload the list from the first page.');
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

type Run = (sql: string, params: unknown[]) => Promise<Row[]>;
const runPool: Run = (sql, params) => q(sql, params as any[]);

/** Transaction time from the database, so pause arithmetic uses the same clock as raised_at. */
async function dbNow(c: pg.PoolClient): Promise<Date> {
  return (await c.query(`SELECT now() AS t`)).rows[0].t as Date;
}

/**
 * Scope for procurement requests. A request has no owner column of its own, so it follows its enquiry
 * (account manager / primary SBU / explicit share) and also stays visible to the person who raised it
 * or was assigned to it. Requires the enquiry joined as `e` and the request as `p`.
 */
function procScope(ctx: AuthCtx, scope: Scope, startIdx: number): { sql: string; params: any[] } {
  const sc = scopeSql(ctx, scope, { alias: 'e', ownerCol: 'account_manager_id', sbuCol: 'primary_sbu_id', entity: 'enquiries' }, startIdx);
  if (sc.sql === 'TRUE') return sc;
  const i = startIdx + sc.params.length;
  return {
    sql: `(${sc.sql} OR p.assigned_to = $${i} OR p.requested_by = $${i})`,
    params: [...sc.params, ctx.userId],
  };
}

/* ───────────────────────── live SLA ───────────────────────── */

/**
 * The request row plus everything needed to compute its clock. Nothing SLA-related is stored on the row:
 * elapsed, percentage and state are recalculated on every read.
 */
const REQ_SELECT = `
  SELECT p.id, p.request_no, p.enquiry_id, e.enquiry_no, e.title AS enquiry_title,
         e.customer_id, cu.name AS customer_name,
         p.status::text AS status, p.urgency::text AS urgency, p.required_by::text AS required_by,
         p.requested_by, ru.display_name AS requested_by_name,
         p.assigned_to, au.display_name AS assigned_to_name, p.assigned_at,
         p.raised_at, p.first_responded_at, p.paused_minutes, p.remarks,
         (SELECT count(*) FROM gw.procurement_request_lines l WHERE l.request_id = p.id)::int AS line_count,
         (SELECT count(*) FROM gw.supplier_quotes s WHERE s.request_id = p.id)::int AS supplier_quote_count,
         COALESCE(rule.target_hours, t.target_hours) AS target_hours,
         COALESCE(rule.warn_at_pct, 80) AS warn_at_pct,
         t.stopped_at AS timer_stopped_at,
         ps.value->>'at' AS pause_started_at,
         ps.value->'rfq' AS open_rfq
    FROM gw.procurement_requests p
    JOIN gw.enquiries e ON e.id = p.enquiry_id
    JOIN gw.customers cu ON cu.id = e.customer_id
    LEFT JOIN gw.users ru ON ru.id = p.requested_by
    LEFT JOIN gw.users au ON au.id = p.assigned_to
    LEFT JOIN gw.sla_timers t
           ON t.timer_code = '${TIMER}' AND t.entity_type = '${ENTITY}' AND t.entity_id = p.id
    LEFT JOIN gw.settings ps ON ps.key = 'pause.' || p.id::text
    LEFT JOIN LATERAL (
      SELECT r.target_hours, r.warn_at_pct
        FROM gw.sla_rules r
       WHERE r.timer_code = '${TIMER}' AND r.urgency = p.urgency AND r.is_active
         AND r.effective_from <= p.raised_at::date AND (r.effective_to IS NULL OR r.effective_to >= p.raised_at::date)
       ORDER BY r.effective_from DESC LIMIT 1
    ) rule ON true`;

type Clock = 'running' | 'paused' | 'stopped';

/**
 * Elapsed working hours (Dubai calendar, OD-18) from raised_at to the first response (or now),
 * minus the minutes already banked as paused and any RFQ pause that is open right now.
 */
async function withLiveSla(r: Row, now: Date): Promise<Row> {
  const endAt: Date | null = r.first_responded_at
    ? new Date(r.first_responded_at)
    : r.timer_stopped_at ? new Date(r.timer_stopped_at) : null;
  const gross = await workingHoursBetween(new Date(r.raised_at), endAt ?? now);
  let pausedHours = Number(r.paused_minutes) / 60;
  let clock: Clock = endAt ? 'stopped' : 'running';
  if (!endAt && r.pause_started_at) {
    pausedHours += await workingHoursBetween(new Date(r.pause_started_at), now);
    clock = 'paused';
  }
  const elapsed = round2(Math.max(0, gross - pausedHours));
  const target = r.target_hours == null ? null : Number(r.target_hours);
  const warn = r.warn_at_pct == null ? 80 : Number(r.warn_at_pct);
  const { timer_stopped_at, warn_at_pct, ...rest } = r;
  void timer_stopped_at; void warn_at_pct;
  return {
    ...rest,
    elapsed_working_hours: elapsed,
    target_hours: target,
    pct_of_target: target && target > 0 ? round1((elapsed / target) * 100) : null,
    sla_state: target == null ? 'Within' : slaState(elapsed, target, warn),
    sla_clock: clock,
  };
}

/** Open clocks first (most elapsed against target at the top), then finished ones, newest first. */
function byUrgency(a: Row, b: Row): number {
  const ao = a.sla_clock !== 'stopped';
  const bo = b.sla_clock !== 'stopped';
  if (ao !== bo) return ao ? -1 : 1;
  const ap = a.pct_of_target ?? -1;
  const bp = b.pct_of_target ?? -1;
  if (ap !== bp) return bp - ap;
  return new Date(a.raised_at).getTime() - new Date(b.raised_at).getTime();
}

async function liveRequestById(id: string): Promise<Row> {
  const r = await q1(`${REQ_SELECT} WHERE p.id = $1`, [id]);
  if (!r) throw notFound('Procurement request');
  return withLiveSla(r, new Date());
}

/* ───────────────────────── SLA pause and timer ───────────────────────── */

/*
 * procurement_requests has no pause-start column, so the start of an open RFQ pause lives in
 * gw.settings under `pause.<requestId>` (value: { at, kind, rfq }). gw.settings is not audited and not
 * partitioned, and one row exists only while a pause is open. Leaving AwaitingSupplier deletes it and
 * banks the elapsed *working* minutes on procurement_requests.paused_minutes and sla_timers.paused_minutes.
 */
const pauseKey = (id: string) => `pause.${id}`;

async function openPause(c: pg.PoolClient, id: string, now: Date, userId: string, payload: Record<string, unknown>) {
  await c.query(
    `INSERT INTO gw.settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [pauseKey(id), JSON.stringify({ at: now.toISOString(), ...payload }), userId]);
  await c.query(
    `UPDATE gw.sla_timers SET state = 'Paused'
      WHERE timer_code = $1 AND entity_type = $2 AND entity_id = $3 AND stopped_at IS NULL`,
    [TIMER, ENTITY, id]);
}

/** Banks the working minutes of the open pause (if any). Returns the minutes added. */
async function closePause(c: pg.PoolClient, id: string, now: Date): Promise<number> {
  const del = await c.query(`DELETE FROM gw.settings WHERE key = $1 RETURNING value`, [pauseKey(id)]);
  if (!del.rows.length) return 0;
  const minutes = Math.round((await workingHoursBetween(new Date(del.rows[0].value.at), now)) * 60);
  if (minutes > 0) {
    await c.query(`UPDATE gw.procurement_requests SET paused_minutes = paused_minutes + $2 WHERE id = $1`, [id, minutes]);
    await c.query(
      `UPDATE gw.sla_timers SET paused_minutes = paused_minutes + $4
        WHERE timer_code = $1 AND entity_type = $2 AND entity_id = $3 AND stopped_at IS NULL`,
      [TIMER, ENTITY, id, minutes]);
  }
  await c.query(
    `UPDATE gw.sla_timers SET state = 'Within'
      WHERE timer_code = $1 AND entity_type = $2 AND entity_id = $3 AND stopped_at IS NULL AND state = 'Paused'`,
    [TIMER, ENTITY, id]);
  return minutes;
}

/**
 * Stops the timer. core/sla.stopTimer reads sla_timers through the pool, so it cannot see pause minutes banked
 * earlier in this same transaction; recompute the final figure here from the transaction's own view.
 */
async function finishTimer(c: pg.PoolClient, id: string) {
  const stopped = await stopTimer(c, TIMER, ENTITY, id);
  if (!stopped) return;
  const t = (await c.query(
    `SELECT id, started_at, stopped_at, target_hours, paused_minutes FROM gw.sla_timers
      WHERE timer_code = $1 AND entity_type = $2 AND entity_id = $3`, [TIMER, ENTITY, id])).rows[0];
  if (!t?.stopped_at) return;
  const gross = await workingHoursBetween(new Date(t.started_at), new Date(t.stopped_at));
  const elapsed = round2(Math.max(0, gross - Number(t.paused_minutes) / 60));
  await c.query(
    `UPDATE gw.sla_timers SET elapsed_working_hours = $2, state = $3 WHERE id = $1`,
    [t.id, elapsed, slaState(elapsed, Number(t.target_hours)) === 'Breached' ? 'Breached' : 'Stopped']);
}

/* ───────────────────────── loaders ───────────────────────── */

async function lockRequest(c: pg.PoolClient, ctx: AuthCtx, scope: Scope, id: string): Promise<Row> {
  const sc = procScope(ctx, scope, 2);
  const r = await c.query(
    `SELECT p.id, p.request_no, p.status::text AS status, p.assigned_to, p.first_responded_at, p.urgency::text AS urgency,
            e.id AS enquiry_id, e.company_id
       FROM gw.procurement_requests p JOIN gw.enquiries e ON e.id = p.enquiry_id
      WHERE p.id = $1 AND e.deleted_at IS NULL AND ${sc.sql}
      FOR UPDATE OF p`,
    [id, ...sc.params]);
  if (!r.rows.length) throw notFound('Procurement request');
  return r.rows[0];
}

async function loadRequestLines(run: Run, requestId: string): Promise<Row[]> {
  return run(
    `SELECT l.id, l.enquiry_line_id, el.line_no AS enquiry_line_no, l.product_sku_id, l.manufacturer_id,
            m.name AS manufacturer_name, l.part_number, l.description, l.quantity
       FROM gw.procurement_request_lines l
       LEFT JOIN gw.enquiry_lines el ON el.id = l.enquiry_line_id
       LEFT JOIN gw.manufacturers m ON m.id = l.manufacturer_id
      WHERE l.request_id = $1
      ORDER BY el.line_no NULLS LAST, l.part_number NULLS LAST, l.description`, [requestId]);
}

/** Supplier quotations of one request with their lines, masked for the caller. */
async function loadQuotes(ctx: AuthCtx, run: Run, where: string, params: unknown[]): Promise<Row[]> {
  const quotes = await run(
    `SELECT sq.id, sq.quote_no, sq.request_id, sq.supplier_id, s.supplier_code, s.name AS supplier_name,
            sq.supplier_ref, sq.quote_date::text AS quote_date, sq.valid_until::text AS valid_until,
            sq.currency, sq.fx_rate, sq.fx_rate_date::text AS fx_rate_date, sq.payment_terms_days,
            sq.recorded_at, sq.recorded_by, u.display_name AS recorded_by_name,
            sq.is_recommended, sq.recommendation_reason, sq.remarks
       FROM gw.supplier_quotes sq
       JOIN gw.suppliers s ON s.id = sq.supplier_id
       LEFT JOIN gw.users u ON u.id = sq.recorded_by
      WHERE ${where}
      ORDER BY sq.recorded_at, sq.quote_no`, params);
  if (!quotes.length) return [];
  const lines = await run(
    `SELECT sl.id, sl.supplier_quote_id, sl.request_line_id, sl.product_sku_id,
            COALESCE(sl.part_number, k.part_number) AS part_number,
            COALESCE(sl.description, prl.description) AS description,
            sl.quantity, sl.unit_cost, sl.availability, sl.lead_time_days, sl.tax_code_id
       FROM gw.supplier_quote_lines sl
       LEFT JOIN gw.product_skus k ON k.id = sl.product_sku_id
       LEFT JOIN gw.procurement_request_lines prl ON prl.id = sl.request_line_id
      WHERE sl.supplier_quote_id = ANY($1::uuid[])
      ORDER BY COALESCE(sl.part_number, k.part_number) NULLS LAST, sl.description NULLS LAST`,
    [quotes.map((x) => x.id)]);
  const byQuote = new Map<string, Row[]>();
  for (const l of lines) {
    const arr = byQuote.get(l.supplier_quote_id) ?? [];
    arr.push(mask(ctx, 'supplier_quote_lines', l));
    byQuote.set(l.supplier_quote_id, arr);
  }
  return quotes.map((x) => ({ ...mask(ctx, 'supplier_quotes', x), lines: byQuote.get(x.id) ?? [] }));
}

/* ───────────────────────── SLA roll-up ───────────────────────── */

interface Bucket { total: number; Within: number; Approaching: number; Breached: number; elapsed_sum: number }
const newBucket = (): Bucket => ({ total: 0, Within: 0, Approaching: 0, Breached: 0, elapsed_sum: 0 });
function addToBucket(b: Bucket, row: Row) {
  b.total += 1;
  b[row.sla_state as 'Within' | 'Approaching' | 'Breached'] += 1;
  b.elapsed_sum += row.elapsed_working_hours;
}
function bucketOut(b: Bucket) {
  return {
    total: b.total, Within: b.Within, Approaching: b.Approaching, Breached: b.Breached,
    average_elapsed_hours: b.total ? round2(b.elapsed_sum / b.total) : null,
  };
}

/* ───────────────────────── routes ───────────────────────── */

export async function procurementRoutes(app: FastifyInstance) {
  /* ═════════════ Queue ═════════════ */

  app.get('/api/v1/procurement/requests', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'procurement_requests.view');
    const qs = parse(queueQuery, req.query);

    const sc = procScope(ctx, scope, 1);
    const params: any[] = [...sc.params];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const w: string[] = ['e.deleted_at IS NULL', sc.sql];
    // The queue means "work still to do" unless the caller asks for other statuses explicitly.
    w.push(`p.status::text = ANY(${p(qs.status ?? OPEN_STATUSES)}::text[])`);
    if (qs.assignedTo) w.push(`p.assigned_to = ${p(qs.assignedTo)}`);
    if (qs.urgency) w.push(`p.urgency::text = ${p(qs.urgency)}`);
    if (qs.enquiryId) w.push(`p.enquiry_id = ${p(qs.enquiryId)}`);

    const rows = await q(`${REQ_SELECT} WHERE ${w.join(' AND ')} ORDER BY p.raised_at DESC LIMIT ${MAX_QUEUE_SCAN}`, params);
    const now = new Date();
    let live = await Promise.all(rows.map((r) => withLiveSla(r, now)));
    if (qs.slaState) live = live.filter((r) => r.sla_state === qs.slaState);
    live.sort(byUrgency);

    const offset = decodeOffset(qs.cursor);
    const page = live.slice(offset, offset + qs.limit);
    const more = live.length > offset + qs.limit;
    return { data: page, nextCursor: more ? encodeCursor({ o: offset + qs.limit }) : null };
  });

  /* ═════════════ One request ═════════════ */

  app.get('/api/v1/procurement/requests/:id', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'procurement_requests.view');
    const { id } = parse(idParam, req.params);
    const sc = procScope(ctx, scope, 2);
    const head = await q1(`${REQ_SELECT} WHERE p.id = $1 AND e.deleted_at IS NULL AND ${sc.sql}`, [id, ...sc.params]);
    if (!head) throw notFound('Procurement request');

    const canQuotes = scopeFor(ctx, 'supplier_quotes.view') !== null;
    const [live, lines, quotes] = await Promise.all([
      withLiveSla(head, new Date()),
      loadRequestLines(runPool, id),
      canQuotes ? loadQuotes(ctx, runPool, 'sq.request_id = $1', [id]) : Promise.resolve(null),
    ]);
    // null = the caller does not hold supplier_quotes.view (distinct from "none yet" = [])
    return { data: { ...live, lines, supplier_quotes: quotes } };
  });

  /* ═════════════ Raise ═════════════ */

  app.post('/api/v1/procurement/requests', async (req, reply) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'procurement_requests.create');
    const b = parse(createRequestBody, req.body);

    const id = await guard(() => tx(txCtx(ctx, scope), async (c) => {
      const esc = scopeSql(ctx, scope, { alias: 'e', ownerCol: 'account_manager_id', sbuCol: 'primary_sbu_id', entity: 'enquiries' }, 2);
      const enq = (await c.query(
        `SELECT e.id, e.company_id FROM gw.enquiries e WHERE e.id = $1 AND e.deleted_at IS NULL AND ${esc.sql}`,
        [b.enquiryId, ...esc.params])).rows[0];
      if (!enq) throw notFound('Enquiry');

      for (const l of b.lines) {
        if (!l.enquiryLineId) continue;
        const ok = await c.query(`SELECT 1 FROM gw.enquiry_lines WHERE id = $1 AND enquiry_id = $2`, [l.enquiryLineId, b.enquiryId]);
        if (!ok.rows.length) throw badRequest('unknown_enquiry_line', 'One of the lines points at an enquiry line that does not belong to this enquiry.');
      }

      const requestNo = await nextNumber(c, 'procurement_request', enq.company_id, 'PRQ');
      const ins = await c.query(
        `INSERT INTO gw.procurement_requests (request_no, enquiry_id, requested_by, urgency, required_by, remarks, status)
         VALUES ($1,$2,$3,$4,$5,$6,'Raised') RETURNING id`,
        [requestNo, b.enquiryId, ctx.userId, b.urgency, b.requiredBy ?? null, b.remarks ?? null]);
      const rid = ins.rows[0].id as string;

      for (const l of b.lines) {
        // Manufacturer and part number default from the SKU so the price history can match later.
        const ln = await c.query(
          `INSERT INTO gw.procurement_request_lines
             (request_id, enquiry_line_id, product_sku_id, manufacturer_id, part_number, description, quantity)
           VALUES ($1,$2,$3::uuid,
                   COALESCE($4::uuid, (SELECT p.manufacturer_id FROM gw.product_skus k JOIN gw.products p ON p.id = k.product_id WHERE k.id = $3::uuid)),
                   COALESCE($5::text, (SELECT k.part_number FROM gw.product_skus k WHERE k.id = $3::uuid)),
                   $6,$7)
           RETURNING id`,
          [rid, l.enquiryLineId ?? null, l.productSkuId ?? null, l.manufacturerId ?? null, l.partNumber ?? null, l.description, l.quantity]);
        await audit(c, ctx, { entityType: 'procurement_request_lines', entityId: ln.rows[0].id, action: 'create' });
      }

      await startTimer(c, { timerCode: TIMER, entityType: ENTITY, entityId: rid, urgency: b.urgency });
      await audit(c, ctx, { entityType: ENTITY, entityId: rid, action: 'create' });
      return rid;
    }));

    reply.code(201);
    const [live, lines] = await Promise.all([liveRequestById(id), loadRequestLines(runPool, id)]);
    return { data: { ...live, lines } };
  });

  /* ═════════════ Assign ═════════════ */

  app.patch('/api/v1/procurement/requests/:id/assign', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'procurement_requests.edit');
    const { id } = parse(idParam, req.params);
    const b = parse(assignBody, req.body);

    await guard(() => tx(txCtx(ctx, scope), async (c) => {
      const cur = await lockRequest(c, ctx, scope, id);
      if (cur.status === 'Responded' || cur.status === 'Cancelled')
        throw gateBlocked(`This request is already ${cur.status}, so it cannot be reassigned. Raise a new procurement request if more sourcing is needed.`);

      // The assignee must be able to answer the request, i.e. to record supplier quotations. (Sales also hold
      // procurement_requests.edit, for their own requests, so that key alone does not make someone a buyer.)
      const who = await c.query(
        `SELECT u.id FROM gw.users u
          WHERE u.id = $1 AND u.is_active AND u.deleted_at IS NULL
            AND EXISTS (SELECT 1 FROM gw.user_roles ur
                          JOIN gw.role_permissions rp ON rp.role_id = ur.role_id
                          JOIN gw.permissions pm ON pm.id = rp.permission_id
                         WHERE ur.user_id = u.id AND pm.key = 'supplier_quotes.create')`, [b.assignedTo]);
      if (!who.rows.length)
        throw badRequest('assignee_not_eligible', 'That person is inactive or cannot work procurement requests. Choose someone from the procurement team.');

      // Raised → Assigned. A reassignment part-way through sourcing keeps the current status and its clock.
      await c.query(
        `UPDATE gw.procurement_requests
            SET assigned_to = $2, assigned_at = now(),
                status = CASE WHEN status = 'Raised' THEN 'Assigned'::gw.proc_req_status ELSE status END,
                row_version = row_version + 1
          WHERE id = $1`, [id, b.assignedTo]);
      await c.query(
        `UPDATE gw.sla_timers SET owner_user_id = $4
          WHERE timer_code = $1 AND entity_type = $2 AND entity_id = $3`, [TIMER, ENTITY, id, b.assignedTo]);
    }));

    return { data: await liveRequestById(id) };
  });

  /* ═════════════ Status ═════════════ */

  app.post('/api/v1/procurement/requests/:id/status', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'procurement_requests.edit');
    const { id } = parse(idParam, req.params);
    const b = parse(statusBody, req.body);

    await guard(() => tx(txCtx(ctx, scope), async (c) => {
      const cur = await lockRequest(c, ctx, scope, id);
      const from = cur.status as Status;
      const legal = NEXT[from];
      if (!legal.includes(b.status)) {
        throw gateBlocked(
          legal.length
            ? `A request that is ${from} can only move to ${legal.join(' or ')}, not ${b.status}.`
            : `This request is ${from} and is closed, so its status cannot change any more.`,
          { from, requested: b.status, allowed: legal });
      }
      const now = await dbNow(c);

      if (b.status === 'Assigned' && !cur.assigned_to)
        throw gateBlocked('Assign the request to a person first (PATCH …/assign) — that is what moves it to Assigned.');
      if (b.status === 'Responded') {
        const n = (await c.query(`SELECT count(*)::int AS n FROM gw.supplier_quotes WHERE request_id = $1`, [id])).rows[0].n as number;
        if (n === 0)
          throw gateBlocked('Record at least one supplier quotation before marking this request Responded.');
      }

      // Leaving AwaitingSupplier always ends the pause first, so its minutes are banked before anything else.
      if (from === 'AwaitingSupplier') await closePause(c, id, now);

      if (b.status === 'AwaitingSupplier') {
        if (!b.rfq)
          throw gateBlocked('Say which supplier(s) the RFQ went to. The SLA clock only pauses while an outbound RFQ is genuinely open.');
        const sup = (await c.query(
          `SELECT id, name FROM gw.suppliers WHERE id = ANY($1::uuid[]) AND is_active`, [b.rfq.supplierIds])).rows;
        if (sup.length !== new Set(b.rfq.supplierIds).size)
          throw badRequest('unknown_supplier', 'One of the RFQ suppliers does not exist or is inactive. Pick them from the supplier list.');
        await openPause(c, id, now, ctx.userId, {
          kind: 'rfq_open',
          rfq: { suppliers: sup.map((s) => ({ id: s.id, name: s.name })), reference: b.rfq.reference ?? null },
        });
      }

      await c.query(
        `UPDATE gw.procurement_requests
            SET status = $2::gw.proc_req_status,
                first_responded_at = CASE WHEN $2 = 'Responded' THEN COALESCE(first_responded_at, $3::timestamptz) ELSE first_responded_at END,
                remarks = COALESCE($4, remarks),
                row_version = row_version + 1
          WHERE id = $1`, [id, b.status, now, b.remarks ?? null]);

      if (b.status === 'Responded' || b.status === 'Cancelled') await finishTimer(c, id);
    }));

    return { data: await liveRequestById(id) };
  });

  /* ═════════════ Record a supplier quotation ═════════════ */

  app.post('/api/v1/procurement/requests/:id/supplier-quotes', async (req, reply) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'supplier_quotes.create');
    const { id } = parse(idParam, req.params);
    const b = parse(createQuoteBody, req.body);
    if (b.quoteDate && b.validUntil && b.validUntil < b.quoteDate)
      throw badRequest('validity_before_quote', 'The quotation cannot expire before the day it was issued. Check the valid-until date.');

    const quoteId = await guard(() => tx(txCtx(ctx, scope), async (c) => {
      const cur = await lockRequest(c, ctx, scope, id);
      const from = cur.status as Status;
      if (from === 'Cancelled') throw gateBlocked('This request was cancelled, so quotations cannot be recorded against it.');
      if (from === 'Raised') throw gateBlocked('Assign the request to a buyer before recording supplier quotations against it.');

      const sup = (await c.query(
        `SELECT id, default_currency, payment_terms_days FROM gw.suppliers WHERE id = $1 AND is_active`, [b.supplierId])).rows[0];
      if (!sup) throw badRequest('unknown_supplier', 'That supplier does not exist or is inactive. Pick one from the supplier list.');

      // The cost_price_points trigger converts with this rate, so a foreign-currency quote must carry one.
      const currency = (b.currency ?? (sup.default_currency as string).trim()) as string;
      let fxRate: number | null = b.fxRate ?? null;
      let fxDate: string | null = b.fxRateDate ?? null;
      if (currency === BASE_CCY) { fxRate = 1; fxDate = null; }
      else if (fxRate == null) {
        const fx = (await c.query(
          `SELECT rate, rate_date::text AS rate_date FROM gw.fx_rates
            WHERE from_currency = $1 AND to_currency = $2 ORDER BY rate_date DESC LIMIT 1`, [currency, BASE_CCY])).rows[0];
        if (!fx) throw badRequest('fx_rate_required', `Enter the exchange rate from ${currency} to ${BASE_CCY} — none is on file.`);
        fxRate = Number(fx.rate); fxDate = fx.rate_date as string;
      }

      const quoteNo = await nextNumber(c, 'supplier_quote', cur.company_id, 'SQ');
      const ins = await c.query(
        `INSERT INTO gw.supplier_quotes
           (quote_no, request_id, supplier_id, supplier_ref, quote_date, valid_until, currency, fx_rate, fx_rate_date,
            payment_terms_days, recorded_by, remarks)
         VALUES ($1,$2,$3,$4, COALESCE($5::date, (now() AT TIME ZONE 'Asia/Dubai')::date), $6,$7,$8,$9,$10,$11,$12)
         RETURNING id`,
        [quoteNo, id, b.supplierId, b.supplierRef ?? null, b.quoteDate ?? null, b.validUntil ?? null, currency, fxRate, fxDate,
         b.paymentTermsDays ?? sup.payment_terms_days ?? null, ctx.userId, b.remarks ?? null]);
      const sqId = ins.rows[0].id as string;

      for (const l of b.lines) {
        let prl: Row | null = null;
        if (l.requestLineId) {
          prl = (await c.query(
            `SELECT product_sku_id, part_number, description, quantity FROM gw.procurement_request_lines
              WHERE id = $1 AND request_id = $2`, [l.requestLineId, id])).rows[0] ?? null;
          if (!prl) throw badRequest('unknown_request_line', 'A quoted line points at a request line that does not belong to this procurement request.');
        }
        const skuId = (l.productSkuId ?? prl?.product_sku_id ?? null) as string | null;
        let partNumber = (l.partNumber ?? prl?.part_number ?? null) as string | null;
        if (!partNumber && skuId) {
          partNumber = (await c.query(`SELECT part_number FROM gw.product_skus WHERE id = $1`, [skuId])).rows[0]?.part_number ?? null;
        }
        const description = (l.description ?? prl?.description ?? null) as string | null;
        const quantity = l.quantity ?? (prl ? Number(prl.quantity) : undefined);
        if (quantity == null) throw badRequest('quantity_required', 'Enter the quoted quantity for every line that is not tied to a request line.');
        if (!partNumber && !description)
          throw badRequest('line_unidentified', 'Each quoted line needs a part number, a request line, or a description so it can be compared later.');

        // The AFTER INSERT trigger writes the cost_price_points row; nothing here touches that table.
        await c.query(
          `INSERT INTO gw.supplier_quote_lines
             (supplier_quote_id, request_line_id, product_sku_id, part_number, description, quantity, unit_cost,
              availability, lead_time_days, tax_code_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [sqId, l.requestLineId ?? null, skuId, partNumber, description, quantity, l.unitCost,
           l.availability ?? null, l.leadTimeDays ?? null, l.taxCodeId ?? null]);
      }

      // First answer: close any open RFQ pause, flip to Responded and stop the clock.
      // Later quotations on an already-Responded request are simply added.
      if (from !== 'Responded') {
        const now = await dbNow(c);
        if (from === 'AwaitingSupplier') await closePause(c, id, now);
        await c.query(
          `UPDATE gw.procurement_requests
              SET status = 'Responded', first_responded_at = COALESCE(first_responded_at, $2::timestamptz), row_version = row_version + 1
            WHERE id = $1`, [id, now]);
        await finishTimer(c, id);
      }
      await audit(c, ctx, { entityType: 'supplier_quotes', entityId: sqId, action: 'create' });
      return sqId;
    }));

    reply.code(201);
    const [quote] = await loadQuotes(ctx, runPool, 'sq.id = $1', [quoteId]);
    return { data: quote };
  });

  /* ═════════════ Recommend ═════════════ */

  app.post('/api/v1/supplier-quotes/:id/recommend', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'supplier_quotes.edit');
    const { id } = parse(idParam, req.params);
    const b = parse(recommendBody, req.body);

    await guard(() => tx(txCtx(ctx, scope), async (c) => {
      const sc = procScope(ctx, scope, 2);
      // Locking the parent request serialises two buyers flipping the recommendation at once.
      const cur = (await c.query(
        `SELECT sq.id, sq.request_id, p.status::text AS request_status
           FROM gw.supplier_quotes sq
           JOIN gw.procurement_requests p ON p.id = sq.request_id
           JOIN gw.enquiries e ON e.id = p.enquiry_id
          WHERE sq.id = $1 AND e.deleted_at IS NULL AND ${sc.sql}
          FOR UPDATE OF p`, [id, ...sc.params])).rows[0];
      if (!cur) throw notFound('Supplier quotation');
      if (cur.request_status === 'Cancelled')
        throw gateBlocked('This request was cancelled, so no supplier can be recommended on it.');

      const others = (await c.query(
        `UPDATE gw.supplier_quotes SET is_recommended = false, recommendation_reason = NULL
          WHERE request_id = $1 AND id <> $2 AND is_recommended RETURNING id`, [cur.request_id, id])).rows;
      for (const o of others)
        await audit(c, ctx, { entityType: 'supplier_quotes', entityId: o.id, action: 'update', field: 'is_recommended', oldValue: true, newValue: false, reason: 'Another quotation was recommended instead' });

      await c.query(`UPDATE gw.supplier_quotes SET is_recommended = true, recommendation_reason = $2 WHERE id = $1`, [id, b.reason]);
      await audit(c, ctx, { entityType: 'supplier_quotes', entityId: id, action: 'update', field: 'is_recommended', oldValue: false, newValue: true, reason: b.reason });
    }));

    const [quote] = await loadQuotes(ctx, runPool, 'sq.id = $1', [id]);
    return { data: quote };
  });

  /* ═════════════ Comparison grid ═════════════ */

  app.get('/api/v1/procurement/requests/:id/comparison', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'procurement_requests.view');
    require_(ctx, 'supplier_quotes.view');
    const { id } = parse(idParam, req.params);
    const sc = procScope(ctx, scope, 2);
    const head = await q1(
      `SELECT p.id, p.request_no, p.status::text AS status, p.urgency::text AS urgency, e.enquiry_no
         FROM gw.procurement_requests p JOIN gw.enquiries e ON e.id = p.enquiry_id
        WHERE p.id = $1 AND e.deleted_at IS NULL AND ${sc.sql}`, [id, ...sc.params]);
    if (!head) throw notFound('Procurement request');

    // Prices and the percentage against history are cost information: they follow the supplier_cost group.
    const canCost = ctx.fields.has('supplier_cost');

    const [lines, cells] = await Promise.all([
      loadRequestLines(runPool, id),
      q(
        `SELECT sq.id AS quote_id, sq.quote_no, sq.supplier_id, s.name AS supplier_name, sq.currency, sq.is_recommended,
                sq.payment_terms_days, sq.valid_until::text AS valid_until, sq.quote_date::text AS quote_date,
                sl.id AS quote_line_id, sl.request_line_id, sl.quantity, sl.unit_cost,
                (sl.unit_cost * COALESCE(sq.fx_rate, 1)) AS unit_cost_base,
                sl.availability, sl.lead_time_days,
                pn.part_number, COALESCE(sl.description, prl.description) AS description,
                lp.supplier_id AS lp_supplier_id, lp.supplier_name AS lp_supplier_name, lp.quote_no AS lp_quote_no,
                lp.unit_cost AS lp_unit_cost, lp.unit_cost_base AS lp_unit_cost_base, lp.currency AS lp_currency,
                lp.quoted_on::text AS lp_quoted_on,
                ROUND((sl.unit_cost * COALESCE(sq.fx_rate, 1) - lp.unit_cost_base) / NULLIF(lp.unit_cost_base, 0) * 100, 2) AS delta_pct
           FROM gw.supplier_quotes sq
           JOIN gw.suppliers s ON s.id = sq.supplier_id
           JOIN gw.supplier_quote_lines sl ON sl.supplier_quote_id = sq.id
           LEFT JOIN gw.procurement_request_lines prl ON prl.id = sl.request_line_id
           LEFT JOIN gw.product_skus k ON k.id = COALESCE(sl.product_sku_id, prl.product_sku_id)
           CROSS JOIN LATERAL (SELECT COALESCE(sl.part_number, prl.part_number, k.part_number) AS part_number) pn
           LEFT JOIN LATERAL (
             -- most recent price for the same part from a DIFFERENT quotation (and a different request: peers are in the grid already)
             SELECT cp.unit_cost, cp.unit_cost_base, cp.currency, cp.quoted_on, cp.supplier_id, ls.name AS supplier_name, lsq.quote_no
               FROM gw.cost_price_points cp
               JOIN gw.supplier_quote_lines lsl ON lsl.id = cp.supplier_quote_line_id
               JOIN gw.supplier_quotes lsq ON lsq.id = lsl.supplier_quote_id
               JOIN gw.suppliers ls ON ls.id = cp.supplier_id
              WHERE pn.part_number IS NOT NULL AND pn.part_number <> 'UNSPECIFIED'
                AND cp.part_number = pn.part_number
                AND lsq.id <> sq.id AND lsq.request_id <> sq.request_id
                AND NOT cp.is_archived
              ORDER BY cp.quoted_on DESC, cp.recorded_at DESC
              LIMIT 1
           ) lp ON true
          WHERE sq.request_id = $1
          ORDER BY sq.recorded_at, sq.quote_no`, [id]),
    ]);

    const shape = (r: Row): Row => {
      let cell: Row = {
        quote_id: r.quote_id, quote_no: r.quote_no, supplier_id: r.supplier_id, supplier_name: r.supplier_name,
        currency: r.currency, is_recommended: r.is_recommended, quantity: r.quantity,
        availability: r.availability, lead_time_days: r.lead_time_days,
        payment_terms_days: r.payment_terms_days, valid_until: r.valid_until, quote_date: r.quote_date,
        unit_cost: r.unit_cost,
      };
      cell = mask(ctx, 'supplier_quote_lines', cell);   // unit_cost → supplier_cost
      cell = mask(ctx, 'supplier_quotes', cell);        // payment_terms_days → supplier_terms
      if (canCost) cell.unit_cost_base = r.unit_cost_base;
      if (r.lp_supplier_id) {
        const lp = mask(ctx, 'cost_price_points', {
          supplier_id: r.lp_supplier_id, supplier_name: r.lp_supplier_name, quote_no: r.lp_quote_no,
          unit_cost: r.lp_unit_cost, unit_cost_base: r.lp_unit_cost_base, currency: r.lp_currency, quoted_on: r.lp_quoted_on,
        });
        cell.last_purchase = lp;
        if (canCost && r.delta_pct != null) cell.delta_pct_vs_last_purchase = r.delta_pct;
      } else {
        cell.last_purchase = null;
      }
      return cell;
    };

    // Cheapest cell per line, by base-currency cost — only disclosed to callers who may see cost.
    const lowest = (group: Row[]): string | null => {
      if (!canCost || !group.length) return null;
      return group.reduce((a, b2) => (Number(b2.unit_cost_base) < Number(a.unit_cost_base) ? b2 : a)).quote_id as string;
    };

    const byLine = new Map<string, Row[]>();
    const extras: Row[] = [];
    for (const r of cells) {
      if (r.request_line_id) {
        const arr = byLine.get(r.request_line_id) ?? [];
        arr.push(r);
        byLine.set(r.request_line_id, arr);
      } else extras.push(r);
    }

    const suppliers = await q(
      `SELECT sq.id AS quote_id, sq.quote_no, sq.supplier_id, s.name AS supplier_name, sq.currency, sq.is_recommended,
              sq.recommendation_reason, sq.valid_until::text AS valid_until, sq.payment_terms_days
         FROM gw.supplier_quotes sq JOIN gw.suppliers s ON s.id = sq.supplier_id
        WHERE sq.request_id = $1 ORDER BY sq.recorded_at, sq.quote_no`, [id]);

    return {
      data: {
        request: head,
        suppliers: suppliers.map((s) => mask(ctx, 'supplier_quotes', s)),
        lines: lines.map((l) => {
          const raw = byLine.get(l.id) ?? [];
          return {
            request_line_id: l.id, enquiry_line_no: l.enquiry_line_no, part_number: l.part_number,
            description: l.description, quantity: l.quantity,
            lowest_quote_id: lowest(raw),
            offers: raw.map(shape),
          };
        }),
        // Quoted lines that answer no request line (alternates, add-ons) — never silently dropped.
        other_offers: extras.map((r) => ({ part_number: r.part_number, description: r.description, ...shape(r) })),
      },
    };
  });

  /* ═════════════ SLA summary ═════════════ */

  app.get('/api/v1/procurement/sla', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'procurement_requests.view');
    const qs = parse(slaQuery, req.query);

    const sc = procScope(ctx, scope, 1);
    const params: any[] = [...sc.params, qs.days];
    const rows = await q(
      `${REQ_SELECT}
        WHERE e.deleted_at IS NULL AND ${sc.sql} AND p.status <> 'Cancelled'
          AND p.raised_at >= now() - ($${params.length}::int * interval '1 day')
        LIMIT ${MAX_QUEUE_SCAN}`, params);
    const now = new Date();
    const live = await Promise.all(rows.map((r) => withLiveSla(r, now)));

    const all = newBucket();
    const open = newBucket();
    const byAssignee = new Map<string, { name: string | null; b: Bucket }>();
    for (const r of live) {
      addToBucket(all, r);
      if (r.sla_clock !== 'stopped') addToBucket(open, r);
      const key = r.assigned_to ?? 'unassigned';
      const e = byAssignee.get(key) ?? { name: r.assigned_to_name ?? null, b: newBucket() };
      addToBucket(e.b, r);
      byAssignee.set(key, e);
    }

    const { average_elapsed_hours, ...allCounts } = bucketOut(all);
    return {
      data: {
        window_days: qs.days,
        by_state: { Within: allCounts.Within, Approaching: allCounts.Approaching, Breached: allCounts.Breached },
        total: allCounts.total,
        average_elapsed_hours,
        open: bucketOut(open),
        by_assignee: [...byAssignee.entries()]
          .map(([key, e]) => ({ assigned_to: key === 'unassigned' ? null : key, assigned_to_name: e.name, ...bucketOut(e.b) }))
          .sort((a, b) => b.Breached - a.Breached || b.Approaching - a.Approaching || b.total - a.total),
      },
    };
  });
}
