import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { q, q1, tx } from '../core/db.js';
import type { Row } from '../core/db.js';
import { require_, scopeFor, scopeSql, mask } from '../core/rbac.js';
import { audit } from '../core/audit.js';
import { AppError, badRequest, notFound, forbidden, gateBlocked, conflict } from '../core/errors.js';
import { nextNumber } from '../core/numbering.js';
import { workingHoursBetween } from '../core/sla.js';
import { config } from '../core/config.js';
import type { AuthCtx, FieldGroup, Scope } from '../core/types.js';

/* ───────────────────────── constants ───────────────────────── */

// Verified against enum_range(null::gw.quote_ver_status).
const VERSION_STATUSES = ['Draft', 'PendingApproval', 'Approved', 'Submitted', 'Superseded', 'Rejected'] as const;
const BASE_CCY = 'AED';
const TODAY = `(now() AT TIME ZONE 'Asia/Dubai')::date`; // OD-18: the Dubai calendar governs "today"
const DEFAULT_VALIDITY_DAYS = 30;

const TRIGGER_LOW_MARGIN = 'LOW_MARGIN';
const TRIGGER_MARGIN_OVERRIDE = 'MARGIN_OVERRIDE';

/** Cost components that sit on the version row but are not in FIELD_MAP; they are supplier-cost data. */
const COST_ADDERS = ['other_project_cost', 'operation_charges', 'training_charges'] as const;

/* ───────────────────────── validation ───────────────────────── */

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD');
const ccy = z.string().length(3).transform((s) => s.toUpperCase());
const money = z.number().nonnegative().max(1e14);
const longText = z.string().trim().max(20000);
const boolFlag = z.enum(['true', 'false']).transform((v) => v === 'true');
const idParam = z.object({ id: uuid });

const pageShape = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(500).optional(),
};

const listQuery = z.object({
  ...pageShape,
  q: z.string().trim().min(1).max(100).optional(),
  status: z.enum(VERSION_STATUSES).optional(),
  customerId: uuid.optional(),
  ownerId: uuid.optional(),
});

// Cost, totals, margin and line_no are deliberately absent: they are computed or copied server-side.
const lineFields = {
  description: z.string().trim().min(1).max(2000),
  partNumber: z.string().trim().min(1).max(255).nullable(),
  quantity: z.number().positive().max(1e9),
  unitPrice: money,
  discountPct: z.number().min(0).max(100),
  unitCost: money,
  taxCodeId: uuid.nullable(),
  productSkuId: uuid.nullable(),
  serviceId: uuid.nullable(),
  manufacturerId: uuid.nullable(),
  supplierId: uuid.nullable(),
  enquiryLineId: uuid.nullable(),
  supplierQuoteLineId: uuid.nullable(),
  technicalEstimateId: uuid.nullable(),
};
const linePatchSchema = z.object(lineFields).partial().strict();
type LineIn = z.infer<typeof linePatchSchema>;
const lineSyncSchema = z.object({ ...lineFields, id: uuid }).partial().strict();

const termsFields = {
  validUntil: isoDate.nullable(),
  currency: ccy,
  paymentTerms: longText.nullable(),
  deliveryTerms: longText.nullable(),
  scope: longText.nullable(),
  assumptions: longText.nullable(),
  exclusions: longText.nullable(),
  warranty: longText.nullable(),
  commercialTerms: longText.nullable(),
};
const adderFields = {
  otherProjectCost: money,
  operationCharges: money,
  trainingCharges: money,
};

const termsAndAdders = z.object({ ...termsFields, ...adderFields }).partial().shape;

const createQuotationBody = z
  .object({
    enquiryId: uuid,
    seedFromEnquiry: z.boolean().default(false),
    lines: z.array(linePatchSchema).max(500).optional(),
    ...termsAndAdders,
  })
  .strict();

const createVersionBody = z
  .object({
    lines: z.array(linePatchSchema).max(500).optional(),
    ...termsAndAdders,
  })
  .strict();

const patchVersionBody = z
  .object({ lines: z.array(lineSyncSchema).max(500), ...termsFields, ...adderFields })
  .partial()
  .strict();

const submitBody = z
  .object({
    // Below the 3% hard floor nothing is raised automatically: the submitter must ask for an exception, with a reason.
    requestException: z.boolean().default(false),
    reason: z.string().trim().min(5).max(2000).optional(),
  })
  .strict();

const decideParams = z.object({ id: uuid, stepId: uuid });
const decideBody = z
  .object({
    decision: z.enum(['Approved', 'Rejected']),
    comments: z.string().trim().max(4000).optional(),
  })
  .strict()
  .refine((b) => b.decision === 'Approved' || (b.comments && b.comments.length >= 3), {
    path: ['comments'],
    message: 'Say why you are rejecting this quotation.',
  });

const approvalsQuery = z.object({
  ...pageShape,
  mine: boolFlag.optional(),
  status: z.enum(['Pending', 'Approved', 'Rejected', 'Escalated', 'Withdrawn']).optional(),
});

const overrideBody = z
  .object({
    salesSharePct: z.number().min(0).max(100),
    technicalSharePct: z.number().min(0).max(100),
    companySharePct: z.number().min(0).max(100),
    reason: z.string().trim().min(5, 'Explain why this deal needs a different split.').max(4000),
  })
  .strict()
  .refine((b) => Math.abs(b.salesSharePct + b.technicalSharePct + b.companySharePct - 100) < 1e-6, {
    message: 'The sales, technical and company shares must add up to exactly 100.',
    path: ['companySharePct'],
  });

/* ───────────────────────── small helpers ───────────────────────── */

type Run = (text: string, params?: any[]) => Promise<Row[]>;
const runOn = (c: pg.PoolClient): Run => async (text, params = []) => (await c.query(text, params)).rows;

const camelKey = (k: string) => k.replace(/_([a-z0-9])/g, (_m, ch: string) => ch.toUpperCase());
/** Accepts snake_case or camelCase request bodies; the schemas are written in camelCase. */
function camelDeep(x: any): any {
  if (Array.isArray(x)) return x.map(camelDeep);
  if (x && typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype) {
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [camelKey(k), camelDeep(v)]));
  }
  return x;
}

