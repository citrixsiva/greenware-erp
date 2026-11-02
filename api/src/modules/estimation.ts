import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { q, q1, tx } from '../core/db.js';
import type { Row } from '../core/db.js';
import { require_, scopeSql, mask } from '../core/rbac.js';
import { audit } from '../core/audit.js';
import { AppError, badRequest, notFound, gateBlocked, conflict } from '../core/errors.js';
import { nextNumber } from '../core/numbering.js';
import { startTimer, stopTimer, workingHoursBetween, slaState } from '../core/sla.js';
import type { AuthCtx, Scope } from '../core/types.js';

/* ───────────────────────── constants ───────────────────────── */

// Verified against enum_range(null::gw.est_req_status) and gw.resource_mode.
const STATUSES = ['Raised', 'Assigned', 'InReview', 'ClarificationNeeded', 'Submitted', 'Cancelled'] as const;
type Status = typeof STATUSES[number];
const OPEN_STATUSES: readonly Status[] = ['Raised', 'Assigned', 'InReview', 'ClarificationNeeded'];
const MODES = ['Onsite', 'Remote', 'Hybrid'] as const;

const TIMER = 'TECH_ESTIMATE';
const ENTITY = 'estimation_requests';
const MAX_QUEUE_SCAN = 2000;
const SERVICE_COST_REQUIRED = 'Enter the service cost — there is no day rate configured to derive it from (OD-10).';

/* ───────────────────────── validation ───────────────────────── */

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD');
const ccy = z.string().length(3).transform((s) => s.toUpperCase());
const money = z.number().nonnegative().max(1e14);
const text = (max = 255) => z.string().trim().min(1).max(max);
const longText = z.string().trim().max(20000);
const urgencyEnum = z.enum(['Normal', 'Urgent']);
const statusEnum = z.enum(STATUSES);
const modeEnum = z.enum(MODES);
const statusList = z
  .string()
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
  .pipe(z.array(statusEnum).min(1));

const idParam = z.object({ id: uuid });

const queueQuery = z.object({
  sbuId: uuid.optional(),
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
  sbuId: uuid.optional(),
});

const createBody = z.object({
  enquiryId: uuid,
  sbuId: uuid.nullish(),
  sbuIds: z.array(uuid).min(1).max(10).optional(),
  urgency: urgencyEnum.default('Normal'),
  requiredBy: isoDate.nullish(),
  scopeNotes: z.string().trim().max(20000).nullish(),
});

const assignBody = z.object({ assignedTo: uuid });
const clarifyBody = z.object({ question: z.string().trim().min(3, 'Write the question Sales needs to answer.').max(5000) });
const resumeBody = z.object({ answer: z.string().trim().max(5000).nullish() });
const cancelBody = z.object({ reason: z.string().trim().min(3, 'Say why this estimation request is being cancelled.').max(5000) });

const resourceIn = z.object({
  roleName: text(),
  seniorityBand: text().nullish(),
  headcount: z.number().int().min(1).max(1000).default(1),
  days: z.number().positive().max(100000),
  mode: modeEnum.default('Remote'),
});

