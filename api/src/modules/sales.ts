import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { q, q1, tx } from '../core/db.js';
import type { Row } from '../core/db.js';
import { require_, scopeFor, scopeSql, mask } from '../core/rbac.js';
import { audit } from '../core/audit.js';
import { AppError, badRequest, notFound, forbidden, gateBlocked, conflict } from '../core/errors.js';
import { nextNumber } from '../core/numbering.js';
import { config } from '../core/config.js';
import type { AuthCtx, Scope } from '../core/types.js';

/* ───────────────────────── constants ───────────────────────── */

// Verified against enum_range(null::gw.enquiry_stage) — order matters for the kanban board.
const STAGES = ['New', 'Qualifying', 'Working', 'Submitted', 'Pending', 'Won', 'Lost', 'Cancelled', 'Dropped'] as const;
type Stage = typeof STAGES[number];
const OPEN_SQL = `('New','Qualifying','Working','Submitted','Pending')`;
const LEAD_STATUSES = ['New', 'Working', 'Nurturing', 'Qualified', 'Disqualified', 'Recycled'] as const;
const LEAD_INBOX = ['New', 'Working', 'Nurturing'] as const;
const LEAD_ACTIONABLE = ['New', 'Working', 'Nurturing', 'Recycled'];

// Money is aggregated in the company base currency; the Dubai calendar governs "today" (OD-18).
const BASE_CCY = 'AED';
const TODAY = `(now() AT TIME ZONE 'Asia/Dubai')::date`;
const fxRate = (ccy: string) =>
  `(CASE WHEN ${ccy} = '${BASE_CCY}' THEN 1 ELSE ` +
  `(SELECT f.rate FROM gw.fx_rates f WHERE f.from_currency = ${ccy} AND f.to_currency = '${BASE_CCY}' ` +
  `ORDER BY f.rate_date DESC LIMIT 1) END)`;

/* ───────────────────────── validation ───────────────────────── */

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD');
const ccy = z.string().length(3).transform((s) => s.toUpperCase());
const money = z.number().nonnegative().max(1e14);
const text = (max = 255) => z.string().trim().min(1).max(max);
const boolFlag = z.enum(['true', 'false']).transform((v) => v === 'true');
const stageEnum = z.enum(STAGES);
const stageList = z
  .string()
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
  .pipe(z.array(stageEnum).min(1));

const pageShape = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(500).optional(),
};

const filterSchema = z.object({
  stage: stageList.optional(),
  ownerId: uuid.optional(),
  sbuId: uuid.optional(),
  businessTypeId: uuid.optional(),
  customerId: uuid.optional(),
  q: z.string().trim().min(1).max(100).optional(),
  overdueFollowUp: boolFlag.optional(),
});
type EnquiryFilter = z.infer<typeof filterSchema>;

const listQuery = filterSchema.extend({
  ...pageShape,
  sort: z.enum(['received_at', '-received_at']).default('-received_at'),
});
const boardQuery = filterSchema.extend({
  cardsPerStage: z.coerce.number().int().min(1).max(200).default(50),
});
const summaryQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  ownerId: uuid.optional(),
  sbuId: uuid.optional(),
  businessTypeId: uuid.optional(),
  customerId: uuid.optional(),
});

const idParam = z.object({ id: uuid });

const lineIn = z.object({
  technologyId: uuid.nullish(),
  productSkuId: uuid.nullish(),
  serviceId: uuid.nullish(),
  sbuId: uuid.nullish(),
  description: text(2000),
  quantity: z.number().positive().max(1e9).default(1),
});
type LineIn = z.infer<typeof lineIn>;

const createEnquiryBody = z.object({
  customerId: uuid,
  contactId: uuid.nullish(),
  endCustomerName: text().nullish(),
  partnerId: uuid.nullish(),
  accountManagerId: uuid.optional(),
  businessTypeId: uuid,
  title: text(),
  description: z.string().trim().max(10000).nullish(),
  receivedAt: z.string().datetime({ offset: true }).optional(),
  approxBudget: money.nullish(),
  budgetCurrency: ccy.optional(),
  expectedQuoteDate: isoDate.nullish(),
  expectedPoDate: isoDate.nullish(),
  probabilityPct: z.number().min(0).max(100).nullish(),
  remarks: z.string().trim().max(10000).nullish(),
  source: text().nullish(),
  campaignId: uuid.nullish(),
  lines: z.array(lineIn).min(1, 'Add at least one enquiry line'),
});

// Only these fields are editable after creation. `stage` is deliberately absent.
const patchEnquiryBody = z
  .object({
    title: text(),
    description: z.string().trim().max(10000).nullable(),
    approxBudget: money.nullable(),
    expectedQuoteDate: isoDate.nullable(),
    expectedPoDate: isoDate.nullable(),
    probabilityPct: z.number().min(0).max(100).nullable(),
    remarks: z.string().trim().max(10000).nullable(),
    endCustomerName: text().nullable(),
    contactId: uuid.nullable(),
  })
  .partial()
  .strict();
const PATCH_COLUMNS: Record<keyof z.infer<typeof patchEnquiryBody>, string> = {
  title: 'title',
  description: 'description',
  approxBudget: 'approx_budget',
  expectedQuoteDate: 'expected_quote_date',
  expectedPoDate: 'expected_po_date',
  probabilityPct: 'probability_pct',
  remarks: 'remarks',
  endCustomerName: 'end_customer_name',
  contactId: 'contact_id',
};

const stageBody = z.object({
  stage: stageEnum,
  lossReasonId: uuid.nullish(),
  lossRemarks: z.string().trim().max(10000).nullish(),
  remarks: z.string().trim().max(10000).nullish(),
});

const patchLineBody = z
  .object({
    technologyId: uuid.nullable(),
    productSkuId: uuid.nullable(),
    serviceId: uuid.nullable(),
    sbuId: uuid.nullable(),
    description: text(2000),
    quantity: z.number().positive().max(1e9),
  })
  .partial()
  .strict();

const followUpBody = z.object({
  remarks: text(10000),
  nextFollowUp: isoDate.nullish(),
  channel: text().nullish(),
  customerFeedback: z.string().trim().max(10000).nullish(),
});

const competitorBody = z.object({
  competitor: text(),
  knownPrice: money.nullish(),
  currency: ccy.nullish(),
  notes: z.string().trim().max(10000).nullish(),
});

const leadListQuery = z.object({
  ...pageShape,
  status: z.enum(LEAD_INBOX).optional(),
  ownerId: uuid.optional(),
  campaignId: uuid.optional(),
  q: z.string().trim().min(1).max(100).optional(),
});

const createLeadBody = z.object({
  companyName: text(),
  customerId: uuid.nullish(),
  contactName: text().nullish(),
  designation: text().nullish(),
  email: z.string().trim().email().max(255).nullish(),
  phone: text().nullish(),
  country: z.string().length(2).transform((s) => s.toUpperCase()).nullish(),
  campaignId: uuid.nullish(),
  source: text().nullish(),
  sourceDetail: z.string().trim().max(10000).nullish(),
  technologyId: uuid.nullish(),
  sbuId: uuid.nullish(),
  estimatedValue: money.nullish(),
  currency: ccy.optional(),
  ownerId: uuid.nullish(),
  consentMarketing: z.boolean().default(false),
});

// The lead carries no business type, so the qualifier must choose one for the enquiry.
const qualifyBody = z.object({
  businessTypeId: uuid,
  customerId: uuid.nullish(),
  contactId: uuid.nullish(),
  accountManagerId: uuid.nullish(),
  title: text().nullish(),
  description: z.string().trim().max(10000).nullish(),
  approxBudget: money.nullish(),
  expectedQuoteDate: isoDate.nullish(),
  expectedPoDate: isoDate.nullish(),
  probabilityPct: z.number().min(0).max(100).nullish(),
});

const disqualifyBody = z.object({ reason: text(255) });