function parse<S extends z.ZodTypeAny>(schema: S, data: unknown, camel = false): z.infer<S> {
  const r = schema.safeParse(camel ? camelDeep(data ?? {}) : (data ?? {}));
  if (!r.success) {
    throw badRequest(
      'validation_failed',
      'Check the highlighted fields',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

/** Turns database failures into messages a person can act on. */
function pgToApp(e: unknown): unknown {
  if (e instanceof AppError) return e;
  const err = e as { code?: string; message?: string } | null;
  switch (err?.code) {
    case '23503':
      return badRequest('invalid_reference', 'A linked record (tax code, SKU, service, manufacturer, supplier or enquiry line) does not exist. Refresh the form and pick it again.');
    case '23505':
      return conflict('duplicate', 'Another change took this number first. Reload and try again.');
    case '23514':
      return badRequest('constraint_failed', 'One of the values breaks a business rule. Check the amounts and try again.');
    case '22P02':
    case '22003':
    case '22007':
    case '22008':
      return badRequest('invalid_value', 'A date, number or ID in the request is malformed or out of range.');
    case 'P0001':
      if (/frozen/i.test(err.message ?? '')) return gateBlocked(`${err.message}.`);
      return e;
    default:
      return e;
  }
}
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) { throw pgToApp(e); }
}

const txCtx = (ctx: AuthCtx, scope: Scope) => ({
  userId: ctx.userId, employeeId: ctx.employeeId, sbuId: ctx.sbuIds[0] ?? null, scope,
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

/** A field group is visible if held outright, or held for own records and this record is the caller's. */
const canSee = (ctx: AuthCtx, group: FieldGroup, own: boolean) =>
  ctx.fields.has(group) || (own && ctx.fieldsOwnOnly.has(group));

/**
 * Scope for quotation queries (aliases: q = quotations, e = enquiries). A quotation has no SBU of its own,
 * so SBU/team scope follows the enquiry's primary SBU.
 */
function quoteScope(ctx: AuthCtx, scope: Scope, startIdx: number): { sql: string; params: any[] } {
  const own = scopeSql(ctx, scope, { alias: 'q', ownerCol: 'owner_id', entity: 'quotations' }, startIdx);
  if ((scope === 'S' || scope === 'T') && ctx.sbuIds.length) {
    const i = startIdx + own.params.length;
    return { sql: `(${own.sql} OR e.primary_sbu_id = ANY($${i}::uuid[]))`, params: [...own.params, ctx.sbuIds] };
  }
  return own;
}

/* ───────────────────────── output shaping ───────────────────────── */

const VERSION_COLS = `
  v.id, v.quotation_id, v.version_no, v.status::text AS status, v.quote_date::text AS quote_date,
  v.valid_until::text AS valid_until, v.currency, v.total_cost, v.other_project_cost, v.operation_charges,
  v.training_charges, v.total_sell, v.total_tax, v.gross_profit, v.gross_margin_pct, v.payment_terms,
  v.delivery_terms, v.scope, v.assumptions, v.exclusions, v.warranty, v.commercial_terms, v.requires_approval,
  v.approved_at, v.submitted_at, v.superseded_by, v.created_at, v.created_by`;

const LINE_COLS = `
  l.id, l.quotation_version_id, l.line_no, l.enquiry_line_id, l.supplier_quote_line_id, l.technical_estimate_id,
  l.product_sku_id, l.service_id, l.manufacturer_id, l.part_number, l.description, l.quantity, l.unit_cost,
  l.unit_price, l.discount_pct, l.tax_code_id, tc.code AS tax_code, tc.rate_pct AS tax_rate_pct, l.supplier_id,
  l.line_sell, l.line_cost, l.line_gp`;

function outVersion(ctx: AuthCtx, v: Row, own: boolean): Row {
  const m = mask(ctx, 'quotation_versions', v, own) as Row;
  // These three are supplier-cost components that FIELD_MAP does not name; hide them with the same rule.
  if (!canSee(ctx, 'supplier_cost', own)) for (const k of COST_ADDERS) delete m[k];
  return m;
}
function outLine(ctx: AuthCtx, l: Row, own: boolean): Row {
  const m = mask(ctx, 'quotation_lines', l, own) as Row;
  // Supplier identity leaks cost just as surely as the cost does.
  if (!canSee(ctx, 'supplier_cost', own)) { delete m.supplier_id; delete m.supplier_quote_line_id; }
  return m;
}

/* ───────────────────────── loading ───────────────────────── */

interface LoadedVersion extends Row {
  id: string; quotation_id: string; version_no: number; status: string; currency: string;
  owner_id: string; enquiry_id: string; business_type_id: string;
}

/** Loads a version inside the caller's scope (optionally locking it). 404 when out of scope — never reveals existence. */
async function loadVersion(run: Run, ctx: AuthCtx, scope: Scope, id: string, lock = false): Promise<LoadedVersion> {
  const sc = quoteScope(ctx, scope, 2);
  const rows = await run(
    `SELECT v.id, v.quotation_id, v.version_no, v.status::text AS status, v.currency, v.valid_until::text AS valid_until,
            q.quotation_no, q.owner_id, q.enquiry_id, q.customer_id, q.company_id, q.current_version,
            e.business_type_id, e.primary_sbu_id, e.stage::text AS enquiry_stage
       FROM gw.quotation_versions v
       JOIN gw.quotations q ON q.id = v.quotation_id
       JOIN gw.enquiries e ON e.id = q.enquiry_id
      WHERE v.id = $1 AND ${sc.sql} ${lock ? 'FOR UPDATE OF v' : ''}`,
    [id, ...sc.params]);
  if (!rows.length) throw notFound('Quotation version');
  return rows[0] as LoadedVersion;
}

const frozenMsg = (versionNo: number) => `Version ${versionNo} is frozen. Create the next version instead.`;
function assertDraft(v: Row) {
  if (v.status !== 'Draft') throw gateBlocked(frozenMsg(v.version_no));
}

async function fetchVersionOut(run: Run, ctx: AuthCtx, versionId: string, own: boolean): Promise<Row> {
  const rows = await run(`SELECT ${VERSION_COLS} FROM gw.quotation_versions v WHERE v.id = $1`, [versionId]);
  if (!rows.length) throw notFound('Quotation version');
  return outVersion(ctx, rows[0], own);
}

async function fetchLineOut(run: Run, ctx: AuthCtx, lineId: string, own: boolean): Promise<Row> {
  const rows = await run(
    `SELECT ${LINE_COLS} FROM gw.quotation_lines l LEFT JOIN gw.tax_codes tc ON tc.id = l.tax_code_id WHERE l.id = $1`, [lineId]);
  if (!rows.length) throw notFound('Quotation line');
  return outLine(ctx, rows[0], own);
}

async function approvalView(run: Run, id: string): Promise<Row> {
  const rows = await run(
    `SELECT a.id, a.entity_type, a.entity_id, a.trigger_code, a.status::text AS status, a.requested_by,
            ru.display_name AS requested_by_name, a.requested_at, a.completed_at
       FROM gw.approvals a JOIN gw.users ru ON ru.id = a.requested_by WHERE a.id = $1`, [id]);
  if (!rows.length) throw notFound('Approval');
  const a = rows[0];
  a.steps = await run(
    `SELECT s.id, s.step_no, s.approver_id, u.display_name AS approver_name, s.status::text AS status,
            s.acted_at, s.acted_by, s.comments, s.escalate_after_hours
       FROM gw.approval_steps s JOIN gw.users u ON u.id = s.approver_id
      WHERE s.approval_id = $1 ORDER BY s.step_no`, [id]);
  return a;
}

/** Full quotation: header, every version (immutable history) and each version's lines, masked per version. */
async function fetchQuotationDetail(run: Run, ctx: AuthCtx, quotationId: string, sc?: { sql: string; params: any[] }): Promise<Row> {
  const params: any[] = [quotationId, ...(sc?.params ?? [])];
  const head = (await run(
    `SELECT q.id, q.quotation_no, q.enquiry_id, e.enquiry_no, e.title AS enquiry_title, e.end_customer_name,
            q.customer_id, cu.name AS customer_name, q.owner_id, ow.full_name AS owner_name, q.company_id,
            q.current_version, q.created_at, e.business_type_id, bt.code AS business_type_code, bt.name AS business_type_name
       FROM gw.quotations q
       JOIN gw.enquiries e ON e.id = q.enquiry_id
       JOIN gw.customers cu ON cu.id = q.customer_id
       JOIN gw.employees ow ON ow.id = q.owner_id
       JOIN gw.business_types bt ON bt.id = e.business_type_id
      WHERE q.id = $1 AND ${sc?.sql ?? 'TRUE'}`, params))[0];
  if (!head) throw notFound('Quotation');
  const own = head.owner_id === ctx.employeeId;

  const versions = await run(
    `SELECT ${VERSION_COLS}, cb.display_name AS created_by_name
       FROM gw.quotation_versions v LEFT JOIN gw.users cb ON cb.id = v.created_by
      WHERE v.quotation_id = $1 ORDER BY v.version_no`, [quotationId]);
  const ids = versions.map((v) => v.id);
  const lines = ids.length
    ? await run(
        `SELECT ${LINE_COLS} FROM gw.quotation_lines l LEFT JOIN gw.tax_codes tc ON tc.id = l.tax_code_id
          WHERE l.quotation_version_id = ANY($1::uuid[]) ORDER BY l.quotation_version_id, l.line_no`, [ids])
    : [];
  const approvalIds = ids.length
    ? await run(`SELECT id FROM gw.approvals WHERE entity_type = 'quotation_versions' AND entity_id = ANY($1::uuid[]) ORDER BY requested_at`, [ids])
    : [];
  const approvals = await Promise.all(approvalIds.map((a) => approvalView(run, a.id)));

  head.versions = versions.map((v) => ({
    ...outVersion(ctx, v, own),
    lines: lines.filter((l) => l.quotation_version_id === v.id).map((l) => outLine(ctx, l, own)),
    approvals: approvals.filter((a) => a.entity_id === v.id),
  }));
  return head;
}

/* ───────────────────────── margin: computation and rules ───────────────────────── */

/**
 * Recomputes and STORES the version totals from its lines. All arithmetic is in SQL; the generated
 * columns on quotation_lines already give line_sell / line_cost / line_gp. Call after every line change.
 *   total_sell  = Σ line_sell
 *   total_cost  = Σ line_cost + other_project_cost + operation_charges + training_charges
 *   gross_profit = total_sell − total_cost;  gross_margin_pct = gross_profit / NULLIF(total_sell,0) × 100
 * total_tax (VAT on the discounted line values) is kept in step so the customer document always agrees.
 * Only Draft and PendingApproval rows can be recomputed: a frozen version is never touched.
 */
export async function computeMargin(client: pg.PoolClient, versionId: string): Promise<Row> {
  const cur = (await client.query(
    `SELECT status::text AS status, version_no FROM gw.quotation_versions WHERE id = $1 FOR UPDATE`, [versionId])).rows[0];
  if (!cur) throw notFound('Quotation version');
  if (cur.status !== 'Draft' && cur.status !== 'PendingApproval') throw gateBlocked(frozenMsg(cur.version_no));
  const r = await client.query(
    `WITH t AS (
       SELECT COALESCE(SUM(l.line_sell), 0) AS sell,
              COALESCE(SUM(l.line_cost), 0) AS cost,
              COALESCE(SUM(l.line_sell * COALESCE(tc.rate_pct, 0) / 100), 0) AS tax
         FROM gw.quotation_lines l LEFT JOIN gw.tax_codes tc ON tc.id = l.tax_code_id
        WHERE l.quotation_version_id = $1)
     UPDATE gw.quotation_versions v SET
        total_sell       = t.sell,
        total_cost       = t.cost + v.other_project_cost + v.operation_charges + v.training_charges,
        total_tax        = t.tax,
        gross_profit     = t.sell - (t.cost + v.other_project_cost + v.operation_charges + v.training_charges),
        gross_margin_pct = (t.sell - (t.cost + v.other_project_cost + v.operation_charges + v.training_charges))
                           / NULLIF(t.sell, 0) * 100
       FROM t WHERE v.id = $1
     RETURNING v.total_sell, v.total_cost, v.total_tax, v.gross_profit, v.gross_margin_pct`, [versionId]);
  return r.rows[0];
}

interface MarginRule {
  id: string; min_margin_pct: number | null; warn_margin_pct: number | null;
  sales_share_pct: number; technical_share_pct: number; company_share_pct: number;
}
async function marginRuleFor(run: Run, businessTypeId: string): Promise<MarginRule | null> {
  const rows = await run(
    `SELECT id, min_margin_pct, warn_margin_pct, sales_share_pct, technical_share_pct, company_share_pct
       FROM gw.margin_rules
      WHERE business_type_id = $1 AND effective_from <= ${TODAY} AND (effective_to IS NULL OR effective_to >= ${TODAY})
      ORDER BY effective_from DESC LIMIT 1`, [businessTypeId]);
  return (rows[0] as MarginRule | undefined) ?? null;
}

/* ───────────────────────── approvals: chain building ───────────────────────── */

async function roleIdByCode(run: Run, code: string): Promise<string | null> {
  return (await run(`SELECT id FROM gw.roles WHERE code = $1`, [code]))[0]?.id ?? null;
}

/**
 * Picks the user for a step. approval_steps.approver_id is a USER, while rules name ROLES, so each role is
 * resolved to one active holder (never the requester when someone else holds the role). A role nobody holds
 * falls back to SUPER_ADMIN so a chain is never left without an approver.
 */
async function approverForRole(run: Run, roleId: string, requesterId: string, taken: string[]): Promise<string | null> {
  const find = async (rid: string) => (await run(
    `SELECT u.id FROM gw.user_roles ur JOIN gw.users u ON u.id = ur.user_id
      WHERE ur.role_id = $1 AND u.is_active AND u.deleted_at IS NULL AND NOT (u.id = ANY($3::uuid[]))
      ORDER BY (u.id = $2) ASC, u.display_name LIMIT 1`, [rid, requesterId, taken]))[0]?.id as string | undefined;
  const direct = await find(roleId);
  if (direct) return direct;
  const sa = await roleIdByCode(run, 'SUPER_ADMIN');
  return sa ? ((await find(sa)) ?? null) : null;
}

/**
 * Creates the approval and its ordered steps from the matching gw.approval_rules row. If no rule is
 * configured for the trigger, the chain is a single DIRECTOR step (the fallback is stated, not silent).
 */
async function raiseApproval(c: pg.PoolClient, ctx: AuthCtx, o: {
  entityId: string; trigger: string; businessTypeId: string; marginPct: number | null; totalSell: number; reason?: string;
}): Promise<string> {
  const run = runOn(c);
  const rule = (await run(
    `SELECT approver_role_ids, escalate_after_hours FROM gw.approval_rules
      WHERE trigger_code = $1 AND is_active
        AND effective_from <= ${TODAY} AND (effective_to IS NULL OR effective_to >= ${TODAY})
        AND (business_type_id IS NULL OR business_type_id = $2)
        AND ($3::numeric IS NULL OR margin_below_pct IS NULL OR $3::numeric < margin_below_pct)
        AND (min_value IS NULL OR $4::numeric >= min_value)
        AND (max_value IS NULL OR $4::numeric <= max_value)
      ORDER BY (business_type_id IS NOT NULL) DESC, margin_below_pct ASC NULLS LAST, effective_from DESC
      LIMIT 1`, [o.trigger, o.businessTypeId, o.marginPct, o.totalSell]))[0];

  let roleIds: string[] = rule?.approver_role_ids ?? [];
  const escalateAfter: number = rule?.escalate_after_hours ?? 8;
  if (!roleIds.length) {
    const dir = await roleIdByCode(run, 'DIRECTOR');
    if (dir) roleIds = [dir];
  }

  const approvers: string[] = [];
  for (const roleId of roleIds) {
    const u = await approverForRole(run, roleId, ctx.userId, approvers);
    if (u) approvers.push(u);
  }
  if (!approvers.length) {
    throw gateBlocked('No approver is set up for this approval. Ask an administrator to add an approval rule or assign the Director role.');
  }

  const ap = (await run(
    `INSERT INTO gw.approvals (entity_type, entity_id, trigger_code, requested_by)
     VALUES ('quotation_versions', $1, $2, $3) RETURNING id`, [o.entityId, o.trigger, ctx.userId]))[0];
  for (let i = 0; i < approvers.length; i++) {
    await run(
      `INSERT INTO gw.approval_steps (approval_id, step_no, approver_id, escalate_after_hours) VALUES ($1,$2,$3,$4)`,
      [ap.id, i + 1, approvers[i], escalateAfter]);
  }
  await audit(c, ctx, {
    entityType: 'approvals', entityId: ap.id, action: 'create', field: 'trigger_code', newValue: o.trigger, reason: o.reason,
  });
  return ap.id as string;
}

/** Draft/PendingApproval → Approved → Submitted, superseding earlier submitted versions. The DB trigger writes sell_price_points. */
async function approveAndSubmit(c: pg.PoolClient, versionId: string): Promise<string[]> {
  const v = (await c.query(
    `UPDATE gw.quotation_versions SET status = 'Approved', approved_at = now() WHERE id = $1 RETURNING quotation_id, version_no`,
    [versionId])).rows[0];
  await c.query(`UPDATE gw.quotation_versions SET status = 'Submitted', submitted_at = now() WHERE id = $1`, [versionId]);
  const sup = await c.query(
    `UPDATE gw.quotation_versions SET status = 'Superseded', superseded_by = $1
      WHERE quotation_id = $2 AND version_no < $3 AND status IN ('Submitted', 'Approved') RETURNING id`,
    [versionId, v.quotation_id, v.version_no]);
  return sup.rows.map((r) => r.id as string);
}

/* ───────────────────────── lines: provenance and cost ───────────────────────── */

async function convertAmount(c: pg.PoolClient, amount: number, from: string, to: string): Promise<number> {
  if (from.trim() === to.trim()) return amount;
  const rate = (side: string) =>
    `(CASE WHEN ${side}::text = '${BASE_CCY}' THEN 1 ELSE
        (SELECT f.rate FROM gw.fx_rates f WHERE f.from_currency = ${side}::char(3) AND f.to_currency = '${BASE_CCY}'
          ORDER BY f.rate_date DESC LIMIT 1) END)`;
  const r = await c.query(`SELECT ($1::numeric * ${rate('$2')} / ${rate('$3')}) AS v`, [amount, from.trim(), to.trim()]);
  const v = r.rows[0]?.v;
  if (v === null || v === undefined) {
    throw gateBlocked(`No exchange rate from ${from.trim()} to ${to.trim()} is on file. Ask finance to add one, or quote in ${from.trim()}.`);
  }
  return v as number;
}

interface LineVals {
  enquiry_line_id: string | null; supplier_quote_line_id: string | null; technical_estimate_id: string | null;
  product_sku_id: string | null; service_id: string | null; manufacturer_id: string | null;
  part_number: string | null; description: string | null; quantity: number | null;
  unit_cost: number; unit_price: number | null; discount_pct: number;
  tax_code_id: string | null; supplier_id: string | null;
}
const LINE_VAL_COLS = [
  'enquiry_line_id', 'supplier_quote_line_id', 'technical_estimate_id', 'product_sku_id', 'service_id',
  'manufacturer_id', 'part_number', 'description', 'quantity', 'unit_cost', 'unit_price', 'discount_pct',
  'tax_code_id', 'supplier_id',
] as const;

/** A SALES user must not set cost at all. Checked on the parsed input before anything is written. */
function assertCostAllowed(ctx: AuthCtx, inputs: LineIn[]) {
  if (!ctx.fields.has('supplier_cost') && inputs.some((l) => l.unitCost !== undefined)) {
    throw forbidden('Supplier cost is set from the supplier quote, not entered here.');
  }
}

/**
 * Merges the client's input over the existing line (or defaults) and resolves provenance.
 * Cost is NEVER taken from the client when the line is linked to a supplier quote line or a technical estimate:
 * it is copied here, in the caller's transaction, converted to the quotation currency.
 */
async function resolveLine(
  c: pg.PoolClient, ctx: AuthCtx, ver: LoadedVersion, existing: Row | null, inp: LineIn,
): Promise<LineVals> {
  const v: Row = {};
  for (const col of LINE_VAL_COLS) v[col] = existing ? (existing[col] ?? null) : null;
  if (!existing) {
    v.unit_cost = 0; v.discount_pct = 0;
    v.tax_code_id = (await c.query(`SELECT id FROM gw.tax_codes WHERE code = 'VAT5' AND is_active`)).rows[0]?.id ?? null;
  }
  const set = (col: string, val: unknown) => { if (val !== undefined) v[col] = val; };
  set('description', inp.description); set('part_number', inp.partNumber); set('quantity', inp.quantity);
  set('unit_price', inp.unitPrice); set('discount_pct', inp.discountPct); set('tax_code_id', inp.taxCodeId);
  set('product_sku_id', inp.productSkuId); set('service_id', inp.serviceId); set('manufacturer_id', inp.manufacturerId);
  set('supplier_id', inp.supplierId); set('enquiry_line_id', inp.enquiryLineId);
  set('supplier_quote_line_id', inp.supplierQuoteLineId); set('technical_estimate_id', inp.technicalEstimateId);
  const fill = (col: string, val: unknown) => { if (v[col] === null || v[col] === undefined) v[col] = val ?? null; };

  let costFrom: 'supplier' | 'estimate' | null = null;
  if (inp.supplierQuoteLineId) {
    if (scopeFor(ctx, 'supplier_quotes.view') === null) throw forbidden('You cannot see supplier quotes, so you cannot link a line to one.');
    const sq = (await c.query(
      `SELECT sl.unit_cost, sl.part_number, sl.description, sl.product_sku_id, sl.quantity, sl.tax_code_id,
              sq.supplier_id, sq.currency, pr.enquiry_id, prl.enquiry_line_id, prl.manufacturer_id
         FROM gw.supplier_quote_lines sl
         JOIN gw.supplier_quotes sq ON sq.id = sl.supplier_quote_id
         JOIN gw.procurement_requests pr ON pr.id = sq.request_id
         LEFT JOIN gw.procurement_request_lines prl ON prl.id = sl.request_line_id
        WHERE sl.id = $1`, [inp.supplierQuoteLineId])).rows[0];
    if (!sq) throw badRequest('unknown_supplier_quote_line', 'That supplier quote line does not exist.');
    if (sq.enquiry_id !== ver.enquiry_id) {
      throw badRequest('wrong_enquiry', 'That supplier quote line belongs to a different enquiry. Pick a line from this enquiry\'s supplier quotes.');
    }
    v.unit_cost = await convertAmount(c, sq.unit_cost, sq.currency, ver.currency);
    v.supplier_id = sq.supplier_id;
    fill('part_number', sq.part_number); fill('description', sq.description); fill('product_sku_id', sq.product_sku_id);
    fill('quantity', sq.quantity); fill('tax_code_id', sq.tax_code_id);
    fill('enquiry_line_id', sq.enquiry_line_id); fill('manufacturer_id', sq.manufacturer_id);
    costFrom = 'supplier';
  }
  if (inp.technicalEstimateId) {
    if (scopeFor(ctx, 'technical_estimations.view') === null) throw forbidden('You cannot see technical estimates, so you cannot link a line to one.');
    const te = (await c.query(
      `SELECT te.estimated_service_cost, te.currency, te.proposed_solution, er.enquiry_id
         FROM gw.technical_estimates te JOIN gw.estimation_requests er ON er.id = te.estimation_request_id
        WHERE te.id = $1`, [inp.technicalEstimateId])).rows[0];
    if (!te) throw badRequest('unknown_estimate', 'That technical estimate does not exist.');
    if (te.enquiry_id !== ver.enquiry_id) {
      throw badRequest('wrong_enquiry', 'That technical estimate belongs to a different enquiry. Pick an estimate from this enquiry.');
    }
    fill('description', te.proposed_solution ? String(te.proposed_solution).slice(0, 500) : 'Professional services');
    fill('quantity', 1);
    if (!costFrom) {
      if (te.estimated_service_cost === null) {
        throw gateBlocked('That technical estimate has no service cost entered yet. Ask the estimator to complete it.');
      }
      const total = await convertAmount(c, te.estimated_service_cost, te.currency, ver.currency);
      v.unit_cost = v.quantity ? total / Number(v.quantity) : total;
      costFrom = 'estimate';
    }
  }

  if (inp.unitCost !== undefined) {
    if (costFrom || v.supplier_quote_line_id || v.technical_estimate_id) {
      throw badRequest('cost_is_derived',
        'The unit cost is copied from the linked supplier quote line or technical estimate and cannot be typed over. Unlink the line first if the cost is different.');
    }
    v.unit_cost = inp.unitCost;
  }

  if (!v.description) throw badRequest('description_required', 'Every line needs a description.');
  if (v.quantity === null || v.quantity === undefined) throw badRequest('quantity_required', 'Every line needs a quantity.');
  if (v.unit_price === null || v.unit_price === undefined) throw badRequest('price_required', 'Every line needs a unit price.');
  return v as LineVals;
}

async function insertLine(c: pg.PoolClient, ctx: AuthCtx, versionId: string, lineNo: number, v: LineVals): Promise<string> {
  const r = await c.query(
    `INSERT INTO gw.quotation_lines
       (quotation_version_id, line_no, enquiry_line_id, supplier_quote_line_id, technical_estimate_id, product_sku_id,
        service_id, manufacturer_id, part_number, description, quantity, unit_cost, unit_price, discount_pct,
        tax_code_id, supplier_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
    [versionId, lineNo, v.enquiry_line_id, v.supplier_quote_line_id, v.technical_estimate_id, v.product_sku_id,
     v.service_id, v.manufacturer_id, v.part_number, v.description, v.quantity, v.unit_cost, v.unit_price,
     v.discount_pct, v.tax_code_id, v.supplier_id]);
  void ctx; // field-level history for lines is written by the table trigger
  return r.rows[0].id as string;
}

async function updateLine(c: pg.PoolClient, lineId: string, v: LineVals) {
  await c.query(
    `UPDATE gw.quotation_lines SET enquiry_line_id=$2, supplier_quote_line_id=$3, technical_estimate_id=$4,
            product_sku_id=$5, service_id=$6, manufacturer_id=$7, part_number=$8, description=$9, quantity=$10,
            unit_cost=$11, unit_price=$12, discount_pct=$13, tax_code_id=$14, supplier_id=$15
      WHERE id = $1`,
    [lineId, v.enquiry_line_id, v.supplier_quote_line_id, v.technical_estimate_id, v.product_sku_id, v.service_id,
     v.manufacturer_id, v.part_number, v.description, v.quantity, v.unit_cost, v.unit_price, v.discount_pct,
     v.tax_code_id, v.supplier_id]);
}

async function nextLineNo(c: pg.PoolClient, versionId: string): Promise<number> {
  return Number((await c.query(
    `SELECT COALESCE(MAX(line_no), 0) + 1 AS n FROM gw.quotation_lines WHERE quotation_version_id = $1`, [versionId])).rows[0].n);
}

/** PATCH semantics for `lines`: items with an id are updated in place, items without are added, lines left out are removed. */
async function syncLines(c: pg.PoolClient, ctx: AuthCtx, ver: LoadedVersion, items: (LineIn & { id?: string })[]) {
  const existing = (await c.query(`SELECT * FROM gw.quotation_lines WHERE quotation_version_id = $1`, [ver.id])).rows;
  const byId = new Map(existing.map((l) => [l.id as string, l]));
  const keep = new Set<string>();
  for (const it of items) {
    if (!it.id) continue;
    if (!byId.has(it.id)) throw badRequest('unknown_line', 'One of the lines does not belong to this version. Reload the quotation and try again.');
    keep.add(it.id);
  }
  for (const l of existing) {
    if (keep.has(l.id)) continue;
    await c.query(`DELETE FROM gw.quotation_lines WHERE id = $1`, [l.id]);
    await audit(c, ctx, {
      entityType: 'quotation_lines', entityId: l.id, action: 'soft_delete',
      reason: `Line ${l.line_no} removed from draft version ${ver.version_no}`,
    });
  }
  for (const it of items) {
    const { id, ...inp } = it;
    if (id) {
      await updateLine(c, id, await resolveLine(c, ctx, ver, byId.get(id)!, inp));
    } else {
      await insertLine(c, ctx, ver.id, await nextLineNo(c, ver.id), await resolveLine(c, ctx, ver, null, inp));
    }
  }
}

/** Opening lines from what procurement and estimation already produced for the enquiry. */
async function seedLinesFromEnquiry(
  c: pg.PoolClient, ctx: AuthCtx, ver: LoadedVersion, warnPct: number,
): Promise<{ supplierQuoteLines: number; technicalEstimates: number; skipped: string[] }> {
  const out = { supplierQuoteLines: 0, technicalEstimates: 0, skipped: [] as string[] };
  // Default price lands exactly on the warn threshold so a seeded line never trips the approval chain by itself.
  const priceFor = (cost: number) => Math.round((cost / (1 - warnPct / 100)) * 100) / 100;

  if (scopeFor(ctx, 'supplier_quotes.view') !== null) {
    const rows = (await c.query(
      `SELECT sl.id FROM gw.supplier_quote_lines sl
         JOIN gw.supplier_quotes sq ON sq.id = sl.supplier_quote_id
         JOIN gw.procurement_requests pr ON pr.id = sq.request_id
        WHERE pr.enquiry_id = $1 AND sq.is_recommended
        ORDER BY sq.recorded_at, sl.id`, [ver.enquiry_id])).rows;
    for (const r of rows) {
      const v = await resolveLine(c, ctx, ver, null, { supplierQuoteLineId: r.id, unitPrice: 0 });
      v.unit_price = priceFor(v.unit_cost);
      await insertLine(c, ctx, ver.id, await nextLineNo(c, ver.id), v);
      out.supplierQuoteLines++;
    }
  } else out.skipped.push('supplier quote lines (you cannot view supplier quotes)');

  if (scopeFor(ctx, 'technical_estimations.view') !== null) {
    const rows = (await c.query(
      `SELECT te.id FROM gw.technical_estimates te
         JOIN gw.estimation_requests er ON er.id = te.estimation_request_id
        WHERE er.enquiry_id = $1 AND te.superseded_by IS NULL AND te.estimated_service_cost IS NOT NULL
        ORDER BY te.submitted_at, te.id`, [ver.enquiry_id])).rows;
    for (const r of rows) {
      const v = await resolveLine(c, ctx, ver, null, { technicalEstimateId: r.id, unitPrice: 0 });
      v.unit_price = priceFor(v.unit_cost);
      await insertLine(c, ctx, ver.id, await nextLineNo(c, ver.id), v);
      out.technicalEstimates++;
    }
  } else out.skipped.push('technical estimates (you cannot view estimations)');
  return out;
}

/* ───────────────────────── routes ───────────────────────── */

export async function quotationRoutes(app: FastifyInstance) {
  /* ═════════════ Quotations ═════════════ */

  app.get('/api/v1/quotations', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'quotations.view');
    const qs = parse(listQuery, req.query);
    const sc = quoteScope(ctx, scope, 1);
    const params: any[] = [...sc.params];
    const p = (v: any) => { params.push(v); return `$${params.length}`; };
    const w: string[] = [sc.sql];
    if (qs.status) w.push(`v.status::text = ${p(qs.status)}`);
    if (qs.customerId) w.push(`q.customer_id = ${p(qs.customerId)}`);
    if (qs.ownerId) w.push(`q.owner_id = ${p(qs.ownerId)}`);
    if (qs.q) {
      const t = p(likeTerm(qs.q));
      w.push(`(q.quotation_no ILIKE ${t} OR e.enquiry_no ILIKE ${t} OR cu.name ILIKE ${t})`);
    }
    const cur = decodeCursor(qs.cursor);
    if (cur) {
      params.push(String(cur.t), String(cur.id));
      w.push(`(q.created_at, q.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(qs.limit + 1);
    const rows = await guard(() => q(
      `SELECT q.id, q.quotation_no, q.customer_id, cu.name AS customer_name, q.enquiry_id, e.enquiry_no,
              q.owner_id, ow.full_name AS owner_name, q.current_version, q.created_at,
              v.id AS version_id, v.version_no, v.status::text AS status, v.currency, v.total_sell,
              v.gross_margin_pct, v.valid_until::text AS valid_until, ls.last_submitted_at AS submitted_at,
              CASE WHEN ls.last_submitted_at IS NOT NULL
                   THEN floor(extract(epoch FROM (now() - ls.last_submitted_at)) / 86400)::int END AS days_since_submission,
              q.created_at::text AS _ts
         FROM gw.quotations q
         JOIN gw.enquiries e ON e.id = q.enquiry_id
         JOIN gw.customers cu ON cu.id = q.customer_id
         JOIN gw.employees ow ON ow.id = q.owner_id
         LEFT JOIN gw.quotation_versions v ON v.quotation_id = q.id AND v.version_no = q.current_version
         LEFT JOIN LATERAL (SELECT max(sv.submitted_at) AS last_submitted_at
                              FROM gw.quotation_versions sv WHERE sv.quotation_id = q.id) ls ON true
        WHERE ${w.join(' AND ')}
        ORDER BY q.created_at DESC, q.id DESC
        LIMIT $${params.length}`, params));
    const more = rows.length > qs.limit;
    const page = more ? rows.slice(0, qs.limit) : rows;
    const last = page[page.length - 1];
    const nextCursor = more && last ? encodeCursor({ t: last._ts, id: last.id }) : null;
    return {
      data: page.map((r) => {
        const { _ts, ...rest } = r; void _ts;
        return mask(ctx, 'quotation_versions', rest, r.owner_id === ctx.employeeId);
      }),
      nextCursor,
    };
  });

  app.get('/api/v1/quotations/:id', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'quotations.view');
    const { id } = parse(idParam, req.params);
    const sc = quoteScope(ctx, scope, 2);
    return { data: await fetchQuotationDetail(q, ctx, id, sc) };
  });

  app.post('/api/v1/quotations', async (req, reply) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'quotations.create');
    const b = parse(createQuotationBody, req.body, true);
    assertCostAllowed(ctx, b.lines ?? []);

    const result = await guard(() => tx(txCtx(ctx, scope), async (c) => {
      const run = runOn(c);
      const sc = scopeSql(ctx, scope, { alias: 'e', ownerCol: 'account_manager_id', sbuCol: 'primary_sbu_id', entity: 'enquiries' }, 2);
      const enq = (await run(
        `SELECT e.id, e.company_id, e.customer_id, e.account_manager_id, e.business_type_id, e.stage::text AS stage,
                cu.default_currency, cu.payment_terms_days
           FROM gw.enquiries e JOIN gw.customers cu ON cu.id = e.customer_id
          WHERE e.id = $1 AND e.deleted_at IS NULL AND ${sc.sql} FOR UPDATE OF e`, [b.enquiryId, ...sc.params]))[0];
      if (!enq) throw notFound('Enquiry');
      if (['Lost', 'Cancelled', 'Dropped'].includes(enq.stage)) {
        throw gateBlocked(`This enquiry is ${enq.stage}. Reopen it before quoting.`);
      }

      const quotationNo = await nextNumber(c, 'quotation', enq.company_id, 'QT');
      const qt = (await run(
        `INSERT INTO gw.quotations (quotation_no, enquiry_id, company_id, customer_id, owner_id, current_version)
         VALUES ($1,$2,$3,$4,$5,1) RETURNING id`,
        [quotationNo, enq.id, enq.company_id, enq.customer_id, enq.account_manager_id]))[0];
      await audit(c, ctx, { entityType: 'quotations', entityId: qt.id, action: 'create', newValue: quotationNo });

      const ver = (await run(
        `INSERT INTO gw.quotation_versions
           (quotation_id, version_no, status, currency, valid_until, other_project_cost, operation_charges, training_charges,
            payment_terms, delivery_terms, scope, assumptions, exclusions, warranty, commercial_terms, created_by)
         VALUES ($1, 1, 'Draft', COALESCE($2, $3), COALESCE($4::date, ${TODAY} + ${DEFAULT_VALIDITY_DAYS}),
                 COALESCE($5,0), COALESCE($6,0), COALESCE($7,0), COALESCE($8, $9), $10, $11, $12, $13, $14, $15, $16)
         RETURNING id`,
        [qt.id, b.currency ?? null, enq.default_currency ?? BASE_CCY, b.validUntil ?? null,
         b.otherProjectCost ?? null, b.operationCharges ?? null, b.trainingCharges ?? null,
         b.paymentTerms ?? null, enq.payment_terms_days != null ? `Net ${enq.payment_terms_days} days from invoice date` : null,
         b.deliveryTerms ?? null, b.scope ?? null, b.assumptions ?? null, b.exclusions ?? null, b.warranty ?? null,
         b.commercialTerms ?? null, ctx.userId]))[0];

      const loaded = await loadVersion(run, ctx, 'A', ver.id); // already authorised through the enquiry scope check above
      const rule = await marginRuleFor(run, enq.business_type_id);
      let seeded: Row | null = null;
      if (b.lines?.length) {
        for (const l of b.lines) await insertLine(c, ctx, ver.id, await nextLineNo(c, ver.id), await resolveLine(c, ctx, loaded, null, l));
      } else if (b.seedFromEnquiry) {
        seeded = await seedLinesFromEnquiry(c, ctx, loaded, rule?.warn_margin_pct ?? rule?.min_margin_pct ?? 0);
      }
      await computeMargin(c, ver.id);
      return { id: qt.id as string, seeded };
    }));

    reply.code(201);
    const data = await fetchQuotationDetail(q, ctx, result.id);
    return { data, seeded: result.seeded };
  });

  app.post('/api/v1/quotations/:id/versions', async (req, reply) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'quotations.edit');
    const { id } = parse(idParam, req.params);
    const b = parse(createVersionBody, req.body, true);
    assertCostAllowed(ctx, b.lines ?? []);

    await guard(() => tx(txCtx(ctx, scope), async (c) => {
      const run = runOn(c);
      const sc = quoteScope(ctx, scope, 2);
      const head = (await run(
        `SELECT q.id, q.owner_id, q.enquiry_id, q.current_version FROM gw.quotations q
           JOIN gw.enquiries e ON e.id = q.enquiry_id WHERE q.id = $1 AND ${sc.sql} FOR UPDATE OF q`,
        [id, ...sc.params]))[0];
      if (!head) throw notFound('Quotation');

      const prev = (await run(
        `SELECT *, valid_until::text AS valid_until_txt FROM gw.quotation_versions WHERE quotation_id = $1 ORDER BY version_no DESC LIMIT 1`, [id]))[0];
      if (prev.status === 'Draft') {
        throw gateBlocked(`Version ${prev.version_no} is still a draft. Edit it or submit it before starting version ${prev.version_no + 1}.`);
      }
      const pick = <T>(k: keyof typeof b, old: T) => (b[k] !== undefined ? (b[k] as unknown as T) : old);
      const nv = (await run(
        `INSERT INTO gw.quotation_versions
           (quotation_id, version_no, status, currency, valid_until, other_project_cost, operation_charges, training_charges,
            payment_terms, delivery_terms, scope, assumptions, exclusions, warranty, commercial_terms, created_by)
         VALUES ($1,$2,'Draft',$3,
                 CASE WHEN $4::date IS NOT NULL AND $4::date >= ${TODAY} THEN $4::date ELSE ${TODAY} + ${DEFAULT_VALIDITY_DAYS} END,
                 $5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id, version_no`,
        [id, prev.version_no + 1, pick('currency', prev.currency), pick('validUntil', prev.valid_until_txt),
         pick('otherProjectCost', prev.other_project_cost), pick('operationCharges', prev.operation_charges),
         pick('trainingCharges', prev.training_charges), pick('paymentTerms', prev.payment_terms),
         pick('deliveryTerms', prev.delivery_terms), pick('scope', prev.scope), pick('assumptions', prev.assumptions),
         pick('exclusions', prev.exclusions), pick('warranty', prev.warranty), pick('commercialTerms', prev.commercial_terms),
         ctx.userId]))[0];

      if (b.lines) {
        const loaded = await loadVersion(run, ctx, 'A', nv.id);
        for (const l of b.lines) await insertLine(c, ctx, nv.id, await nextLineNo(c, nv.id), await resolveLine(c, ctx, loaded, null, l));
      } else {
        // Server-side copy: costs come from the previous version's own rows, never from the client.
        await run(
          `INSERT INTO gw.quotation_lines
             (quotation_version_id, line_no, enquiry_line_id, supplier_quote_line_id, technical_estimate_id, product_sku_id,
              service_id, manufacturer_id, part_number, description, quantity, unit_cost, unit_price, discount_pct,
              tax_code_id, supplier_id)
           SELECT $1, line_no, enquiry_line_id, supplier_quote_line_id, technical_estimate_id, product_sku_id,
                  service_id, manufacturer_id, part_number, description, quantity, unit_cost, unit_price, discount_pct,
                  tax_code_id, supplier_id
             FROM gw.quotation_lines WHERE quotation_version_id = $2 ORDER BY line_no`, [nv.id, prev.id]);
      }
      await computeMargin(c, nv.id);
      // superseded_by on the previous version is set only when this one is submitted, not now.
      await run(`UPDATE gw.quotations SET current_version = $2 WHERE id = $1`, [id, nv.version_no]);
      await audit(c, ctx, {
        entityType: 'quotations', entityId: id, action: 'update', field: 'current_version',
        oldValue: prev.version_no, newValue: nv.version_no,
      });
    }));

    reply.code(201);
    return { data: await fetchQuotationDetail(q, ctx, id) };
  });

  /* ═════════════ Draft versions and lines ═════════════ */

  app.patch('/api/v1/quotation-versions/:id', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'quotations.edit');
    const { id } = parse(idParam, req.params);
    const b = parse(patchVersionBody, req.body, true);
    assertCostAllowed(ctx, b.lines ?? []);
    const { lines, ...scalars } = b;
    const cols: Record<string, string> = {
      validUntil: 'valid_until', currency: 'currency', paymentTerms: 'payment_terms', deliveryTerms: 'delivery_terms',
      scope: 'scope', assumptions: 'assumptions', exclusions: 'exclusions', warranty: 'warranty',
      commercialTerms: 'commercial_terms', otherProjectCost: 'other_project_cost',
      operationCharges: 'operation_charges', trainingCharges: 'training_charges',
    };
    const keys = (Object.keys(scalars) as (keyof typeof scalars)[]).filter((k) => scalars[k] !== undefined);
    if (!keys.length && lines === undefined) throw badRequest('nothing_to_update', 'Send at least one field to change.');

    const out = await guard(() => tx(txCtx(ctx, scope), async (c) => {
      const run = runOn(c);
      const ver = await loadVersion(run, ctx, scope, id, true);
      assertDraft(ver);
      if (keys.length) {
        const sets = keys.map((k, i) => `${cols[k]} = $${i + 2}`);
        await c.query(`UPDATE gw.quotation_versions SET ${sets.join(', ')} WHERE id = $1`, [id, ...keys.map((k) => scalars[k])]);
      }
      if (lines !== undefined) await syncLines(c, ctx, ver, lines);
      await computeMargin(c, id);
      const own = ver.owner_id === ctx.employeeId;
      const version = await fetchVersionOut(run, ctx, id, own);
      const lineRows = await run(
        `SELECT ${LINE_COLS} FROM gw.quotation_lines l LEFT JOIN gw.tax_codes tc ON tc.id = l.tax_code_id
          WHERE l.quotation_version_id = $1 ORDER BY l.line_no`, [id]);
      return { ...version, lines: lineRows.map((l) => outLine(ctx, l, own)) };
    }));
    return { data: out };
  });

  app.post('/api/v1/quotation-versions/:id/lines', async (req, reply) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'quotations.edit');
    const { id } = parse(idParam, req.params);
    const b = parse(linePatchSchema, req.body, true);
    assertCostAllowed(ctx, [b]);

    const out = await guard(() => tx(txCtx(ctx, scope), async (c) => {
      const run = runOn(c);
      const ver = await loadVersion(run, ctx, scope, id, true);
      assertDraft(ver);
      const lineId = await insertLine(c, ctx, id, await nextLineNo(c, id), await resolveLine(c, ctx, ver, null, b));
      await computeMargin(c, id);
      const own = ver.owner_id === ctx.employeeId;
      return { line: await fetchLineOut(run, ctx, lineId, own), version: await fetchVersionOut(run, ctx, id, own) };
    }));
    reply.code(201);
    return { data: out };
  });

  app.patch('/api/v1/quotation-lines/:id', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'quotations.edit');
    const { id } = parse(idParam, req.params);
    const b = parse(linePatchSchema, req.body, true);
    if (!Object.values(b).some((v) => v !== undefined)) throw badRequest('nothing_to_update', 'Send at least one field to change.');
    assertCostAllowed(ctx, [b]);

    const out = await guard(() => tx(txCtx(ctx, scope), async (c) => {
      const run = runOn(c);
      const line = (await run(`SELECT * FROM gw.quotation_lines WHERE id = $1`, [id]))[0];
      if (!line) throw notFound('Quotation line');
      const ver = await loadVersion(run, ctx, scope, line.quotation_version_id, true);
      assertDraft(ver);
      await updateLine(c, id, await resolveLine(c, ctx, ver, line, b));
      await computeMargin(c, ver.id);
      const own = ver.owner_id === ctx.employeeId;
      return { line: await fetchLineOut(run, ctx, id, own), version: await fetchVersionOut(run, ctx, ver.id, own) };
    }));
    return { data: out };
  });

  app.delete('/api/v1/quotation-lines/:id', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'quotations.edit');
    const { id } = parse(idParam, req.params);

    const out = await guard(() => tx(txCtx(ctx, scope), async (c) => {
      const run = runOn(c);
      const line = (await run(`SELECT id, line_no, quotation_version_id FROM gw.quotation_lines WHERE id = $1`, [id]))[0];
      if (!line) throw notFound('Quotation line');
      const ver = await loadVersion(run, ctx, scope, line.quotation_version_id, true);
      assertDraft(ver);
      await c.query(`DELETE FROM gw.quotation_lines WHERE id = $1`, [id]);
      await audit(c, ctx, {
        entityType: 'quotation_lines', entityId: id, action: 'soft_delete',
        reason: `Line ${line.line_no} removed from draft version ${ver.version_no}`,
      });
      await computeMargin(c, ver.id);
      return { deleted: true, version: await fetchVersionOut(run, ctx, ver.id, ver.owner_id === ctx.employeeId) };
    }));
    return { data: out };
  });

  /* ═════════════ Margin: breakdown and attribution ═════════════ */

  app.get('/api/v1/quotation-versions/:id/margin', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'quotations.view');
    const { id } = parse(idParam, req.params);
    const ver = await loadVersion(q, ctx, scope, id);
    const own = ver.owner_id === ctx.employeeId;
    if (!canSee(ctx, 'margin', own)) {
      throw forbidden('Margin is restricted. Ask a director to grant you margin access if you need it.');
    }

    const rule = await marginRuleFor(q, ver.business_type_id);
    if (!rule) throw gateBlocked('No margin rule is set up for this enquiry\'s business type. Ask an administrator to add one.');

    // Live figures straight from the lines, so the breakdown can never disagree with them.
    const totals = (await q1(
      `WITH t AS (SELECT COALESCE(SUM(line_sell),0) AS sell, COALESCE(SUM(line_cost),0) AS lines_cost
                    FROM gw.quotation_lines WHERE quotation_version_id = $1)
       SELECT t.sell AS total_sell, t.lines_cost AS lines_cost, v.other_project_cost, v.operation_charges, v.training_charges,
              t.lines_cost + v.other_project_cost + v.operation_charges + v.training_charges AS total_cost,
              t.sell - (t.lines_cost + v.other_project_cost + v.operation_charges + v.training_charges) AS gross_profit,
              ROUND((t.sell - (t.lines_cost + v.other_project_cost + v.operation_charges + v.training_charges))
                / NULLIF(t.sell, 0) * 100, 4) AS gross_margin_pct
         FROM gw.quotation_versions v, t WHERE v.id = $1`, [id]))!;
    const lines = await q(
      `SELECT l.id, l.line_no, l.description, l.part_number, l.quantity, l.unit_cost, l.unit_price, l.discount_pct,
              l.line_sell, l.line_cost, l.line_gp,
              CASE WHEN l.line_sell <> 0 THEN l.line_gp / l.line_sell * 100 END AS margin_pct
         FROM gw.quotation_lines l WHERE l.quotation_version_id = $1 ORDER BY l.line_no`, [id]);

    const ov = await q1(
      `SELECT o.id, o.sales_share_pct, o.technical_share_pct, o.company_share_pct, o.reason, o.approval_id,
              o.created_at, a.status::text AS approval_status
         FROM gw.margin_overrides o LEFT JOIN gw.approvals a ON a.id = o.approval_id
        WHERE o.quotation_version_id = $1`, [id]);
    // An exception only takes effect once its approval is Approved; until then the rule governs.
    const overrideApplies = !!ov && ov.approval_status === 'Approved';
    const shares = overrideApplies
      ? { s: ov!.sales_share_pct, t: ov!.technical_share_pct, c: ov!.company_share_pct }
      : { s: rule.sales_share_pct, t: rule.technical_share_pct, c: rule.company_share_pct };

    // Company takes the rounding remainder so the three parts always add back to gross profit.
    const attr = (await q1(
      `SELECT ROUND($1::numeric * $2::numeric / 100, 2) AS sales,
              ROUND($1::numeric * $3::numeric / 100, 2) AS technical,
              $1::numeric - ROUND($1::numeric * $2::numeric / 100, 2) - ROUND($1::numeric * $3::numeric / 100, 2) AS company`,
      [totals.gross_profit, shares.s, shares.t]))!;

    const maskedTotals = mask(ctx, 'quotation_versions', totals, own) as Row;
    if (!canSee(ctx, 'supplier_cost', own)) { for (const k of COST_ADDERS) delete maskedTotals[k]; delete maskedTotals.lines_cost; }

    return {
      data: camelDeep({
        version_id: id, version_no: ver.version_no, currency: ver.currency,
        totals: maskedTotals,
        lines: lines.map((l) => {
          const m = mask(ctx, 'quotation_lines', l, own) as Row;
          if (!canSee(ctx, 'sell_price', own)) delete m.margin_pct; // percentage + cost would reveal the price
          return m;
        }),
        rule: {
          sales_share_pct: rule.sales_share_pct, technical_share_pct: rule.technical_share_pct,
          company_share_pct: rule.company_share_pct, min_margin_pct: rule.min_margin_pct ?? config.marginFloorPct,
          warn_margin_pct: rule.warn_margin_pct,
        },
        ...(ov ? {
          override: {
            id: ov.id, sales_share_pct: ov.sales_share_pct, technical_share_pct: ov.technical_share_pct,
            company_share_pct: ov.company_share_pct, reason: ov.reason, approval_id: ov.approval_id,
            approval_status: ov.approval_status, applied: overrideApplies, created_at: ov.created_at,
          },
        } : {}),
        attribution: { sales: attr.sales, technical: attr.technical, company: attr.company },
        attribution_source: overrideApplies ? 'override' : 'rule',
      }),
    };
  });

  app.post('/api/v1/quotation-versions/:id/margin-override', async (req, reply) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'quotations.edit');
    const { id } = parse(idParam, req.params);
    const b = parse(overrideBody, req.body, true);

    const out = await guard(() => tx(txCtx(ctx, scope), async (c) => {
      const run = runOn(c);
      const ver = await loadVersion(run, ctx, scope, id, true);
      if (ver.status === 'Superseded' || ver.status === 'Rejected') {
        throw gateBlocked(`Version ${ver.version_no} is ${ver.status}. Put the exception on the live version instead.`);
      }
      const existing = (await run(
        `SELECT o.id, a.status::text AS approval_status FROM gw.margin_overrides o
           LEFT JOIN gw.approvals a ON a.id = o.approval_id WHERE o.quotation_version_id = $1 FOR UPDATE OF o`, [id]))[0];
      if (existing && existing.approval_status !== 'Rejected') {
        throw conflict('override_exists', 'This version already has a margin exception on file. Wait for its approval, or ask the approver to decide it.');
      }
      const tot = (await run(`SELECT total_sell, gross_margin_pct FROM gw.quotation_versions WHERE id = $1`, [id]))[0];
      const approvalId = await raiseApproval(c, ctx, {
        entityId: id, trigger: TRIGGER_MARGIN_OVERRIDE, businessTypeId: ver.business_type_id,
        marginPct: null, totalSell: tot.total_sell, reason: b.reason,
      });
      let overrideId: string;
      if (existing) {
        // A previously rejected exception is replaced by the new request; the history lives in audit_log.
        await run(
          `UPDATE gw.margin_overrides SET sales_share_pct=$2, technical_share_pct=$3, company_share_pct=$4,
                  reason=$5, approval_id=$6, created_by=$7, created_at=now() WHERE id=$1`,
          [existing.id, b.salesSharePct, b.technicalSharePct, b.companySharePct, b.reason, approvalId, ctx.userId]);
        overrideId = existing.id;
      } else {
        overrideId = (await run(
          `INSERT INTO gw.margin_overrides
             (quotation_version_id, business_type_id, sales_share_pct, technical_share_pct, company_share_pct, reason, approval_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [id, ver.business_type_id, b.salesSharePct, b.technicalSharePct, b.companySharePct, b.reason, approvalId, ctx.userId]))[0].id;
      }
      await audit(c, ctx, {
        entityType: 'margin_overrides', entityId: overrideId, action: 'override',
        field: 'margin_split', newValue: `${b.salesSharePct}/${b.technicalSharePct}/${b.companySharePct}`, reason: b.reason,
      });
      return {
        override: {
          id: overrideId, quotation_version_id: id, sales_share_pct: b.salesSharePct, technical_share_pct: b.technicalSharePct,
          company_share_pct: b.companySharePct, reason: b.reason, approval_id: approvalId,
        },
        approval: await approvalView(run, approvalId),
      };
    }));
    reply.code(201);
    return { data: out };
  });

  /* ═════════════ The margin gate ═════════════ */

  app.post('/api/v1/quotation-versions/:id/submit', async (req, reply) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'quotations.edit');
    const { id } = parse(idParam, req.params);
    const b = parse(submitBody, req.body ?? {}, true);

    const out = await guard(() => tx(txCtx(ctx, scope), async (c) => {
      const run = runOn(c);
      const ver = await loadVersion(run, ctx, scope, id, true);
      if (ver.status === 'PendingApproval') throw gateBlocked(`Version ${ver.version_no} is already waiting for approval.`);
      assertDraft(ver);
      const own = ver.owner_id === ctx.employeeId;

      const nLines = Number((await run(`SELECT count(*) AS n FROM gw.quotation_lines WHERE quotation_version_id = $1`, [id]))[0].n);
      if (!nLines) throw gateBlocked('Add at least one line before submitting this quotation.');

      // 1. Recompute: the stored totals are what the gate judges, and they come from the lines.
      const t = await computeMargin(c, id);
      if (t.gross_margin_pct === null) throw gateBlocked('This quotation totals zero, so no margin can be calculated. Price the lines before submitting.');
      const pct = Number(t.gross_margin_pct);

      // 2. The rule for this business type. min is the hard floor (OD-09), warn is what fires the chain.
      const rule = await marginRuleFor(run, ver.business_type_id);
      const floor = rule?.min_margin_pct ?? config.marginFloorPct;
      const warn = Math.max(rule?.warn_margin_pct ?? floor, floor);
      const approved = (await run(
        `SELECT id FROM gw.approvals WHERE entity_type = 'quotation_versions' AND entity_id = $1
            AND trigger_code = $2 AND status = 'Approved' LIMIT 1`, [id, TRIGGER_LOW_MARGIN]))[0];

      const raise = async (reason: string) => {
        const approvalId = await raiseApproval(c, ctx, {
          entityId: id, trigger: TRIGGER_LOW_MARGIN, businessTypeId: ver.business_type_id,
          marginPct: pct, totalSell: t.total_sell, reason,
        });
        await run(`UPDATE gw.quotation_versions SET status = 'PendingApproval', requires_approval = true WHERE id = $1`, [id]);
        return {
          status: 202 as const,
          body: {
            message: `Gross margin is ${pct.toFixed(2)}%, below the ${warn}% approval threshold. Version ${ver.version_no} has gone for approval and has NOT been submitted.`,
            approval: await approvalView(run, approvalId),
            version: await fetchVersionOut(run, ctx, id, own),
          },
        };
      };

      if (pct < floor && !approved) {
        // 2. Hard floor: refused outright unless an approval for this version already exists and is Approved.
        if (!b.requestException) {
          const pending = (await run(
            `SELECT 1 FROM gw.approvals WHERE entity_type='quotation_versions' AND entity_id=$1 AND trigger_code=$2 AND status='Pending'`,
            [id, TRIGGER_LOW_MARGIN])).length > 0;
          throw gateBlocked(
            `Gross margin is ${pct.toFixed(2)}%, below the ${floor}% hard floor, so this quotation cannot be submitted. ` +
            (pending ? 'An approval is already pending; wait for the approver. '
                     : 'Raise the prices, or resubmit with requestException and a reason to ask a director for an exception.'),
            { grossMarginPct: pct, minMarginPct: floor });
        }
        if (!b.reason) throw badRequest('reason_required', 'Say why this quotation needs to go out below the margin floor.');
        return raise(b.reason);
      }
      // 3. Between the floor and the warn threshold: an approval chain, not a submission.
      if (pct < warn && !approved) return raise(b.reason ?? `Gross margin ${pct.toFixed(2)}% is below the ${warn}% threshold`);

      // 4. Clear: Approved, then Submitted; earlier submitted versions become Superseded.
      const superseded = await approveAndSubmit(c, id);
      return {
        status: 200 as const,
        body: { version: await fetchVersionOut(run, ctx, id, own), supersededVersionIds: superseded },
      };
    }));
    reply.code(out.status);
    return { data: out.body };
  });

  /* ═════════════ Approvals ═════════════ */

  app.get('/api/v1/approvals', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'quotations.approve');
    const qs = parse(approvalsQuery, req.query);
    const params: any[] = [ctx.userId];
    const p = (v: any) => { params.push(v); return `$${params.length}`; };
    const w: string[] = [`a.entity_type = 'quotation_versions'`];
    if (qs.mine) {
      // Awaiting the caller: the lowest still-pending step of a pending approval is theirs.
      w.push(`a.status = 'Pending'`, `s.approver_id = $1`);
    } else {
      if (qs.status) w.push(`a.status::text = ${p(qs.status)}`);
      if (scope !== 'A' && scope !== 'D') {
        w.push(`(a.requested_by = $1 OR EXISTS (SELECT 1 FROM gw.approval_steps m WHERE m.approval_id = a.id AND m.approver_id = $1))`);
      }
    }
    const cur = decodeCursor(qs.cursor);
    if (cur) {
      params.push(String(cur.t), String(cur.id));
      w.push(`(a.requested_at, a.id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(qs.limit + 1);
    const rows = await q(
      `SELECT a.id, a.trigger_code, a.status::text AS status, a.requested_by, ru.display_name AS requested_by_name,
              (a.requested_by = $1::uuid) AS raised_by_me, a.requested_at, a.entity_id AS version_id,
              s.id AS step_id, s.step_no, s.approver_id, s.escalate_after_hours,
              COALESCE((SELECT max(pv.acted_at) FROM gw.approval_steps pv WHERE pv.approval_id = a.id AND pv.step_no < s.step_no),
                       a.requested_at) AS waiting_since,
              v.version_no, v.status::text AS version_status, v.currency, v.total_sell, v.gross_margin_pct,
              q.id AS quotation_id, q.quotation_no, q.owner_id, cu.name AS customer_name,
              a.requested_at::text AS _ts
         FROM gw.approvals a
         JOIN gw.users ru ON ru.id = a.requested_by
         LEFT JOIN LATERAL (
              SELECT st.* FROM gw.approval_steps st WHERE st.approval_id = a.id
               ORDER BY (st.status = 'Pending') DESC, st.step_no LIMIT 1) s ON true
         LEFT JOIN gw.quotation_versions v ON v.id = a.entity_id
         LEFT JOIN gw.quotations q ON q.id = v.quotation_id
         LEFT JOIN gw.customers cu ON cu.id = q.customer_id
        WHERE ${w.join(' AND ')}
        ORDER BY a.requested_at ASC, a.id ASC
        LIMIT $${params.length}`, params);
    const more = rows.length > qs.limit;
    const page = more ? rows.slice(0, qs.limit) : rows;
    const now = new Date();
    const data = await Promise.all(page.map(async (r) => {
      const { _ts, owner_id, ...rest } = r; void _ts;
      const pending = r.status === 'Pending';
      // Working hours on the Dubai calendar (OD-18): an approval raised Thursday evening is not late on Sunday morning.
      const waited = pending ? await workingHoursBetween(new Date(r.waiting_since), now) : null;
      // Being the assigned approver is what entitles you to see the margin you are asked to judge.
      const entitled = owner_id === ctx.employeeId || r.approver_id === ctx.userId;
      return {
        ...(mask(ctx, 'quotation_versions', rest, entitled) as Row),
        waiting_working_hours: waited,
        overdue: waited !== null && r.escalate_after_hours != null ? waited >= r.escalate_after_hours : false,
      };
    }));
    const last = page[page.length - 1];
    return { data, nextCursor: more && last ? encodeCursor({ t: last._ts, id: last.id }) : null };
  });

  app.post('/api/v1/approvals/:id/steps/:stepId/decide', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'quotations.approve');
    const { id, stepId } = parse(decideParams, req.params);
    const b = parse(decideBody, req.body);

    // The self-approval block must COMMIT its chain advance and only then refuse, so the work is done outside the throw.
    const result = await guard(() => tx(txCtx(ctx, scope), async (c) => {
      const run = runOn(c);
      const ap = (await run(`SELECT * FROM gw.approvals WHERE id = $1 FOR UPDATE`, [id]))[0];
      if (!ap) throw notFound('Approval');
      if (ap.status !== 'Pending') throw conflict('already_decided', `This approval is already ${ap.status}.`);
      const steps = await run(`SELECT * FROM gw.approval_steps WHERE approval_id = $1 ORDER BY step_no FOR UPDATE`, [id]);
      const step = steps.find((s) => s.id === stepId);
      if (!step) throw notFound('Approval step');
      if (step.status !== 'Pending') throw conflict('step_decided', `This step is already ${step.status}.`);
      const firstPending = steps.find((s) => s.status === 'Pending');
      if (firstPending && firstPending.id !== step.id) throw gateBlocked('An earlier approver has not decided yet. This step opens after theirs.');
      if (step.approver_id !== ctx.userId) throw forbidden('This approval step is assigned to someone else.');

      if (b.decision === 'Approved' && ap.requested_by === ctx.userId) {
        // An approver may not approve their own record. The step is skipped and the chain moves on.
        await run(
          `UPDATE gw.approval_steps SET status = 'Escalated', acted_at = now(), acted_by = $2,
                  comments = 'Skipped: the approver raised this record and cannot approve it.' WHERE id = $1`,
          [step.id, ctx.userId]);
        const later = steps.some((s) => s.step_no > step.step_no && s.status === 'Pending');
        let moved = later ? 'next approver' : 'none';
        if (!later) {
          const taken = steps.map((s) => s.approver_id as string);
          const alt = (await run(
            `SELECT DISTINCT u.id, u.display_name FROM gw.users u
               JOIN gw.user_roles ur ON ur.user_id = u.id
               JOIN gw.role_permissions rp ON rp.role_id = ur.role_id
               JOIN gw.permissions pm ON pm.id = rp.permission_id AND pm.key = 'quotations.approve'
              WHERE rp.scope IN ('A','D') AND u.is_active AND u.deleted_at IS NULL
                AND u.id <> $1 AND NOT (u.id = ANY($2::uuid[]))
              ORDER BY u.display_name LIMIT 1`, [ap.requested_by, taken]))[0];
          if (alt) {
            await run(
              `INSERT INTO gw.approval_steps (approval_id, step_no, approver_id, escalate_after_hours)
               VALUES ($1, $2, $3, $4)`,
              [id, Math.max(...steps.map((s) => s.step_no)) + 1, alt.id, step.escalate_after_hours]);
            moved = alt.display_name;
          } else {
            await run(`UPDATE gw.approvals SET status = 'Escalated' WHERE id = $1`, [id]);
          }
        }
        await audit(c, ctx, {
          entityType: 'approvals', entityId: id, action: 'update', field: 'self_approval_blocked',
          newValue: moved, reason: 'Approver attempted to approve a record they raised; step skipped.',
        });
        return { selfBlocked: true as const };
      }

      await run(
        `UPDATE gw.approval_steps SET status = $2::gw.approval_status, acted_at = now(), acted_by = $3, comments = $4 WHERE id = $1`,
        [step.id, b.decision, ctx.userId, b.comments ?? null]);

      let versionStatus: string | null = null;
      const isQuote = ap.entity_type === 'quotation_versions';
      if (b.decision === 'Rejected') {
        await run(`UPDATE gw.approval_steps SET status = 'Withdrawn' WHERE approval_id = $1 AND status = 'Pending'`, [id]);
        await run(`UPDATE gw.approvals SET status = 'Rejected', completed_at = now() WHERE id = $1`, [id]);
        if (isQuote && ap.trigger_code === TRIGGER_LOW_MARGIN) {
          await run(`UPDATE gw.quotation_versions SET status = 'Rejected' WHERE id = $1 AND status = 'PendingApproval'`, [ap.entity_id]);
          versionStatus = 'Rejected';
        }
      } else if (!steps.some((s) => s.step_no > step.step_no && s.status === 'Pending')) {
        await run(`UPDATE gw.approvals SET status = 'Approved', completed_at = now() WHERE id = $1`, [id]);
        if (isQuote && ap.trigger_code === TRIGGER_LOW_MARGIN) {
          const v = (await run(`SELECT status::text AS status, version_no FROM gw.quotation_versions WHERE id = $1 FOR UPDATE`, [ap.entity_id]))[0];
          if (!v || v.status !== 'PendingApproval') {
            throw gateBlocked(`Version ${v?.version_no ?? ''} is no longer waiting for approval, so it cannot be submitted from here.`);
          }
          await approveAndSubmit(c, ap.entity_id);
          versionStatus = 'Submitted';
        }
      }
      await audit(c, ctx, {
        entityType: 'approvals', entityId: id, action: b.decision === 'Approved' ? 'approve' : 'reject',
        field: `step_${step.step_no}`, oldValue: 'Pending', newValue: b.decision, reason: b.comments,
      });
      return { selfBlocked: false as const, approval: await approvalView(run, id), versionStatus };
    }));

    if (result.selfBlocked) {
      throw forbidden('You cannot approve a quotation you raised. It has gone to the next approver.');
    }
    return { data: { approval: result.approval, versionStatus: result.versionStatus } };
  });
}