const estimateBody = z.object({
  scopeUnderstanding: z.string().trim().min(1, 'Describe your understanding of the scope.').max(20000),
  proposedSolution: z.string().trim().min(1, 'Describe the proposed solution.').max(20000),
  totalDays: z.number().positive().max(1e6).optional(),
  mode: modeEnum.default('Remote'),
  travelRequired: z.boolean().default(false),
  travelCost: money.nullish(),
  // OD-10: entered by the submitter, never derived. Presence is checked before this schema runs.
  estimatedServiceCost: money,
  currency: ccy.default('AED'),
  assumptions: longText.nullish(),
  exclusions: longText.nullish(),
  dependencies: longText.nullish(),
  remarks: longText.nullish(),
  resources: z.array(resourceIn).max(100).default([]),
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
        'A linked record (enquiry, SBU or assignee) does not exist or is no longer available. Refresh the form and pick it again.',
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
 * Scope for estimation requests (OD-01: a person can sit in several SBUs).
 * scopeSql matches r.sbu_id against EVERY SBU in ctx.sbuIds (read from employee_sbu_memberships), and the
 * assignee / requester always keep sight of their own requests. Requires the request aliased as `r`.
 */
function estScope(ctx: AuthCtx, scope: Scope, startIdx: number): { sql: string; params: any[] } {
  const sc = scopeSql(ctx, scope, { alias: 'r', sbuCol: 'sbu_id', entity: 'estimation_requests' }, startIdx);
  if (sc.sql === 'TRUE') return sc;
  const i = startIdx + sc.params.length;
  return {
    sql: `(${sc.sql} OR r.assigned_to = $${i} OR r.requested_by = $${i})`,
    params: [...sc.params, ctx.userId],
  };
}

/* ───────────────────────── live SLA ───────────────────────── */

const REQ_SELECT = `
  SELECT r.id, r.request_no, r.enquiry_id, e.enquiry_no, e.title AS enquiry_title,
         e.customer_id, cu.name AS customer_name,
         r.sbu_id, sb.code AS sbu_code, sb.name AS sbu_name,
         r.status::text AS status, r.urgency::text AS urgency, r.required_by::text AS required_by,
         r.requested_by, ru.display_name AS requested_by_name,
         r.assigned_to, au.display_name AS assigned_to_name, r.assigned_at,
         r.raised_at, r.first_responded_at, r.paused_minutes, r.clarification_rounds, r.scope_notes,
         (SELECT max(te.version) FROM gw.technical_estimates te WHERE te.estimation_request_id = r.id) AS estimate_version,
         COALESCE(rule.target_hours, t.target_hours) AS target_hours,
         COALESCE(rule.warn_at_pct, 80) AS warn_at_pct,
         t.stopped_at AS timer_stopped_at,
         ps.value->>'at' AS pause_started_at,
         ps.value->>'question' AS open_clarification
    FROM gw.estimation_requests r
    JOIN gw.enquiries e ON e.id = r.enquiry_id
    JOIN gw.customers cu ON cu.id = e.customer_id
    JOIN gw.sbus sb ON sb.id = r.sbu_id
    LEFT JOIN gw.users ru ON ru.id = r.requested_by
    LEFT JOIN gw.users au ON au.id = r.assigned_to
    LEFT JOIN gw.sla_timers t
           ON t.timer_code = '${TIMER}' AND t.entity_type = '${ENTITY}' AND t.entity_id = r.id
    LEFT JOIN gw.settings ps ON ps.key = 'pause.' || r.id::text
    LEFT JOIN LATERAL (
      SELECT s.target_hours, s.warn_at_pct
        FROM gw.sla_rules s
       WHERE s.timer_code = '${TIMER}' AND s.urgency = r.urgency AND s.is_active
         AND s.effective_from <= r.raised_at::date AND (s.effective_to IS NULL OR s.effective_to >= r.raised_at::date)
       ORDER BY s.effective_from DESC LIMIT 1
    ) rule ON true`;

type Clock = 'running' | 'paused' | 'stopped';

/**
 * Elapsed working hours (Dubai calendar, OD-18) from raised_at to the first submission (or now),
 * minus the clarification minutes already banked and any clarification that is open right now.
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
  const r = await q1(`${REQ_SELECT} WHERE r.id = $1`, [id]);
  if (!r) throw notFound('Estimation request');
  return withLiveSla(r, new Date());
}

/* ───────────────────────── SLA pause and timer ───────────────────────── */

/*
 * estimation_requests has no pause-start column either, so an open clarification keeps its start (and the
 * question) in gw.settings under `pause.<requestId>` — the same approach as procurement RFQ pauses.
 * The row exists only while the ball is with Sales. /resume (or cancel) deletes it and banks the elapsed
 * WORKING minutes on estimation_requests.paused_minutes and sla_timers.paused_minutes.
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
    await c.query(`UPDATE gw.estimation_requests SET paused_minutes = paused_minutes + $2 WHERE id = $1`, [id, minutes]);
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
  const sc = estScope(ctx, scope, 2);
  const r = await c.query(
    `SELECT r.id, r.request_no, r.status::text AS status, r.sbu_id, r.assigned_to, r.first_responded_at, r.clarification_rounds
       FROM gw.estimation_requests r JOIN gw.enquiries e ON e.id = r.enquiry_id
      WHERE r.id = $1 AND e.deleted_at IS NULL AND ${sc.sql}
      FOR UPDATE OF r`,
    [id, ...sc.params]);
  if (!r.rows.length) throw notFound('Estimation request');
  return r.rows[0];
}

/**
 * One estimate version with its resources, masked for the caller.
 *
 * `estimated_service_cost` and `travel_cost` are the service_cost group, which
 * TECHNICAL and SALES hold for OWN records only (core/rbac.ts). Ownership has to
 * be resolved here, or the engineer who just typed the service cost cannot read
 * it back and Sales can never see it to price the deal (OD-10: it is entered,
 * not derived). An estimate is "own" to whoever submitted it, to the engineer the
 * request is assigned to, and to the enquiry's account manager.
 */
async function loadEstimate(ctx: AuthCtx, run: Run, where: string, params: unknown[]): Promise<Row | null> {
  const est = (await run(
    `SELECT te.id, te.estimation_request_id, te.version, te.superseded_by, te.submitted_by, u.display_name AS submitted_by_name,
            te.submitted_at, te.scope_understanding, te.proposed_solution, te.total_days, te.mode::text AS mode,
            te.travel_required, te.travel_cost, te.estimated_service_cost, te.currency,
            te.assumptions, te.exclusions, te.dependencies, te.remarks,
            rq.assigned_to AS _assigned_to, e.account_manager_id AS _account_manager_id
       FROM gw.technical_estimates te
       LEFT JOIN gw.users u ON u.id = te.submitted_by
       JOIN gw.estimation_requests rq ON rq.id = te.estimation_request_id
       JOIN gw.enquiries e ON e.id = rq.enquiry_id
      WHERE ${where}
      ORDER BY te.version DESC LIMIT 1`, params))[0];
  if (!est) return null;
  const own = est.submitted_by === ctx.userId
    || est._assigned_to === ctx.userId
    || (ctx.employeeId !== null && est._account_manager_id === ctx.employeeId);
  delete est._assigned_to;
  delete est._account_manager_id;
  const res = await run(
    `SELECT er.id, er.role_name, er.seniority_band, er.headcount, er.days, er.mode::text AS mode, er.day_rate
       FROM gw.estimate_resources er WHERE er.estimate_id = $1
      ORDER BY er.role_name, er.seniority_band NULLS LAST, er.id`, [est.id]);
  return {
    ...mask(ctx, 'technical_estimates', est, own),
    resources: res.map((r) => mask(ctx, 'estimate_resources', r, own)),
  };
}

/* ───────────────────────── SLA roll-up ───────────────────────── */

interface Bucket { total: number; Within: number; Approaching: number; Breached: number; elapsed_sum: number; rounds_sum: number }
const newBucket = (): Bucket => ({ total: 0, Within: 0, Approaching: 0, Breached: 0, elapsed_sum: 0, rounds_sum: 0 });
function addToBucket(b: Bucket, row: Row) {
  b.total += 1;
  b[row.sla_state as 'Within' | 'Approaching' | 'Breached'] += 1;
  b.elapsed_sum += row.elapsed_working_hours;
  b.rounds_sum += Number(row.clarification_rounds);
}
function bucketOut(b: Bucket) {
  return {
    total: b.total, Within: b.Within, Approaching: b.Approaching, Breached: b.Breached,
    average_elapsed_hours: b.total ? round2(b.elapsed_sum / b.total) : null,
    average_clarification_rounds: b.total ? round2(b.rounds_sum / b.total) : null,
  };
}
const worstFirst = (a: { Breached: number; Approaching: number; total: number }, b: { Breached: number; Approaching: number; total: number }) =>
  b.Breached - a.Breached || b.Approaching - a.Approaching || b.total - a.total;

/* ───────────────────────── routes ───────────────────────── */

export async function estimationRoutes(app: FastifyInstance) {
  /* ═════════════ Queue ═════════════ */

  app.get('/api/v1/estimation/requests', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'technical_estimations.view');
    const qs = parse(queueQuery, req.query);

    const sc = estScope(ctx, scope, 1);
    const params: any[] = [...sc.params];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const w: string[] = ['e.deleted_at IS NULL', sc.sql];
    w.push(`r.status::text = ANY(${p(qs.status ?? OPEN_STATUSES)}::text[])`);
    if (qs.sbuId) w.push(`r.sbu_id = ${p(qs.sbuId)}`);
    if (qs.assignedTo) w.push(`r.assigned_to = ${p(qs.assignedTo)}`);
    if (qs.urgency) w.push(`r.urgency::text = ${p(qs.urgency)}`);
    if (qs.enquiryId) w.push(`r.enquiry_id = ${p(qs.enquiryId)}`);

    const rows = await q(`${REQ_SELECT} WHERE ${w.join(' AND ')} ORDER BY r.raised_at DESC LIMIT ${MAX_QUEUE_SCAN}`, params);
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

  app.get('/api/v1/estimation/requests/:id', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'technical_estimations.view');
    const { id } = parse(idParam, req.params);
    const sc = estScope(ctx, scope, 2);
    const head = await q1(`${REQ_SELECT} WHERE r.id = $1 AND e.deleted_at IS NULL AND ${sc.sql}`, [id, ...sc.params]);
    if (!head) throw notFound('Estimation request');

    const [live, estimate, history, clarifications] = await Promise.all([
      withLiveSla(head, new Date()),
      loadEstimate(ctx, runPool, 'te.estimation_request_id = $1', [id]),
      // Earlier versions are never edited; list them so Sales can see how the estimate moved.
      q(`SELECT te.id, te.version, te.submitted_at, te.submitted_by, u.display_name AS submitted_by_name, te.superseded_by
           FROM gw.technical_estimates te LEFT JOIN gw.users u ON u.id = te.submitted_by
          WHERE te.estimation_request_id = $1 ORDER BY te.version DESC`, [id]),
      q(`SELECT a.occurred_at, a.actor_user_id, u.display_name AS actor_name,
                CASE a.field_name WHEN 'clarification_question' THEN 'question' ELSE 'answer' END AS kind, a.reason AS text
           FROM gw.audit_log a LEFT JOIN gw.users u ON u.id = a.actor_user_id
          WHERE a.entity_type = '${ENTITY}' AND a.entity_id = $1
            AND a.field_name IN ('clarification_question', 'clarification_answer')
          ORDER BY a.occurred_at, a.id`, [id]),
    ]);
    return { data: { ...live, estimate, estimate_history: history, clarifications } };
  });

  /* ═════════════ Raise (one request per SBU) ═════════════ */

  app.post('/api/v1/estimation/requests', async (req, reply) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'technical_estimations.create');
    const b = parse(createBody, req.body);

    const ids = await guard(() => tx(txCtx(ctx, scope), async (c) => {
      const esc = scopeSql(ctx, scope, { alias: 'e', ownerCol: 'account_manager_id', sbuCol: 'primary_sbu_id', entity: 'enquiries' }, 2);
      const enq = (await c.query(
        `SELECT e.id, e.company_id, e.primary_sbu_id FROM gw.enquiries e WHERE e.id = $1 AND e.deleted_at IS NULL AND ${esc.sql}`,
        [b.enquiryId, ...esc.params])).rows[0];
      if (!enq) throw notFound('Enquiry');

      // Which SBUs: the caller's explicit choice, else every SBU the enquiry's lines route to (technology → category).
      let sbuIds: string[] = b.sbuIds ?? (b.sbuId ? [b.sbuId] : []);
      if (!sbuIds.length) {
        const fromLines = (await c.query(
          `SELECT DISTINCT COALESCE(l.sbu_id, t.sbu_id, tc.sbu_id) AS sbu_id
             FROM gw.enquiry_lines l
             LEFT JOIN gw.technologies t ON t.id = l.technology_id
             LEFT JOIN gw.technology_categories tc ON tc.id = t.category_id
            WHERE l.enquiry_id = $1`, [b.enquiryId])).rows.map((r) => r.sbu_id as string | null);
        sbuIds = fromLines.filter((s): s is string => !!s);
        if (!sbuIds.length && enq.primary_sbu_id) sbuIds = [enq.primary_sbu_id as string];
      }
      sbuIds = [...new Set(sbuIds)];
      if (!sbuIds.length)
        throw badRequest('sbu_required', 'Choose the SBU that should estimate this work — none of the enquiry lines points at one.');

      const sbus = (await c.query(`SELECT id, code FROM gw.sbus WHERE id = ANY($1::uuid[]) AND is_active`, [sbuIds])).rows;
      if (sbus.length !== sbuIds.length)
        throw badRequest('unknown_sbu', 'One of the SBUs does not exist or is inactive. Pick it from the SBU list.');
      const code = new Map(sbus.map((s) => [s.id as string, s.code as string]));

      const created: string[] = [];
      for (const sbuId of sbuIds) {
        const dup = (await c.query(
          `SELECT request_no FROM gw.estimation_requests
            WHERE enquiry_id = $1 AND sbu_id = $2 AND status IN ('Raised','Assigned','InReview','ClarificationNeeded') LIMIT 1`,
          [b.enquiryId, sbuId])).rows[0];
        if (dup)
          throw conflict('duplicate_open_request', `${code.get(sbuId)} already has an open estimation request for this enquiry (${dup.request_no}). Use that one, or cancel it first.`);

        const requestNo = await nextNumber(c, 'estimation_request', enq.company_id, 'TER');
        const ins = await c.query(
          `INSERT INTO gw.estimation_requests (request_no, enquiry_id, sbu_id, requested_by, urgency, required_by, scope_notes, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'Raised') RETURNING id`,
          [requestNo, b.enquiryId, sbuId, ctx.userId, b.urgency, b.requiredBy ?? null, b.scopeNotes ?? null]);
        const rid = ins.rows[0].id as string;
        await startTimer(c, { timerCode: TIMER, entityType: ENTITY, entityId: rid, urgency: b.urgency });
        await audit(c, ctx, { entityType: ENTITY, entityId: rid, action: 'create' });
        created.push(rid);
      }
      return created;
    }));

    reply.code(201);
    return { data: await Promise.all(ids.map((i) => liveRequestById(i))) };
  });

  /* ═════════════ Assign ═════════════ */

  app.patch('/api/v1/estimation/requests/:id/assign', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'technical_estimations.edit');
    const { id } = parse(idParam, req.params);
    const b = parse(assignBody, req.body);

    await guard(() => tx(txCtx(ctx, scope), async (c) => {
      const cur = await lockRequest(c, ctx, scope, id);
      if (cur.status === 'Submitted' || cur.status === 'Cancelled')
        throw gateBlocked(`This estimation request is already ${cur.status}, so it cannot be reassigned.`);

      // The assignee must be able to estimate AND currently belong to the request's SBU (OD-01: read memberships).
      const who = await c.query(
        `SELECT u.id FROM gw.users u
           JOIN gw.employees emp ON emp.user_id = u.id AND emp.is_active
          WHERE u.id = $1 AND u.is_active AND u.deleted_at IS NULL
            AND EXISTS (SELECT 1 FROM gw.user_roles ur
                          JOIN gw.role_permissions rp ON rp.role_id = ur.role_id
                          JOIN gw.permissions pm ON pm.id = rp.permission_id
                         WHERE ur.user_id = u.id AND pm.key = 'technical_estimations.edit')
            AND EXISTS (SELECT 1 FROM gw.employee_sbu_memberships m
                         WHERE m.employee_id = emp.id AND m.sbu_id = $2
                           AND m.effective_from <= current_date AND (m.effective_to IS NULL OR m.effective_to > current_date))`,
        [b.assignedTo, cur.sbu_id]);
      if (!who.rows.length)
        throw badRequest('assignee_not_in_sbu', 'That person is not an active member of this request\'s SBU (or cannot work estimations). Choose an engineer from the SBU.');

      await c.query(
        `UPDATE gw.estimation_requests
            SET assigned_to = $2, assigned_at = now(),
                status = CASE WHEN status = 'Raised' THEN 'Assigned'::gw.est_req_status ELSE status END,
                row_version = row_version + 1
          WHERE id = $1`, [id, b.assignedTo]);
      await c.query(
        `UPDATE gw.sla_timers SET owner_user_id = $4
          WHERE timer_code = $1 AND entity_type = $2 AND entity_id = $3`, [TIMER, ENTITY, id, b.assignedTo]);
    }));

    return { data: await liveRequestById(id) };
  });

  /* ═════════════ Start review (Assigned → InReview) ═════════════ */

  app.post('/api/v1/estimation/requests/:id/start', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'technical_estimations.edit');
    const { id } = parse(idParam, req.params);

    await guard(() => tx(txCtx(ctx, scope), async (c) => {
      const cur = await lockRequest(c, ctx, scope, id);
      if (cur.status !== 'Assigned')
        throw gateBlocked(
          cur.status === 'Raised'
            ? 'Assign the request to an engineer before starting the review.'
            : `Only an Assigned request can be started; this one is ${cur.status}.`,
          { from: cur.status, allowed: ['Assigned'] });
      await c.query(`UPDATE gw.estimation_requests SET status = 'InReview', row_version = row_version + 1 WHERE id = $1`, [id]);
    }));

    return { data: await liveRequestById(id) };
  });

  /* ═════════════ Clarify — the ball goes back to Sales, the clock pauses ═════════════ */

  app.post('/api/v1/estimation/requests/:id/clarify', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'technical_estimations.edit');
    const { id } = parse(idParam, req.params);
    const b = parse(clarifyBody, req.body);

    await guard(() => tx(txCtx(ctx, scope), async (c) => {
      const cur = await lockRequest(c, ctx, scope, id);
      if (cur.status !== 'Assigned' && cur.status !== 'InReview')
        throw gateBlocked(
          cur.status === 'ClarificationNeeded'
            ? 'A clarification is already open with Sales. Wait for the answer, then resume the request.'
            : `A clarification can only be requested while the request is Assigned or InReview; this one is ${cur.status}.`,
          { from: cur.status, allowed: ['Assigned', 'InReview'] });
      const now = await dbNow(c);

      const upd = await c.query(
        `UPDATE gw.estimation_requests
            SET status = 'ClarificationNeeded', clarification_rounds = clarification_rounds + 1, row_version = row_version + 1
          WHERE id = $1 RETURNING clarification_rounds`, [id]);
      const round = upd.rows[0].clarification_rounds as number;
      await openPause(c, id, now, ctx.userId, { kind: 'clarification', question: b.question, round });
      // The question lives nowhere else on the row, so keep it in the audit trail.
      await audit(c, ctx, { entityType: ENTITY, entityId: id, action: 'update', field: 'clarification_question', newValue: round, reason: b.question });
    }));

    return { data: await liveRequestById(id) };
  });

  /* ═════════════ Resume — Sales has answered, the clock restarts ═════════════ */

  app.post('/api/v1/estimation/requests/:id/resume', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'technical_estimations.edit');
    const { id } = parse(idParam, req.params);
    const b = parse(resumeBody, req.body);

    await guard(() => tx(txCtx(ctx, scope), async (c) => {
      const cur = await lockRequest(c, ctx, scope, id);
      if (cur.status !== 'ClarificationNeeded')
        throw gateBlocked(`Only a request waiting for clarification can be resumed; this one is ${cur.status}.`,
          { from: cur.status, allowed: ['ClarificationNeeded'] });
      const now = await dbNow(c);
      await closePause(c, id, now);
      await c.query(`UPDATE gw.estimation_requests SET status = 'InReview', row_version = row_version + 1 WHERE id = $1`, [id]);
      if (b.answer)
        await audit(c, ctx, { entityType: ENTITY, entityId: id, action: 'update', field: 'clarification_answer', newValue: cur.clarification_rounds, reason: b.answer });
    }));

    return { data: await liveRequestById(id) };
  });

  /* ═════════════ Cancel ═════════════ */

  app.post('/api/v1/estimation/requests/:id/cancel', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'technical_estimations.edit');
    const { id } = parse(idParam, req.params);
    const b = parse(cancelBody, req.body);

    await guard(() => tx(txCtx(ctx, scope), async (c) => {
      const cur = await lockRequest(c, ctx, scope, id);
      if (cur.status === 'Submitted' || cur.status === 'Cancelled')
        throw gateBlocked(`This estimation request is already ${cur.status} and cannot be cancelled.`);
      const now = await dbNow(c);
      await closePause(c, id, now);
      await c.query(`UPDATE gw.estimation_requests SET status = 'Cancelled', row_version = row_version + 1 WHERE id = $1`, [id]);
      await finishTimer(c, id);
      await audit(c, ctx, { entityType: ENTITY, entityId: id, action: 'update', field: 'status', oldValue: cur.status, newValue: 'Cancelled', reason: b.reason });
    }));

    return { data: await liveRequestById(id) };
  });

  /* ═════════════ Submit the estimate (versioned, append-only) ═════════════ */

  app.post('/api/v1/estimation/requests/:id/estimate', async (req, reply) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'technical_estimations.edit');
    const { id } = parse(idParam, req.params);

    // OD-10 comes first, before any other validation: there is no day rate to fall back on.
    const raw = req.body as Record<string, unknown> | null | undefined;
    const given = raw?.estimatedServiceCost;
    if (given === undefined || given === null || given === '') throw badRequest('service_cost_required', SERVICE_COST_REQUIRED);

    const b = parse(estimateBody, req.body);
    if (b.travelCost != null && b.travelCost > 0 && !b.travelRequired)
      throw badRequest('travel_not_required', 'A travel cost was entered but travel is not marked required. Tick "travel required" or clear the cost.');
    if (!b.resources.length && b.totalDays == null)
      throw badRequest('total_days_required', 'Enter the total effort in days, or list the resources (role, headcount, days) and it will be added up for you.');

    const estimateId = await guard(() => tx(txCtx(ctx, scope), async (c) => {
      const cur = await lockRequest(c, ctx, scope, id);
      const from = cur.status as Status;
      if (from === 'Raised') throw gateBlocked('Assign the request to an engineer before an estimate is submitted.');
      if (from === 'ClarificationNeeded')
        throw gateBlocked('This request is waiting on Sales for a clarification. Resume it once they have answered, then submit the estimate.');
      if (from === 'Cancelled') throw gateBlocked('This estimation request was cancelled, so no estimate can be submitted.');

      // Total effort is derived from the resources when there are any (house rule: derived values are computed).
      let totalDays = b.totalDays as number;
      if (b.resources.length) {
        const sum = (await c.query(
          `SELECT COALESCE(sum(h * d), 0) AS total FROM unnest($1::int[], $2::numeric[]) AS t(h, d)`,
          [b.resources.map((r) => r.headcount), b.resources.map((r) => r.days)])).rows[0].total as number;
        if (b.totalDays != null && Math.abs(Number(sum) - b.totalDays) > 0.005)
          throw badRequest('total_days_mismatch',
            `Total days (${b.totalDays}) does not match the resources, which add up to ${Number(sum)} person-days (headcount × days). Correct one of them, or leave total days out.`);
        totalDays = Number(sum);
      }

      const now = await dbNow(c);
      const prev = (await c.query(
        `SELECT id, version FROM gw.technical_estimates WHERE estimation_request_id = $1 AND superseded_by IS NULL
          ORDER BY version DESC LIMIT 1`, [id])).rows[0] as { id: string; version: number } | undefined;
      const maxV = (await c.query(
        `SELECT COALESCE(max(version), 0) AS v FROM gw.technical_estimates WHERE estimation_request_id = $1`, [id])).rows[0].v as number;

      const ins = await c.query(
        `INSERT INTO gw.technical_estimates
           (estimation_request_id, submitted_by, submitted_at, scope_understanding, proposed_solution, total_days, mode,
            travel_required, travel_cost, estimated_service_cost, currency, assumptions, exclusions, dependencies, remarks, version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [id, ctx.userId, now, b.scopeUnderstanding, b.proposedSolution, totalDays, b.mode, b.travelRequired,
         b.travelCost ?? null, b.estimatedServiceCost, b.currency, b.assumptions ?? null, b.exclusions ?? null,
         b.dependencies ?? null, b.remarks ?? null, Number(maxV) + 1]);
      const eid = ins.rows[0].id as string;

      // day_rate stays NULL: there is no engineer day rate in this system (OD-10).
      for (const r of b.resources) {
        await c.query(
          `INSERT INTO gw.estimate_resources (estimate_id, role_name, seniority_band, headcount, days, mode)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [eid, r.roleName, r.seniorityBand ?? null, r.headcount, r.days, r.mode]);
      }

      // The old version is never edited; it is only pointed at its successor.
      if (prev) await c.query(`UPDATE gw.technical_estimates SET superseded_by = $2 WHERE id = $1`, [prev.id, eid]);

      const firstResponse = cur.first_responded_at == null;
      await closePause(c, id, now);
      await c.query(
        `UPDATE gw.estimation_requests
            SET status = 'Submitted', first_responded_at = COALESCE(first_responded_at, $2::timestamptz), row_version = row_version + 1
          WHERE id = $1`, [id, now]);
      if (firstResponse) await finishTimer(c, id);

      await audit(c, ctx, { entityType: 'technical_estimates', entityId: eid, action: 'create', newValue: `v${Number(maxV) + 1}` });
      return eid;
    }));

    reply.code(201);
    const [live, estimate] = await Promise.all([
      liveRequestById(id),
      loadEstimate(ctx, runPool, 'te.id = $1', [estimateId]),
    ]);
    return { data: { ...live, estimate } };
  });

  /* ═════════════ SLA summary ═════════════ */

  app.get('/api/v1/estimation/sla', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'technical_estimations.view');
    const qs = parse(slaQuery, req.query);

    const sc = estScope(ctx, scope, 1);
    const params: any[] = [...sc.params, qs.days];
    let extra = '';
    if (qs.sbuId) { params.push(qs.sbuId); extra = ` AND r.sbu_id = $${params.length}`; }
    const rows = await q(
      `${REQ_SELECT}
        WHERE e.deleted_at IS NULL AND ${sc.sql} AND r.status <> 'Cancelled'
          AND r.raised_at >= now() - ($${sc.params.length + 1}::int * interval '1 day')${extra}
        LIMIT ${MAX_QUEUE_SCAN}`, params);
    const now = new Date();
    const live = await Promise.all(rows.map((r) => withLiveSla(r, now)));

    const all = newBucket();
    const open = newBucket();
    interface SbuAgg { code: string; name: string; b: Bucket; engineers: Map<string, { name: string | null; b: Bucket }> }
    const bySbu = new Map<string, SbuAgg>();
    const byEngineer = new Map<string, { name: string | null; b: Bucket }>();
    for (const r of live) {
      addToBucket(all, r);
      if (r.sla_clock !== 'stopped') addToBucket(open, r);

      const s = bySbu.get(r.sbu_id) ?? { code: r.sbu_code, name: r.sbu_name, b: newBucket(), engineers: new Map() };
      addToBucket(s.b, r);
      const ekey = r.assigned_to ?? 'unassigned';
      const se = s.engineers.get(ekey) ?? { name: r.assigned_to_name ?? null, b: newBucket() };
      addToBucket(se.b, r);
      s.engineers.set(ekey, se);
      bySbu.set(r.sbu_id, s);

      // A person may work in several SBUs (OD-01), so also give one roll-up per engineer across all of them.
      const e = byEngineer.get(ekey) ?? { name: r.assigned_to_name ?? null, b: newBucket() };
      addToBucket(e.b, r);
      byEngineer.set(ekey, e);
    }

    const engineerRow = (key: string, e: { name: string | null; b: Bucket }) =>
      ({ assigned_to: key === 'unassigned' ? null : key, assigned_to_name: e.name, ...bucketOut(e.b) });
    const { average_elapsed_hours, average_clarification_rounds, ...counts } = bucketOut(all);

    return {
      data: {
        window_days: qs.days,
        by_state: { Within: counts.Within, Approaching: counts.Approaching, Breached: counts.Breached },
        total: counts.total,
        average_elapsed_hours,
        average_clarification_rounds,
        open: bucketOut(open),
        by_sbu: [...bySbu.entries()]
          .map(([sbuId, s]) => ({
            sbu_id: sbuId, sbu_code: s.code, sbu_name: s.name, ...bucketOut(s.b),
            engineers: [...s.engineers.entries()].map(([k, e]) => engineerRow(k, e)).sort(worstFirst),
          }))
          .sort(worstFirst),
        by_engineer: [...byEngineer.entries()].map(([k, e]) => engineerRow(k, e)).sort(worstFirst),
      },
    };
  });
}