const campaignQuery = z.object({
  active: boolFlag.optional(),
  q: z.string().trim().min(1).max(100).optional(),
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
  const err = e as { code?: string; constraint?: string } | null;
  switch (err?.code) {
    case '23503':
      return badRequest(
        'invalid_reference',
        'A linked record (customer, contact, technology, SBU, campaign, owner or loss reason) does not exist or is no longer available. Refresh the form and pick it again.',
      );
    case '23514':
      if (err?.constraint === 'enq_loss_reason_required')
        return gateBlocked('Choose a loss reason before marking this enquiry Lost.');
      if (err?.constraint === 'lead_disqualify_reason')
        return badRequest('reason_required', 'Say why this lead is being disqualified.');
      if (err?.constraint === 'enquiries_probability_pct_check')
        return badRequest('probability_range', 'Probability must be between 0 and 100.');
      return badRequest('constraint_failed', 'One of the values breaks a business rule. Check the amounts and dates and try again.');
    case '23505':
      return conflict('duplicate', 'A record with the same unique reference already exists. Refresh and try again.');
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
function decodeCursor(c: string | undefined): Record<string, any> | null {
  if (!c) return null;
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    if (v && typeof v === 'object') return v as Record<string, any>;
  } catch { /* fall through */ }
  throw badRequest('bad_cursor', 'That page marker is no longer valid. Reload the list from the first page.');
}
const likeTerm = (s: string) => `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
const stripKeys = (r: Row, ...keys: string[]) => { for (const k of keys) delete r[k]; return r; };

async function companyIdFor(c: pg.PoolClient): Promise<string> {
  const r = await c.query(`SELECT id FROM gw.companies WHERE code = $1 AND is_active`, [config.companyCode]);
  if (!r.rows.length) throw badRequest('no_company', `Company ${config.companyCode} is not set up. Ask an administrator to configure it.`);
  return r.rows[0].id as string;
}

/* ───────────────────────── enquiry row shape (list / board / summary) ───────────────────────── */

const ROW_COLS = `
  e.id, e.enquiry_no, e.title, e.customer_id, c.name AS customer_name,
  e.stage::text AS stage, e.probability_pct AS probability,
  e.approx_budget, e.budget_currency,
  e.expected_po_date::text AS expected_po_date, e.expected_quote_date::text AS expected_quote_date,
  e.account_manager_id, am.full_name AS account_manager_name,
  e.primary_sbu_id, s.code AS primary_sbu_code,
  e.business_type_id, e.lead_id, e.campaign_id, e.received_at, e.slip_count,
  GREATEST(0, floor(extract(epoch FROM (now() - COALESCE(sh.changed_at, e.created_at))) / 86400))::int AS days_in_stage,
  fu.next_follow_up::text AS next_follow_up,
  COALESCE(fu.next_follow_up < ${TODAY} AND e.stage IN ${OPEN_SQL}, false) AS follow_up_overdue,
  (e.approx_budget * ${fxRate(`COALESCE(e.budget_currency,'${BASE_CCY}')`)}) AS value_aed,
  (e.approx_budget * ${fxRate(`COALESCE(e.budget_currency,'${BASE_CCY}')`)} * COALESCE(e.probability_pct, 0) / 100) AS weighted_value_aed,
  e.received_at::text AS _ts`;

const ROW_FROM = `
  FROM gw.enquiries e
  JOIN gw.customers c ON c.id = e.customer_id
  JOIN gw.employees am ON am.id = e.account_manager_id
  LEFT JOIN gw.sbus s ON s.id = e.primary_sbu_id
  LEFT JOIN LATERAL (
    SELECT h.changed_at FROM gw.stage_history h WHERE h.enquiry_id = e.id ORDER BY h.changed_at DESC LIMIT 1
  ) sh ON true
  LEFT JOIN LATERAL (
    SELECT f.next_follow_up FROM gw.follow_ups f WHERE f.enquiry_id = e.id ORDER BY f.followed_up_at DESC, f.id DESC LIMIT 1
  ) fu ON true`;

const cleanRow = (r: Row) => stripKeys(r, '_ts');

async function fetchEnquiryRow(c: pg.PoolClient, id: string): Promise<Row> {
  const r = await c.query(`SELECT ${ROW_COLS} ${ROW_FROM} WHERE e.id = $1`, [id]);
  if (!r.rows.length) throw notFound('Enquiry');
  return cleanRow(r.rows[0]);
}

/** WHERE clause for enquiry queries: scope is ANDed in first, then the caller's filters. */
function enquiryWhere(ctx: AuthCtx, scope: Scope, f: Partial<EnquiryFilter>): { where: string; params: any[] } {
  const sc = scopeSql(ctx, scope, { alias: 'e', ownerCol: 'account_manager_id', sbuCol: 'primary_sbu_id', entity: 'enquiries' }, 1);
  const params: any[] = [...sc.params];
  const p = (v: any) => { params.push(v); return `$${params.length}`; };
  const w: string[] = ['e.deleted_at IS NULL', sc.sql];
  if (f.stage?.length) w.push(`e.stage::text = ANY(${p(f.stage)}::text[])`);
  if (f.ownerId) w.push(`e.account_manager_id = ${p(f.ownerId)}`);
  if (f.sbuId) w.push(`e.primary_sbu_id = ${p(f.sbuId)}`);
  if (f.businessTypeId) w.push(`e.business_type_id = ${p(f.businessTypeId)}`);
  if (f.customerId) w.push(`e.customer_id = ${p(f.customerId)}`);
  if (f.q) {
    const t = p(likeTerm(f.q));
    w.push(`(e.enquiry_no ILIKE ${t} OR e.title ILIKE ${t} OR c.name ILIKE ${t})`);
  }
  if (f.overdueFollowUp) w.push(`(fu.next_follow_up < ${TODAY} AND e.stage IN ${OPEN_SQL})`);
  return { where: w.join(' AND '), params };
}

/* ───────────────────────── write helpers ───────────────────────── */

/** Technology SBU overrides category SBU; services and SKUs fall back to their own routes. */
async function resolveLineSbu(
  c: pg.PoolClient,
  l: { technologyId?: string | null; serviceId?: string | null; productSkuId?: string | null; sbuId?: string | null },
): Promise<string | null> {
  if (l.sbuId) return l.sbuId;
  if (l.technologyId) {
    const r = await c.query(
      `SELECT COALESCE(t.sbu_id, tc.sbu_id) AS sbu_id
         FROM gw.technologies t JOIN gw.technology_categories tc ON tc.id = t.category_id
        WHERE t.id = $1`, [l.technologyId]);
    if (!r.rows.length) throw badRequest('unknown_technology', 'That technology does not exist. Pick one from the technology list.');
    return (r.rows[0].sbu_id as string | null) ?? null;
  }
  if (l.serviceId) {
    const r = await c.query(`SELECT sbu_id FROM gw.services WHERE id = $1`, [l.serviceId]);
    if (!r.rows.length) throw badRequest('unknown_service', 'That service does not exist. Pick one from the service list.');
    return (r.rows[0].sbu_id as string | null) ?? null;
  }
  if (l.productSkuId) {
    const r = await c.query(
      `SELECT tc.sbu_id FROM gw.product_skus k
         JOIN gw.products p ON p.id = k.product_id
         LEFT JOIN gw.technology_categories tc ON tc.id = p.category_id
        WHERE k.id = $1`, [l.productSkuId]);
    if (!r.rows.length) throw badRequest('unknown_sku', 'That product SKU does not exist. Pick one from the product list.');
    return (r.rows[0].sbu_id as string | null) ?? null;
  }
  return null;
}

/** primary_sbu_id follows the first line that has a resolved SBU. */
async function syncPrimarySbu(c: pg.PoolClient, ctx: AuthCtx, enquiryId: string) {
  const cur = (await c.query(
    `SELECT e.primary_sbu_id,
            (SELECT l.sbu_id FROM gw.enquiry_lines l WHERE l.enquiry_id = e.id AND l.sbu_id IS NOT NULL ORDER BY l.line_no LIMIT 1) AS first_sbu
       FROM gw.enquiries e WHERE e.id = $1 FOR UPDATE`, [enquiryId])).rows[0];
  if (!cur || !cur.first_sbu || cur.first_sbu === cur.primary_sbu_id) return;
  await c.query(
    `UPDATE gw.enquiries SET primary_sbu_id = $2, updated_by = $3, updated_at = now(), row_version = row_version + 1 WHERE id = $1`,
    [enquiryId, cur.first_sbu, ctx.userId]);
  await audit(c, ctx, {
    entityType: 'enquiries', entityId: enquiryId, action: 'update', field: 'primary_sbu_id',
    oldValue: cur.primary_sbu_id ?? undefined, newValue: cur.first_sbu,
  });
}

interface NewEnquiry {
  companyId: string;
  customerId: string;
  contactId?: string | null;
  endCustomerName?: string | null;
  partnerId?: string | null;
  accountManagerId: string;
  businessTypeId: string;
  title: string;
  description?: string | null;
  receivedAt?: string | null;
  approxBudget?: number | null;
  budgetCurrency?: string | null;
  expectedQuoteDate?: string | null;
  expectedPoDate?: string | null;
  probabilityPct?: number | null;
  remarks?: string | null;
  source?: string | null;
  campaignId?: string | null;
  leadId?: string | null;
  lines: LineIn[];
}

/** Enquiry + lines + the opening stage_history row, inside the caller's transaction. Returns the new id. */
async function createEnquiry(c: pg.PoolClient, ctx: AuthCtx, n: NewEnquiry): Promise<string> {
  const resolved: (string | null)[] = [];
  for (const l of n.lines) resolved.push(await resolveLineSbu(c, l));
  const primarySbu = resolved.find((s) => s) ?? null;

  const enquiryNo = await nextNumber(c, 'enquiry', n.companyId, 'ENQ');
  const ins = await c.query(
    `INSERT INTO gw.enquiries
       (enquiry_no, company_id, customer_id, end_customer_name, partner_id, contact_id, account_manager_id,
        business_type_id, primary_sbu_id, title, description, received_at, approx_budget, budget_currency,
        expected_quote_date, expected_po_date, probability_pct, stage, remarks, lead_id, campaign_id, source,
        created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12::timestamptz, now()),$13,COALESCE($14,'${BASE_CCY}'),
             $15,$16,$17,'New',$18,$19,$20,$21,$22,$22)
     RETURNING id`,
    [enquiryNo, n.companyId, n.customerId, n.endCustomerName ?? null, n.partnerId ?? null, n.contactId ?? null,
     n.accountManagerId, n.businessTypeId, primarySbu, n.title, n.description ?? null, n.receivedAt ?? null,
     n.approxBudget ?? null, n.budgetCurrency ?? null, n.expectedQuoteDate ?? null, n.expectedPoDate ?? null,
     n.probabilityPct ?? null, n.remarks ?? null, n.leadId ?? null, n.campaignId ?? null, n.source ?? null,
     ctx.userId]);
  const id = ins.rows[0].id as string;

  for (let i = 0; i < n.lines.length; i++) {
    const l = n.lines[i];
    const ln = await c.query(
      `INSERT INTO gw.enquiry_lines (enquiry_id, line_no, technology_id, sbu_id, product_sku_id, service_id, description, quantity)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [id, i + 1, l.technologyId ?? null, resolved[i], l.productSkuId ?? null, l.serviceId ?? null, l.description, l.quantity]);
    await audit(c, ctx, { entityType: 'enquiry_lines', entityId: ln.rows[0].id, action: 'create' });
  }

  // The trigger only fires on UPDATE, so the opening history row is ours to write (append-only table).
  await c.query(
    `INSERT INTO gw.stage_history (enquiry_id, from_stage, to_stage, changed_by, remarks) VALUES ($1, NULL, 'New', $2, 'Enquiry created')`,
    [id, ctx.userId]);
  await audit(c, ctx, { entityType: 'enquiries', entityId: id, action: 'create' });
  return id;
}

/** Loads an enquiry inside the caller's scope (optionally locking it). 404 when out of scope — never reveals existence. */
async function loadEnquiryScoped(c: pg.PoolClient, ctx: AuthCtx, scope: Scope, id: string, lock = false): Promise<Row> {
  const sc = scopeSql(ctx, scope, { alias: 'e', ownerCol: 'account_manager_id', sbuCol: 'primary_sbu_id', entity: 'enquiries' }, 2);
  const r = await c.query(
    `SELECT e.id, e.stage::text AS stage, e.account_manager_id, e.primary_sbu_id, e.customer_id
       FROM gw.enquiries e WHERE e.id = $1 AND e.deleted_at IS NULL AND ${sc.sql} ${lock ? 'FOR UPDATE OF e' : ''}`,
    [id, ...sc.params]);
  if (!r.rows.length) throw notFound('Enquiry');
  return r.rows[0];
}

/* ───────────────────────── lead row shape ───────────────────────── */

const LEAD_COLS = `
  l.id, l.lead_no, l.company_name, l.customer_id, l.contact_name, l.designation, l.email, l.phone, l.country,
  l.source, l.source_detail, l.estimated_value, l.currency, l.score, l.status::text AS status,
  l.campaign_id, camp.campaign_code, camp.name AS campaign_name,
  l.technology_id, t.name AS technology_name,
  COALESCE(l.sbu_id, t.sbu_id, tc.sbu_id) AS sbu_id, s.code AS sbu_code,
  l.owner_id, ow.full_name AS owner_name,
  floor(extract(epoch FROM (now() - l.created_at)) / 86400)::int AS age_days,
  l.qualified_at, l.qualified_enquiry_id, l.disqualify_reason, l.consent_marketing, l.created_at,
  l.score::text AS _score, l.created_at::text AS _ts`;
const LEAD_FROM = `
  FROM gw.leads l
  LEFT JOIN gw.campaigns camp ON camp.id = l.campaign_id
  LEFT JOIN gw.technologies t ON t.id = l.technology_id
  LEFT JOIN gw.technology_categories tc ON tc.id = t.category_id
  LEFT JOIN gw.sbus s ON s.id = COALESCE(l.sbu_id, t.sbu_id, tc.sbu_id)
  LEFT JOIN gw.employees ow ON ow.id = l.owner_id`;

async function fetchLeadRow(c: pg.PoolClient, id: string): Promise<Row> {
  const r = await c.query(`SELECT ${LEAD_COLS} ${LEAD_FROM} WHERE l.id = $1`, [id]);
  if (!r.rows.length) throw notFound('Lead');
  return stripKeys(r.rows[0], '_score', '_ts');
}

/* ───────────────────────── routes ───────────────────────── */

export async function salesRoutes(app: FastifyInstance) {
  /* ═════════════ Enquiries ═════════════ */

  app.get('/api/v1/enquiries', async (req) => {
    const scope = require_(req.auth, 'enquiries.view');
    const qs = parse(listQuery, req.query);
    const { where, params } = enquiryWhere(req.auth, scope, qs);
    const cur = decodeCursor(qs.cursor);
    const asc = qs.sort === 'received_at';
    let keyset = '';
    if (cur) {
      params.push(String(cur.t), String(cur.id));
      keyset = ` AND (e.received_at, e.id) ${asc ? '>' : '<'} ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    params.push(qs.limit + 1);
    const dir = asc ? 'ASC' : 'DESC';
    const rows = await guard(() => q(
      `SELECT ${ROW_COLS} ${ROW_FROM}
        WHERE ${where}${keyset}
        ORDER BY e.received_at ${dir}, e.id ${dir}
        LIMIT $${params.length}`, params));
    const more = rows.length > qs.limit;
    const page = more ? rows.slice(0, qs.limit) : rows;
    const last = page[page.length - 1];
    const nextCursor = more && last ? encodeCursor({ t: last._ts, id: last.id }) : null;
    return { data: page.map(cleanRow), nextCursor };
  });

  app.get('/api/v1/enquiries/:id', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'enquiries.view');
    const { id } = parse(idParam, req.params);
    const sc = scopeSql(ctx, scope, { alias: 'e', ownerCol: 'account_manager_id', sbuCol: 'primary_sbu_id', entity: 'enquiries' }, 2);

    const head = await q1(
      `SELECT ${ROW_COLS},
              e.company_id, e.description, e.remarks, e.end_customer_name, e.partner_id, e.contact_id, e.source,
              bt.code AS business_type_code, bt.name AS business_type_name,
              e.loss_reason_id, lr.name AS loss_reason, e.loss_remarks,
              camp.campaign_code, camp.name AS campaign_name,
              cc.full_name AS contact_name, cc.designation AS contact_designation, cc.email AS contact_email, cc.phone AS contact_phone,
              e.created_at, e.updated_at, e.row_version
         ${ROW_FROM}
         JOIN gw.business_types bt ON bt.id = e.business_type_id
         LEFT JOIN gw.loss_reasons lr ON lr.id = e.loss_reason_id
         LEFT JOIN gw.campaigns camp ON camp.id = e.campaign_id
         LEFT JOIN gw.customer_contacts cc ON cc.id = e.contact_id
        WHERE e.id = $1 AND e.deleted_at IS NULL AND ${sc.sql}`,
      [id, ...sc.params]);
    if (!head) throw notFound('Enquiry');
    cleanRow(head);
    const isOwn = head.account_manager_id === ctx.employeeId;

    const canQuotes = scopeFor(ctx, 'quotations.view') !== null;
    const canProc = scopeFor(ctx, 'procurement_requests.view') !== null;
    const canEst = scopeFor(ctx, 'technical_estimations.view') !== null;
    const canPo = scopeFor(ctx, 'customer_pos.view') !== null;

    const [lines, history, followUps, competitors, procurement, estimation, quoteRows, pos, customer] = await Promise.all([
      q(`SELECT l.id, l.line_no, l.technology_id, t.name AS technology_name, tc.name AS technology_category,
                l.product_sku_id, l.service_id, l.description, l.quantity,
                COALESCE(l.sbu_id, t.sbu_id, tc.sbu_id) AS sbu_id, s.code AS sbu_code, s.name AS sbu_name
           FROM gw.enquiry_lines l
           LEFT JOIN gw.technologies t ON t.id = l.technology_id
           LEFT JOIN gw.technology_categories tc ON tc.id = t.category_id
           LEFT JOIN gw.sbus s ON s.id = COALESCE(l.sbu_id, t.sbu_id, tc.sbu_id)
          WHERE l.enquiry_id = $1 ORDER BY l.line_no`, [id]),
      q(`SELECT h.id, h.from_stage::text AS from_stage, h.to_stage::text AS to_stage, h.changed_at, h.changed_by,
                u.display_name AS changed_by_name, h.remarks
           FROM gw.stage_history h LEFT JOIN gw.users u ON u.id = h.changed_by
          WHERE h.enquiry_id = $1 ORDER BY h.changed_at DESC, h.id`, [id]),
      q(`SELECT f.id, f.followed_up_at, f.next_follow_up::text AS next_follow_up, f.channel, f.remarks,
                f.customer_feedback, f.created_by, u.display_name AS created_by_name
           FROM gw.follow_ups f LEFT JOIN gw.users u ON u.id = f.created_by
          WHERE f.enquiry_id = $1 ORDER BY f.followed_up_at DESC, f.id DESC`, [id]),
      q(`SELECT id, competitor, known_price, currency, notes FROM gw.enquiry_competitors WHERE enquiry_id = $1 ORDER BY competitor`, [id]),
      canProc
        ? q(`SELECT p.id, p.request_no, p.status::text AS status, p.urgency::text AS urgency, p.raised_at, p.first_responded_at
               FROM gw.procurement_requests p WHERE p.enquiry_id = $1 ORDER BY p.raised_at DESC`, [id])
        : Promise.resolve(null),
      canEst
        ? q(`SELECT r.id, r.request_no, r.sbu_id, s.code AS sbu_code, r.status::text AS status, r.urgency::text AS urgency,
                    r.raised_at, r.first_responded_at
               FROM gw.estimation_requests r LEFT JOIN gw.sbus s ON s.id = r.sbu_id
              WHERE r.enquiry_id = $1 ORDER BY r.raised_at DESC`, [id])
        : Promise.resolve(null),
      canQuotes
        ? q(`SELECT qt.id AS quotation_id, qt.quotation_no, qt.owner_id, qt.current_version,
                    qv.id AS version_id, qv.version_no, qv.status::text AS status, qv.quote_date::text AS quote_date,
                    qv.valid_until::text AS valid_until, qv.currency, qv.total_cost, qv.total_sell, qv.total_tax,
                    qv.gross_profit, qv.gross_margin_pct, qv.requires_approval, qv.approved_at, qv.submitted_at, qv.created_at
               FROM gw.quotations qt LEFT JOIN gw.quotation_versions qv ON qv.quotation_id = qt.id
              WHERE qt.enquiry_id = $1 ORDER BY qt.quotation_no, qv.version_no DESC`, [id])
        : Promise.resolve(null),
      canPo
        ? q(`SELECT p.id, p.po_ref, p.customer_po_number, p.po_date::text AS po_date, p.currency, p.po_amount, p.net_value,
                    p.payment_terms_days, p.quotation_version_id, p.sow_version_id,
                    p.booked_cost, p.booked_gross_profit, p.booked_margin_pct
               FROM gw.customer_pos p WHERE p.enquiry_id = $1 ORDER BY p.created_at`, [id])
        : Promise.resolve(null),
      q1(`SELECT c.id, c.customer_code, c.name, c.industry, c.location, c.country, c.customer_type,
                 c.account_manager_id, am.full_name AS account_manager_name, c.payment_terms_days, c.default_currency,
                 c.credit_limit, c.credit_currency, c.is_active
            FROM gw.customers c LEFT JOIN gw.employees am ON am.id = c.account_manager_id
           WHERE c.id = $1`, [head.customer_id]),
    ]);

    // Group quotation versions under their quotation; masking strips cost/margin/sell the caller may not see.
    let quotations: Row[] | null = null;
    if (quoteRows) {
      const byQuote = new Map<string, Row>();
      for (const r of quoteRows) {
        let qn = byQuote.get(r.quotation_id);
        if (!qn) {
          qn = { id: r.quotation_id, quotation_no: r.quotation_no, owner_id: r.owner_id, current_version: r.current_version, versions: [] as Row[] };
          byQuote.set(r.quotation_id, qn);
        }
        if (r.version_id) {
          const own = isOwn || r.owner_id === ctx.employeeId;
          const { quotation_id, quotation_no, owner_id, current_version, version_id, ...ver } = r;
          void quotation_id; void quotation_no; void owner_id; void current_version;
          qn.versions.push(mask(ctx, 'quotation_versions', { id: version_id, ...ver }, own));
        }
      }
      quotations = [...byQuote.values()];
    }

    return {
      data: {
        ...head,
        lines,
        stage_history: history,
        follow_ups: followUps,
        competitors,
        // null = the caller does not hold the permission for that section (distinct from "none yet" = [])
        procurement_requests: procurement,
        estimation_requests: estimation,
        quotations,
        customer_pos: pos ? pos.map((p) => mask(ctx, 'customer_pos', p, isOwn)) : null,
        customer: customer ? mask(ctx, 'customers', customer, customer.account_manager_id === ctx.employeeId) : null,
      },
    };
  });

  app.post('/api/v1/enquiries', async (req, reply) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'enquiries.create');
    const b = parse(createEnquiryBody, req.body);
    const amId = b.accountManagerId ?? ctx.employeeId;
    if (!amId) throw badRequest('owner_required', 'Choose the account manager who owns this enquiry.');
    if (scope === 'O' && amId !== ctx.employeeId)
      throw forbidden('You can only create enquiries that you own. Ask a manager to assign it to someone else.');

    const row = await guard(() => tx(txCtx(ctx, scope), async (c) => {
      const cust = (await c.query(
        `SELECT id, company_id FROM gw.customers WHERE id = $1 AND deleted_at IS NULL AND is_active`, [b.customerId])).rows[0];
      if (!cust) throw badRequest('unknown_customer', 'That customer does not exist or is inactive. Pick an existing customer or create it first.');
      if (b.contactId) {
        const ok = await c.query(`SELECT 1 FROM gw.customer_contacts WHERE id = $1 AND customer_id = $2`, [b.contactId, b.customerId]);
        if (!ok.rows.length) throw badRequest('unknown_contact', 'That contact does not belong to the selected customer.');
      }
      const id = await createEnquiry(c, ctx, {
        companyId: cust.company_id, customerId: b.customerId, contactId: b.contactId, endCustomerName: b.endCustomerName,
        partnerId: b.partnerId, accountManagerId: amId, businessTypeId: b.businessTypeId, title: b.title,
        description: b.description, receivedAt: b.receivedAt, approxBudget: b.approxBudget, budgetCurrency: b.budgetCurrency,
        expectedQuoteDate: b.expectedQuoteDate, expectedPoDate: b.expectedPoDate, probabilityPct: b.probabilityPct,
        remarks: b.remarks, source: b.source, campaignId: b.campaignId, lines: b.lines,
      });
      return fetchEnquiryRow(c, id);
    }));
    reply.code(201);
    return { data: row };
  });

  app.patch('/api/v1/enquiries/:id', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'enquiries.edit');
    const { id } = parse(idParam, req.params);
    const raw = req.body;
    if (raw && typeof raw === 'object' && 'stage' in raw)
      throw badRequest('stage_not_editable', 'Stage cannot be changed here. Use the stage action so the gates and history apply.');
    const b = parse(patchEnquiryBody, raw);
    const keys = (Object.keys(b) as (keyof typeof b)[]).filter((k) => b[k] !== undefined);
    if (!keys.length) throw badRequest('nothing_to_update', 'Send at least one field to change.');

    const row = await guard(() => tx(txCtx(ctx, scope), async (c) => {
      const sc = scopeSql(ctx, scope, { alias: 'e', ownerCol: 'account_manager_id', sbuCol: 'primary_sbu_id', entity: 'enquiries' }, 2);
      const cur = (await c.query(
        `SELECT e.title, e.description, e.approx_budget, e.expected_quote_date::text AS expected_quote_date,
                e.expected_po_date::text AS expected_po_date, e.probability_pct, e.remarks, e.end_customer_name,
                e.contact_id, e.customer_id
           FROM gw.enquiries e WHERE e.id = $1 AND e.deleted_at IS NULL AND ${sc.sql} FOR UPDATE OF e`,
        [id, ...sc.params])).rows[0];
      if (!cur) throw notFound('Enquiry');

      const norm = (v: unknown) => (v === null || v === undefined ? null : String(v));
      const changed = keys.filter((k) => norm(b[k]) !== norm(cur[PATCH_COLUMNS[k]]));
      if (b.contactId && changed.includes('contactId')) {
        const ok = await c.query(`SELECT 1 FROM gw.customer_contacts WHERE id = $1 AND customer_id = $2`, [b.contactId, cur.customer_id]);
        if (!ok.rows.length) throw badRequest('unknown_contact', 'That contact does not belong to this enquiry\'s customer.');
      }
      if (changed.length) {
        const params: any[] = [id, ctx.userId];
        const sets = changed.map((k) => { params.push(b[k] ?? null); return `${PATCH_COLUMNS[k]} = $${params.length}`; });
        await c.query(
          `UPDATE gw.enquiries SET ${sets.join(', ')}, updated_by = $2, updated_at = now(), row_version = row_version + 1 WHERE id = $1`,
          params);
        for (const k of changed) {
          await audit(c, ctx, {
            entityType: 'enquiries', entityId: id, action: 'update', field: PATCH_COLUMNS[k],
            oldValue: cur[PATCH_COLUMNS[k]] ?? undefined, newValue: b[k] ?? undefined,
          });
        }
      }
      return fetchEnquiryRow(c, id);
    }));
    return { data: row };
  });

  app.post('/api/v1/enquiries/:id/stage', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'enquiries.edit');
    const { id } = parse(idParam, req.params);
    const b = parse(stageBody, req.body);
    const remarks = b.remarks?.trim() || null;

    const row = await guard(() => tx(txCtx(ctx, scope), async (c) => {
      const cur = await loadEnquiryScoped(c, ctx, scope, id, true);
      if (cur.stage === b.stage) throw badRequest('same_stage', `This enquiry is already in ${b.stage}.`);

      // Gates — each message says what to do next.
      if (b.stage === 'Submitted') {
        const ok = await c.query(
          `SELECT 1 FROM gw.quotation_versions qv JOIN gw.quotations qt ON qt.id = qv.quotation_id
            WHERE qt.enquiry_id = $1 AND qv.status IN ('Approved','Submitted') LIMIT 1`, [id]);
        if (!ok.rows.length)
          throw gateBlocked('No approved quotation yet. Get a quotation version approved (or submitted) on this enquiry, then move it to Submitted.');
      }
      if (b.stage === 'Won') {
        const ok = await c.query(`SELECT 1 FROM gw.customer_pos WHERE enquiry_id = $1 LIMIT 1`, [id]);
        if (!ok.rows.length) throw gateBlocked('Record the customer PO and the agreed SOW before marking this won.');
      }
      if (b.stage === 'Lost') {
        if (!b.lossReasonId) throw gateBlocked('Choose a loss reason before marking this enquiry Lost.');
        const ok = await c.query(`SELECT 1 FROM gw.loss_reasons WHERE id = $1 AND is_active`, [b.lossReasonId]);
        if (!ok.rows.length) throw gateBlocked('That loss reason is not available. Pick one from the loss-reason list.');
      }
      if ((b.stage === 'Cancelled' || b.stage === 'Dropped') && !remarks)
        throw gateBlocked(`Say why this enquiry is being ${b.stage.toLowerCase()} in the remarks box before continuing.`);

      const closing = b.stage === 'Lost' || b.stage === 'Cancelled' || b.stage === 'Dropped';
      const lossText = closing ? (b.stage === 'Lost' ? (b.lossRemarks?.trim() || remarks) : remarks) : null;
      // The stage_history row and slip_count are written by the database trigger. That trigger function
      // references stage_history unqualified, so pin the search_path for this transaction (no-op if the role has it).
      await c.query(`SET LOCAL search_path TO gw, public`);
      await c.query(
        `UPDATE gw.enquiries
            SET stage = $2::gw.enquiry_stage, loss_reason_id = $3, loss_remarks = $4,
                updated_by = $5, updated_at = now(), row_version = row_version + 1
          WHERE id = $1`,
        [id, b.stage, b.stage === 'Lost' ? b.lossReasonId : null, lossText, ctx.userId]);
      await audit(c, ctx, {
        entityType: 'enquiries', entityId: id, action: 'update', field: 'stage',
        oldValue: cur.stage, newValue: b.stage, reason: remarks ?? b.lossRemarks ?? undefined,
      });
      return fetchEnquiryRow(c, id);
    }));
    return { data: row };
  });

  /* ── lines ── */

  app.post('/api/v1/enquiries/:id/lines', async (req, reply) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'enquiries.edit');
    const { id } = parse(idParam, req.params);
    const b = parse(lineIn, req.body);
    const line = await guard(() => tx(txCtx(ctx, scope), async (c) => {
      await loadEnquiryScoped(c, ctx, scope, id, true);
      const sbu = await resolveLineSbu(c, b);
      const next = (await c.query(`SELECT COALESCE(max(line_no), 0) + 1 AS n FROM gw.enquiry_lines WHERE enquiry_id = $1`, [id])).rows[0].n;
      const ins = await c.query(
        `INSERT INTO gw.enquiry_lines (enquiry_id, line_no, technology_id, sbu_id, product_sku_id, service_id, description, quantity)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [id, next, b.technologyId ?? null, sbu, b.productSkuId ?? null, b.serviceId ?? null, b.description, b.quantity]);
      await audit(c, ctx, { entityType: 'enquiry_lines', entityId: ins.rows[0].id, action: 'create' });
      await syncPrimarySbu(c, ctx, id);
      return ins.rows[0];
    }));
    reply.code(201);
    return { data: line };
  });

  app.patch('/api/v1/enquiry-lines/:id', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'enquiries.edit');
    const { id } = parse(idParam, req.params);
    const b = parse(patchLineBody, req.body);
    const keys = (Object.keys(b) as (keyof typeof b)[]).filter((k) => b[k] !== undefined);
    if (!keys.length) throw badRequest('nothing_to_update', 'Send at least one field to change.');

    const line = await guard(() => tx(txCtx(ctx, scope), async (c) => {
      const sc = scopeSql(ctx, scope, { alias: 'e', ownerCol: 'account_manager_id', sbuCol: 'primary_sbu_id', entity: 'enquiries' }, 2);
      const cur = (await c.query(
        `SELECT l.* FROM gw.enquiry_lines l JOIN gw.enquiries e ON e.id = l.enquiry_id
          WHERE l.id = $1 AND e.deleted_at IS NULL AND ${sc.sql} FOR UPDATE OF l`, [id, ...sc.params])).rows[0];
      if (!cur) throw notFound('Enquiry line');

      const merged = {
        technologyId: 'technologyId' in b ? b.technologyId : cur.technology_id,
        productSkuId: 'productSkuId' in b ? b.productSkuId : cur.product_sku_id,
        serviceId: 'serviceId' in b ? b.serviceId : cur.service_id,
      };
      const sourceChanged = ['technologyId', 'productSkuId', 'serviceId'].some((k) => k in b);
      let sbuId: string | null = cur.sbu_id;
      if (b.sbuId) sbuId = b.sbuId;
      else if (sourceChanged || ('sbuId' in b && b.sbuId === null)) sbuId = await resolveLineSbu(c, merged);

      const next = {
        technology_id: merged.technologyId ?? null,
        product_sku_id: merged.productSkuId ?? null,
        service_id: merged.serviceId ?? null,
        sbu_id: sbuId,
        description: b.description ?? cur.description,
        quantity: b.quantity ?? cur.quantity,
      };
      const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => String(next[k] ?? '') !== String(cur[k] ?? ''));
      if (changed.length) {
        const params: any[] = [id];
        const sets = changed.map((k) => { params.push(next[k]); return `${k} = $${params.length}`; });
        await c.query(`UPDATE gw.enquiry_lines SET ${sets.join(', ')} WHERE id = $1`, params);
        for (const k of changed)
          await audit(c, ctx, {
            entityType: 'enquiry_lines', entityId: id, action: 'update', field: k,
            oldValue: cur[k] ?? undefined, newValue: next[k] ?? undefined,
          });
        await syncPrimarySbu(c, ctx, cur.enquiry_id);
      }
      return (await c.query(`SELECT * FROM gw.enquiry_lines WHERE id = $1`, [id])).rows[0];
    }));
    return { data: line };
  });

  app.delete('/api/v1/enquiry-lines/:id', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'enquiries.edit');
    const { id } = parse(idParam, req.params);
    await guard(() => tx(txCtx(ctx, scope), async (c) => {
      const sc = scopeSql(ctx, scope, { alias: 'e', ownerCol: 'account_manager_id', sbuCol: 'primary_sbu_id', entity: 'enquiries' }, 2);
      const cur = (await c.query(
        `SELECT l.id, l.enquiry_id, l.line_no FROM gw.enquiry_lines l JOIN gw.enquiries e ON e.id = l.enquiry_id
          WHERE l.id = $1 AND e.deleted_at IS NULL AND ${sc.sql} FOR UPDATE OF l`, [id, ...sc.params])).rows[0];
      if (!cur) throw notFound('Enquiry line');
      const cnt = (await c.query(`SELECT count(*)::int AS n FROM gw.enquiry_lines WHERE enquiry_id = $1`, [cur.enquiry_id])).rows[0].n;
      if (cnt <= 1) throw gateBlocked('An enquiry needs at least one line. Add the replacement line first, then remove this one.');
      const used = await c.query(
        `SELECT (EXISTS (SELECT 1 FROM gw.quotation_lines WHERE enquiry_line_id = $1)) AS in_quote,
                (EXISTS (SELECT 1 FROM gw.procurement_request_lines WHERE enquiry_line_id = $1)) AS in_proc`, [id]);
      if (used.rows[0].in_quote || used.rows[0].in_proc)
        throw gateBlocked('This line is already used by a quotation or procurement request, so it cannot be removed. Edit the line instead.');
      await c.query(`DELETE FROM gw.enquiry_lines WHERE id = $1`, [id]);
      await audit(c, ctx, { entityType: 'enquiry_lines', entityId: id, action: 'soft_delete', reason: `Line ${cur.line_no} removed from enquiry` });
      await syncPrimarySbu(c, ctx, cur.enquiry_id);
    }));
    return { data: { id, deleted: true } };
  });

  /* ── follow-ups & competitors ── */

  app.post('/api/v1/enquiries/:id/follow-ups', async (req, reply) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'enquiries.edit');
    const { id } = parse(idParam, req.params);
    const b = parse(followUpBody, req.body);
    const row = await guard(() => tx(txCtx(ctx, scope), async (c) => {
      await loadEnquiryScoped(c, ctx, scope, id);
      const ins = await c.query(
        `INSERT INTO gw.follow_ups (enquiry_id, next_follow_up, channel, remarks, customer_feedback, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, enquiry_id, followed_up_at, next_follow_up::text AS next_follow_up, channel, remarks, customer_feedback, created_by`,
        [id, b.nextFollowUp ?? null, b.channel ?? null, b.remarks, b.customerFeedback ?? null, ctx.userId]);
      await audit(c, ctx, { entityType: 'follow_ups', entityId: ins.rows[0].id, action: 'create' });
      return ins.rows[0];
    }));
    reply.code(201);
    return { data: row };
  });

  app.post('/api/v1/enquiries/:id/competitors', async (req, reply) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'enquiries.edit');
    const { id } = parse(idParam, req.params);
    const b = parse(competitorBody, req.body);
    const row = await guard(() => tx(txCtx(ctx, scope), async (c) => {
      await loadEnquiryScoped(c, ctx, scope, id);
      const ins = await c.query(
        `INSERT INTO gw.enquiry_competitors (enquiry_id, competitor, known_price, currency, notes)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, enquiry_id, competitor, known_price, currency, notes`,
        [id, b.competitor, b.knownPrice ?? null, b.currency ?? null, b.notes ?? null]);
      await audit(c, ctx, { entityType: 'enquiry_competitors', entityId: ins.rows[0].id, action: 'create' });
      return ins.rows[0];
    }));
    reply.code(201);
    return { data: row };
  });

  /* ═════════════ Pipeline ═════════════ */

  app.get('/api/v1/pipeline/board', async (req) => {
    const scope = require_(req.auth, 'enquiries.view');
    const qs = parse(boardQuery, req.query);
    const { where, params } = enquiryWhere(req.auth, scope, qs);
    const base = `SELECT ${ROW_COLS} ${ROW_FROM} WHERE ${where}`;

    const aggP = [...params];
    const cardP = [...params, qs.cardsPerStage];
    const [aggs, cards] = await Promise.all([
      q(`WITH base AS (${base})
         SELECT stage, count(*)::int AS count,
                COALESCE(sum(value_aed), 0) AS total_value,
                COALESCE(sum(weighted_value_aed), 0) AS weighted_value,
                count(*) FILTER (WHERE approx_budget IS NOT NULL AND value_aed IS NULL)::int AS unconverted_count
           FROM base GROUP BY stage`, aggP),
      q(`WITH base AS (${base}),
              ranked AS (
                SELECT base.*, row_number() OVER (
                         PARTITION BY stage ORDER BY value_aed DESC NULLS LAST, received_at DESC, id) AS _rn
                  FROM base)
         SELECT * FROM ranked WHERE _rn <= $${cardP.length} ORDER BY stage, _rn`, cardP),
    ]);

    const byStage = new Map<string, Row>(aggs.map((a) => [a.stage as string, a]));
    const cardsBy = new Map<string, Row[]>();
    for (const r of cards) {
      stripKeys(r, '_rn', '_ts');
      const list = cardsBy.get(r.stage) ?? [];
      list.push(r);
      cardsBy.set(r.stage, list);
    }
    const stages = STAGES.map((st: Stage) => {
      const a = byStage.get(st);
      return {
        stage: st,
        count: a?.count ?? 0,
        total_value: a?.total_value ?? 0,
        weighted_value: a?.weighted_value ?? 0,
        unconverted_count: a?.unconverted_count ?? 0,
        cards: cardsBy.get(st) ?? [],
      };
    });
    return { data: { currency: BASE_CCY, cards_per_stage: qs.cardsPerStage, stages } };
  });

  app.get('/api/v1/pipeline/summary', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'enquiries.view');
    const qs = parse(summaryQuery, req.query);
    const year = new Date().getUTCFullYear();
    const from = qs.from ?? `${year}-01-01`;
    const to = qs.to ?? `${year}-12-31`;
    if (from > to) throw badRequest('bad_period', 'The "from" date must not be after the "to" date.');

    const { where, params } = enquiryWhere(ctx, scope, {
      ownerId: qs.ownerId, sbuId: qs.sbuId, businessTypeId: qs.businessTypeId, customerId: qs.customerId,
    });
    params.push(from, to);
    const pf = `$${params.length - 1}`, pt = `$${params.length}`;
    const fromTs = `((${pf}::date)::timestamp AT TIME ZONE 'Asia/Dubai')`;
    const toTs = `((${pt}::date + 1)::timestamp AT TIME ZONE 'Asia/Dubai')`;

    const row = await guard(() => q1(
      `WITH s AS (
         SELECT e.id, e.stage::text AS stage, e.probability_pct, e.created_at,
                (e.approx_budget * ${fxRate(`COALESCE(e.budget_currency,'${BASE_CCY}')`)}) AS value_aed,
                COALESCE(
                  (SELECT sum(p.net_value * ${fxRate('p.currency')}) FROM gw.customer_pos p WHERE p.enquiry_id = e.id),
                  e.approx_budget * ${fxRate(`COALESCE(e.budget_currency,'${BASE_CCY}')`)}) AS won_value_aed,
                hx.won_at, hx.lost_at, hx.new_at,
                (fu.next_follow_up < ${TODAY}) AS fu_overdue
           FROM gw.enquiries e
           LEFT JOIN LATERAL (
             SELECT max(h.changed_at) FILTER (WHERE h.to_stage = 'Won')  AS won_at,
                    max(h.changed_at) FILTER (WHERE h.to_stage = 'Lost') AS lost_at,
                    min(h.changed_at) FILTER (WHERE h.to_stage = 'New')  AS new_at
               FROM gw.stage_history h WHERE h.enquiry_id = e.id) hx ON true
           LEFT JOIN LATERAL (
             SELECT f.next_follow_up FROM gw.follow_ups f WHERE f.enquiry_id = e.id
              ORDER BY f.followed_up_at DESC, f.id DESC LIMIT 1) fu ON true
          WHERE ${where}),
       agg AS (
         SELECT
           count(*) FILTER (WHERE stage IN ${OPEN_SQL})::int                                          AS open_count,
           COALESCE(sum(value_aed) FILTER (WHERE stage IN ${OPEN_SQL}), 0)                            AS open_value,
           COALESCE(sum(value_aed * COALESCE(probability_pct, 0) / 100) FILTER (WHERE stage IN ${OPEN_SQL}), 0) AS weighted_value,
           count(*) FILTER (WHERE stage = 'Won' AND won_at >= ${fromTs} AND won_at < ${toTs})::int    AS won_count,
           COALESCE(sum(won_value_aed) FILTER (WHERE stage = 'Won' AND won_at >= ${fromTs} AND won_at < ${toTs}), 0) AS won_value,
           count(*) FILTER (WHERE stage = 'Lost' AND lost_at >= ${fromTs} AND lost_at < ${toTs})::int AS lost_count,
           COALESCE(sum(value_aed) FILTER (WHERE stage = 'Lost' AND lost_at >= ${fromTs} AND lost_at < ${toTs}), 0) AS lost_value,
           avg(extract(epoch FROM (won_at - COALESCE(new_at, created_at))) / 86400)
             FILTER (WHERE stage = 'Won' AND won_at >= ${fromTs} AND won_at < ${toTs})                AS avg_cycle,
           count(*) FILTER (WHERE stage IN ${OPEN_SQL} AND fu_overdue)::int                           AS overdue_follow_ups
         FROM s)
       SELECT open_count, open_value, weighted_value, won_count, won_value, lost_count, lost_value,
              CASE WHEN won_count + lost_count > 0
                   THEN round(100.0 * won_count / (won_count + lost_count), 1) END                    AS conversion_pct,
              round(avg_cycle::numeric, 1)                                                            AS avg_sales_cycle_days,
              overdue_follow_ups
         FROM agg`, params));
    return { data: { currency: BASE_CCY, period: { from, to }, ...row } };
  });

  /* ═════════════ Leads ═════════════ */

  app.get('/api/v1/leads', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'enquiries.view');
    const qs = parse(leadListQuery, req.query);
    const sc = scopeSql(ctx, scope, { alias: 'l', ownerCol: 'owner_id', sbuCol: 'sbu_id', entity: 'leads' }, 1);
    const params: any[] = [...sc.params];
    const p = (v: any) => { params.push(v); return `$${params.length}`; };
    const w: string[] = [sc.sql];
    w.push(qs.status ? `l.status::text = ${p(qs.status)}` : `l.status IN ('New','Working','Nurturing')`);
    if (qs.ownerId) w.push(`l.owner_id = ${p(qs.ownerId)}`);
    if (qs.campaignId) w.push(`l.campaign_id = ${p(qs.campaignId)}`);
    if (qs.q) {
      const t = p(likeTerm(qs.q));
      w.push(`(l.lead_no ILIKE ${t} OR l.company_name ILIKE ${t} OR l.contact_name ILIKE ${t} OR l.email ILIKE ${t})`);
    }
    const cur = decodeCursor(qs.cursor);
    if (cur) {
      w.push(`(l.score, l.created_at, l.id) < (${p(Number(cur.s))}::int, ${p(String(cur.t))}::timestamptz, ${p(String(cur.id))}::uuid)`);
    }
    params.push(qs.limit + 1);
    const rows = await guard(() => q(
      `SELECT ${LEAD_COLS} ${LEAD_FROM}
        WHERE ${w.join(' AND ')}
        ORDER BY l.score DESC, l.created_at DESC, l.id DESC
        LIMIT $${params.length}`, params));
    const more = rows.length > qs.limit;
    const page = more ? rows.slice(0, qs.limit) : rows;
    const last = page[page.length - 1];
    const nextCursor = more && last ? encodeCursor({ s: last._score, t: last._ts, id: last.id }) : null;
    return { data: page.map((r) => stripKeys(r, '_score', '_ts')), nextCursor };
  });

  app.post('/api/v1/leads', async (req, reply) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'enquiries.create');
    const b = parse(createLeadBody, req.body);
    const ownerId = b.ownerId ?? ctx.employeeId ?? null;
    if (scope === 'O' && ownerId !== ctx.employeeId)
      throw forbidden('You can only create leads that you own. Ask a manager to assign it to someone else.');

    const row = await guard(() => tx(txCtx(ctx, scope), async (c) => {
      let companyId: string;
      if (b.customerId) {
        const cu = (await c.query(`SELECT company_id FROM gw.customers WHERE id = $1 AND deleted_at IS NULL`, [b.customerId])).rows[0];
        if (!cu) throw badRequest('unknown_customer', 'That customer does not exist. Leave it blank to qualify the lead as a new customer later.');
        companyId = cu.company_id;
      } else {
        companyId = await companyIdFor(c);
      }
      const sbuId = await resolveLineSbu(c, { sbuId: b.sbuId, technologyId: b.technologyId });
      const leadNo = await nextNumber(c, 'lead', companyId, 'LED');
      const ins = await c.query(
        `INSERT INTO gw.leads
           (lead_no, company_id, company_name, customer_id, contact_name, designation, email, phone, country,
            campaign_id, source, source_detail, technology_id, sbu_id, estimated_value, currency,
            owner_id, consent_marketing, consent_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,COALESCE($16,'${BASE_CCY}'),$17,$18,
                 CASE WHEN $18 THEN now() END,$19)
         RETURNING id`,
        [leadNo, companyId, b.companyName, b.customerId ?? null, b.contactName ?? null, b.designation ?? null,
         b.email ?? null, b.phone ?? null, b.country ?? null, b.campaignId ?? null, b.source ?? null,
         b.sourceDetail ?? null, b.technologyId ?? null, sbuId, b.estimatedValue ?? null, b.currency ?? null,
         ownerId, b.consentMarketing, ctx.userId]);
      await audit(c, ctx, { entityType: 'leads', entityId: ins.rows[0].id, action: 'create' });
      return fetchLeadRow(c, ins.rows[0].id);
    }));
    reply.code(201);
    return { data: row };
  });

  /** THE HANDOFF: marketing lead -> sales enquiry, atomically. */
  app.post('/api/v1/leads/:id/qualify', async (req, reply) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'enquiries.create');
    const { id } = parse(idParam, req.params);
    const b = parse(qualifyBody, req.body);

    const row = await guard(() => tx(txCtx(ctx, scope), async (c) => {
      const sc = scopeSql(ctx, scope, { alias: 'l', ownerCol: 'owner_id', sbuCol: 'sbu_id', entity: 'leads' }, 2);
      const lead = (await c.query(
        `SELECT l.*, t.name AS technology_name FROM gw.leads l LEFT JOIN gw.technologies t ON t.id = l.technology_id
          WHERE l.id = $1 AND ${sc.sql} FOR UPDATE OF l`, [id, ...sc.params])).rows[0];
      if (!lead) throw notFound('Lead');
      if (!LEAD_ACTIONABLE.includes(lead.status))
        throw gateBlocked(lead.status === 'Qualified'
          ? 'This lead has already been qualified and has an enquiry. Open that enquiry instead.'
          : `A ${String(lead.status).toLowerCase()} lead cannot be qualified. Move it back to the inbox first.`);

      const amId = b.accountManagerId ?? lead.owner_id ?? ctx.employeeId;
      if (!amId) throw badRequest('owner_required', 'Choose the account manager who will own the new enquiry.');
      if (scope === 'O' && amId !== ctx.employeeId)
        throw forbidden('You can only create enquiries that you own. Ask a manager to assign it to someone else.');

      // Customer: explicit -> already linked on the lead -> exact name match -> create from company_name.
      let customerId: string | null = b.customerId ?? lead.customer_id ?? null;
      if (customerId) {
        const ok = await c.query(`SELECT 1 FROM gw.customers WHERE id = $1 AND deleted_at IS NULL AND is_active`, [customerId]);
        if (!ok.rows.length) throw badRequest('unknown_customer', 'That customer does not exist or is inactive.');
      } else {
        const hit = await c.query(
          `SELECT id FROM gw.customers WHERE company_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL AND is_active
            ORDER BY created_at LIMIT 1`, [lead.company_id, lead.company_name]);
        if (hit.rows.length) customerId = hit.rows[0].id;
        else {
          const code = await nextNumber(c, 'customer', lead.company_id, 'CUS');
          const cu = await c.query(
            `INSERT INTO gw.customers (company_id, customer_code, name, country, account_manager_id, created_by, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING id`,
            [lead.company_id, code, lead.company_name, lead.country ?? null, amId, ctx.userId]);
          customerId = cu.rows[0].id as string;
          await audit(c, ctx, { entityType: 'customers', entityId: customerId, action: 'create', reason: `Created from lead ${lead.lead_no}` });
        }
      }

      if (!customerId) throw badRequest('unknown_customer', 'Could not resolve a customer for this lead.');

      // Contact: explicit -> match on email -> create from the lead's contact details.
      let contactId: string | null = b.contactId ?? null;
      if (contactId) {
        const ok = await c.query(`SELECT 1 FROM gw.customer_contacts WHERE id = $1 AND customer_id = $2`, [contactId, customerId]);
        if (!ok.rows.length) throw badRequest('unknown_contact', 'That contact does not belong to the selected customer.');
      } else if (lead.contact_name) {
        if (lead.email) {
          const hit = await c.query(
            `SELECT id FROM gw.customer_contacts WHERE customer_id = $1 AND lower(email) = lower($2) AND is_active LIMIT 1`,
            [customerId, lead.email]);
          if (hit.rows.length) contactId = hit.rows[0].id;
        }
        if (!contactId) {
          const has = (await c.query(`SELECT 1 FROM gw.customer_contacts WHERE customer_id = $1 LIMIT 1`, [customerId])).rows.length > 0;
          const ct = await c.query(
            `INSERT INTO gw.customer_contacts (customer_id, full_name, designation, email, phone, is_primary)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [customerId, lead.contact_name, lead.designation ?? null, lead.email ?? null, lead.phone ?? null, !has]);
          contactId = ct.rows[0].id as string;
          await audit(c, ctx, { entityType: 'customer_contacts', entityId: contactId, action: 'create', reason: `Created from lead ${lead.lead_no}` });
        }
      }

      const title = b.title ?? (lead.technology_name ? `${lead.company_name} - ${lead.technology_name}` : `${lead.company_name} - enquiry`);
      const enquiryId = await createEnquiry(c, ctx, {
        companyId: lead.company_id, customerId, contactId, accountManagerId: amId, businessTypeId: b.businessTypeId,
        title, description: b.description ?? lead.source_detail ?? null,
        approxBudget: b.approxBudget ?? lead.estimated_value ?? null, budgetCurrency: lead.currency ?? null,
        expectedQuoteDate: b.expectedQuoteDate, expectedPoDate: b.expectedPoDate, probabilityPct: b.probabilityPct,
        source: lead.source ?? null, campaignId: lead.campaign_id ?? null, leadId: lead.id,
        lines: [{
          technologyId: lead.technology_id ?? null, sbuId: lead.sbu_id ?? null,
          description: lead.technology_name ?? title, quantity: 1,
        }],
      });

      await c.query(
        `UPDATE gw.leads SET status = 'Qualified', qualified_at = now(), qualified_enquiry_id = $2,
                customer_id = $3, updated_at = now(), row_version = row_version + 1
          WHERE id = $1`, [id, enquiryId, customerId]);
      await audit(c, ctx, {
        entityType: 'leads', entityId: id, action: 'update', field: 'status',
        oldValue: lead.status, newValue: 'Qualified', reason: `Qualified into enquiry`,
      });
      return fetchEnquiryRow(c, enquiryId);
    }));
    reply.code(201);
    return { data: row };
  });

  app.post('/api/v1/leads/:id/disqualify', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'enquiries.edit');
    const { id } = parse(idParam, req.params);
    const b = parse(disqualifyBody, req.body);
    const row = await guard(() => tx(txCtx(ctx, scope), async (c) => {
      const sc = scopeSql(ctx, scope, { alias: 'l', ownerCol: 'owner_id', sbuCol: 'sbu_id', entity: 'leads' }, 2);
      const lead = (await c.query(
        `SELECT l.id, l.status::text AS status FROM gw.leads l WHERE l.id = $1 AND ${sc.sql} FOR UPDATE OF l`,
        [id, ...sc.params])).rows[0];
      if (!lead) throw notFound('Lead');
      if (!LEAD_ACTIONABLE.includes(lead.status))
        throw gateBlocked(`A ${String(lead.status).toLowerCase()} lead cannot be disqualified.`);
      await c.query(
        `UPDATE gw.leads SET status = 'Disqualified', disqualify_reason = $2, updated_at = now(), row_version = row_version + 1 WHERE id = $1`,
        [id, b.reason]);
      await audit(c, ctx, {
        entityType: 'leads', entityId: id, action: 'update', field: 'status',
        oldValue: lead.status, newValue: 'Disqualified', reason: b.reason,
      });
      return fetchLeadRow(c, id);
    }));
    return { data: row };
  });

  /* ═════════════ Campaigns ═════════════ */

  app.get('/api/v1/campaigns', async (req) => {
    require_(req.auth, 'enquiries.view');
    const qs = parse(campaignQuery, req.query);
    const params: any[] = [];
    const w: string[] = ['TRUE'];
    if (qs.active !== undefined) { params.push(qs.active); w.push(`c.is_active = $${params.length}`); }
    if (qs.q) { params.push(likeTerm(qs.q)); w.push(`(c.campaign_code ILIKE $${params.length} OR c.name ILIKE $${params.length})`); }
    const rows = await q(
      `SELECT v.*, c.start_date::text AS start_date, c.end_date::text AS end_date, c.budget, c.currency,
              c.target_leads, c.is_active, o.full_name AS owner_name
         FROM gw.v_campaign_attribution v
         JOIN gw.campaigns c ON c.id = v.campaign_id
         LEFT JOIN gw.employees o ON o.id = c.owner_id
        WHERE ${w.join(' AND ')}
        ORDER BY c.start_date DESC, c.campaign_code`, params);
    return { data: rows, nextCursor: null };
  });
}
