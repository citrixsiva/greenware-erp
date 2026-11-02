import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { q, q1, tx } from '../core/db.js';
import type { Row } from '../core/db.js';
import { require_, scopeSql, mask, maskAll } from '../core/rbac.js';
import { audit } from '../core/audit.js';
import { badRequest, notFound, forbidden, conflict } from '../core/errors.js';
import { nextNumber } from '../core/numbering.js';
import type { AuthCtx, FieldGroup, Scope } from '../core/types.js';

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

const camel = (s: string) => s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());

/** Accepts snake_case or camelCase top-level keys; empty query strings count as "not supplied". */
function normaliseInput(data: unknown, dropEmpty: boolean): unknown {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return {};
  return Object.fromEntries(
    Object.entries(data as Record<string, unknown>)
      .filter(([, v]) => !(dropEmpty && v === ''))
      .map(([k, v]) => [camel(k), v]),
  );
}

function parse<S extends z.ZodTypeAny>(schema: S, data: unknown, dropEmpty = false): z.infer<S> {
  const r = schema.safeParse(normaliseInput(data, dropEmpty));
  if (!r.success) {
    throw badRequest('validation_failed', 'Check the highlighted fields',
      r.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));
  }
  return r.data as z.infer<S>;
}

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const ccy = z.string().trim().length(3).transform(s => s.toUpperCase());
const country = z.string().trim().length(2).transform(s => s.toUpperCase());
const text = (max = 255) => z.string().trim().min(1).max(max);
const optText = (max = 255) => z.string().trim().max(max).nullable().optional();
const activeFilter = z.enum(['true', 'false', 'all']).default('true');
const pageFields = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(64).optional(),
};

const encodeCursor = (n: number) => Buffer.from(`o:${n}`).toString('base64url');
function decodeCursor(c?: string): number {
  if (!c) return 0;
  const m = /^o:(\d{1,9})$/.exec(Buffer.from(c, 'base64url').toString());
  if (!m) throw badRequest('bad_cursor', 'That page marker is no longer valid. Reload the list from the first page.');
  return Number(m[1]);
}
/** Callers fetch limit+1 rows; this trims the extra one and builds the cursor. */
function envelope<T>(rows: T[], limit: number, offset: number): { data: T[]; nextCursor: string | null } {
  const more = rows.length > limit;
  return { data: more ? rows.slice(0, limit) : rows, nextCursor: more ? encodeCursor(offset + limit) : null };
}

const like = (s: string) => `%${s.replace(/[\\%_]/g, m => `\\${m}`)}%`;

/** Postgres errors become messages the user can act on. */
function translatePgError(e: unknown): unknown {
  const err = e as { code?: string; constraint?: string } | null;
  if (!err || typeof err !== 'object') return e;
  if (err.code === '23505') {
    return conflict('duplicate', 'A record with the same code or details already exists. Open the existing record or change the code.',
      { constraint: err.constraint });
  }
  if (err.code === '23503') {
    return badRequest('invalid_reference', 'One of the linked records (company, employee, product, manufacturer or category) does not exist or was removed. Pick it again.',
      { constraint: err.constraint });
  }
  if (err.code === '23514') {
    return badRequest('check_failed', 'One of the values is outside what the system allows. Review the numbers and try again.',
      { constraint: err.constraint });
  }
  return e;
}
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) { throw translatePgError(e); }
}

const txCtx = (ctx: AuthCtx, scope: Scope) =>
  ({ userId: ctx.userId, employeeId: ctx.employeeId, sbuId: ctx.sbuIds[0], scope });

const isFull = (scope: Scope) => scope === 'A' || scope === 'D';

const canSee = (ctx: AuthCtx, g: FieldGroup, isOwn: boolean) =>
  ctx.fields.has(g) || (isOwn && ctx.fieldsOwnOnly.has(g));

/** A user may not write a field they are not allowed to read — otherwise it is a blind write. */
function assertCanWrite(ctx: AuthCtx, g: FieldGroup, isOwn: boolean, label: string): void {
  if (!canSee(ctx, g, isOwn)) {
    throw forbidden(`You cannot set ${label}: that information is restricted for your role. Ask an administrator for temporary access, or leave it blank.`);
  }
}

const norm = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
};

interface UpdateOpts {
  table: string;
  entityType: string;
  before: Row;
  changes: Record<string, unknown>;
  stamps: 'customers' | 'row_version' | 'none';
  /** Columns whose values must not be copied into the audit trail. */
  sensitive?: string[];
}

/** Applies only the columns that really changed, and writes one audit row per changed field. */
async function applyUpdate(c: pg.PoolClient, ctx: AuthCtx, o: UpdateOpts): Promise<Row> {
  const changed = Object.entries(o.changes)
    .filter(([k, v]) => v !== undefined && norm(v) !== norm(o.before[k]));
  if (!changed.length) return o.before;

  const params: unknown[] = [o.before.id];
  const sets = changed.map(([k, v]) => { params.push(v); return `${k} = $${params.length}`; });
  if (o.stamps === 'customers') {
    params.push(ctx.userId);
    sets.push('updated_at = now()', `updated_by = $${params.length}`, 'row_version = row_version + 1');
  } else if (o.stamps === 'row_version') {
    sets.push('row_version = row_version + 1');
  }
  const res = await c.query(`UPDATE gw.${o.table} SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);

  for (const [k, v] of changed) {
    const hide = o.sensitive?.includes(k) ?? false;
    await audit(c, ctx, {
      entityType: o.entityType, entityId: String(o.before.id), action: 'update', field: k,
      oldValue: hide || o.before[k] == null ? undefined : o.before[k],
      newValue: hide || v == null ? undefined : v,
    });
  }
  return res.rows[0] as Row;
}

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const technologiesQuery = z.object({
  q: z.string().trim().max(100).optional(),
  categoryId: uuid.optional(),
  sbuId: uuid.optional(),
  ...pageFields,
});

const customerListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  accountManagerId: uuid.optional(),
  active: activeFilter,
  ...pageFields,
});

const customerCreate = z.object({
  companyId: uuid.optional(),
  customerCode: text(24).optional(),
  name: text(),
  industry: optText(),
  location: optText(),
  country: country.nullable().optional(),
  customerType: optText(),
  accountManagerId: uuid.nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  defaultCurrency: ccy.optional(),
  creditLimit: z.number().min(0).max(99_999_999_999_999).nullable().optional(),
  creditCurrency: ccy.nullable().optional(),
  taxRegistration: optText(),
});

const customerPatch = z.object({
  name: text().optional(),
  industry: optText(),
  location: optText(),
  country: country.nullable().optional(),
  customerType: optText(),
  accountManagerId: uuid.nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  defaultCurrency: ccy.optional(),
  creditLimit: z.number().min(0).max(99_999_999_999_999).nullable().optional(),
  creditCurrency: ccy.nullable().optional(),
  taxRegistration: optText(),
  isActive: z.boolean().optional(),
  /** Send the row_version you loaded to detect that someone else edited meanwhile. */
  rowVersion: z.number().int().positive().optional(),
});

const contactCreate = z.object({
  fullName: text(),
  designation: optText(),
  email: z.string().trim().email().max(255).nullable().optional(),
  phone: optText(50),
  isPrimary: z.boolean().optional(),
});
const contactPatch = contactCreate.partial().extend({ isActive: z.boolean().optional() });

const supplierListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  active: activeFilter,
  ...pageFields,
});
const supplierCreate = z.object({
  supplierCode: text(24).optional(),
  name: text(),
  country: country.nullable().optional(),
  defaultCurrency: ccy.optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  creditLimit: z.number().min(0).max(99_999_999_999_999).nullable().optional(),
  rating: z.number().min(0).max(5).nullable().optional(),
});
const supplierPatch = supplierCreate.omit({ supplierCode: true }).partial()
  .extend({ isActive: z.boolean().optional(), rowVersion: z.number().int().positive().optional() });

const productQuery = z.object({
  q: z.string().trim().max(100).optional(),
  manufacturerId: uuid.optional(),
  categoryId: uuid.optional(),
  productId: uuid.optional(),
  ...pageFields,
});

const skuCreate = z.object({
  productId: uuid.optional(),
  newProduct: z.object({
    name: text(),
    manufacturerId: uuid.nullable().optional(),
    categoryId: uuid.nullable().optional(),
    description: optText(4000),
  }).optional(),
  partNumber: text(),
  description: optText(4000),
  uom: text(12).default('EA'),
  listPrice: z.number().min(0).max(99_999_999_999_999).nullable().optional(),
  listCurrency: ccy.nullable().optional(),
}).refine(b => !!b.productId !== !!b.newProduct,
  { message: 'Give either an existing productId or the details of a newProduct, not both', path: ['productId'] })
  .refine(b => b.listPrice == null || !!b.listCurrency,
    { message: 'A list price needs a currency', path: ['listCurrency'] });

const employeeQuery = z.object({
  q: z.string().trim().max(100).optional(),
  sbuId: uuid.optional(),
  active: activeFilter,
  ...pageFields,
});

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export async function mastersRoutes(app: FastifyInstance) {
  const TECH_SELECT = `
    SELECT t.id, t.name, t.category_id, tc.name AS category_name,
           COALESCE(t.sbu_id, tc.sbu_id) AS sbu_id, s.code AS sbu_code, s.name AS sbu_name,
           (t.sbu_id IS NOT NULL) AS sbu_overridden
      FROM gw.technologies t
      JOIN gw.technology_categories tc ON tc.id = t.category_id
      LEFT JOIN gw.sbus s ON s.id = COALESCE(t.sbu_id, tc.sbu_id)`;

  /* ---------------- bootstrap ---------------- */

  app.get('/api/v1/masters/bootstrap', async (req) => {
    // Any authenticated user: the auth hook has already rejected anonymous callers.
    if (!req.auth) throw forbidden('Sign in to load the application data');

    const [companies, sbus, categories, technologies, businessTypes, taxCodes, currencies, lossReasons, calendars] =
      await Promise.all([
        q(`SELECT id, code, name, country, base_currency, tax_registration
             FROM gw.companies WHERE is_active ORDER BY code`),
        q(`SELECT s.id, s.code, s.name, s.head_employee_id, h.full_name AS head_name
             FROM gw.sbus s LEFT JOIN gw.employees h ON h.id = s.head_employee_id
            WHERE s.is_active ORDER BY s.code`),
        q(`SELECT tc.id, tc.name, tc.sbu_id, s.code AS sbu_code, tc.sla_profile, tc.sort_order
             FROM gw.technology_categories tc LEFT JOIN gw.sbus s ON s.id = tc.sbu_id
            WHERE tc.is_active ORDER BY tc.sort_order NULLS LAST, tc.name`),
        q(`${TECH_SELECT} WHERE t.is_active AND tc.is_active
            ORDER BY tc.sort_order NULLS LAST, tc.name, t.name`),
        q(`SELECT id, code, name, needs_procurement, needs_estimation, creates_project, is_recurring
             FROM gw.business_types WHERE is_active ORDER BY name`),
        q(`SELECT id, code, description, rate_pct, is_reverse_charge
             FROM gw.tax_codes WHERE is_active ORDER BY code`),
        q(`SELECT code, name FROM gw.currencies WHERE is_active ORDER BY code`),
        q(`SELECT id, code, name FROM gw.loss_reasons WHERE is_active ORDER BY name`),
        q(`SELECT id, name, timezone, working_days, day_start::text AS day_start, day_end::text AS day_end
             FROM gw.calendars WHERE is_active ORDER BY name`),
      ]);

    return {
      data: {
        companies, sbus,
        technology_categories: categories,
        technologies,
        business_types: businessTypes,
        tax_codes: taxCodes,
        currencies,
        loss_reasons: lossReasons,
        calendars,
      },
    };
  });

  /* ---------------- technologies ---------------- */

  app.get('/api/v1/technologies', async (req) => {
    if (!req.auth) throw forbidden('Sign in to search technologies');
    const f = parse(technologiesQuery, req.query, true);
    const offset = decodeCursor(f.cursor);

    const where = ['t.is_active', 'tc.is_active'];
    const params: unknown[] = [];
    if (f.q) { params.push(like(f.q)); where.push(`(t.name ILIKE $${params.length} OR tc.name ILIKE $${params.length})`); }
    if (f.categoryId) { params.push(f.categoryId); where.push(`t.category_id = $${params.length}`); }
    if (f.sbuId) { params.push(f.sbuId); where.push(`COALESCE(t.sbu_id, tc.sbu_id) = $${params.length}`); }
    params.push(f.limit + 1, offset);

    const rows = await q(
      `${TECH_SELECT} WHERE ${where.join(' AND ')}
        ORDER BY tc.sort_order NULLS LAST, tc.name, t.name, t.id
        LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return envelope(rows, f.limit, offset);
  });

  app.get('/api/v1/technologies/:id/route', async (req) => {
    if (!req.auth) throw forbidden('Sign in to route a technology');
    const { id } = parse(idParams, req.params);
    const row = await q1(
      `SELECT t.id AS "technologyId", tc.name AS "categoryName",
              COALESCE(t.sbu_id, tc.sbu_id) AS "sbuId", s.code AS "sbuCode", s.name AS "sbuName",
              h.full_name AS "headEmployeeName"
         FROM gw.technologies t
         JOIN gw.technology_categories tc ON tc.id = t.category_id
         LEFT JOIN gw.sbus s ON s.id = COALESCE(t.sbu_id, tc.sbu_id)
         LEFT JOIN gw.employees h ON h.id = s.head_employee_id
        WHERE t.id = $1 AND t.is_active`, [id]);
    if (!row) throw notFound('Technology');
    return { data: row };
  });

  /* ---------------- customers ---------------- */

  const ownsCustomer = (ctx: AuthCtx, r: Row) =>
    ctx.employeeId !== null && r.account_manager_id === ctx.employeeId;

  app.get('/api/v1/customers', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'customers.view');
    const f = parse(customerListQuery, req.query, true);
    const offset = decodeCursor(f.cursor);

    const sc = scopeSql(ctx, scope, { alias: 'c', ownerCol: 'account_manager_id', entity: 'customers' }, 1);
    const params: unknown[] = [...sc.params];
    const where = ['c.deleted_at IS NULL', sc.sql];
    if (f.active !== 'all') { params.push(f.active === 'true'); where.push(`c.is_active = $${params.length}`); }
    if (f.q) { params.push(like(f.q)); where.push(`(c.name ILIKE $${params.length} OR c.customer_code ILIKE $${params.length})`); }
    if (f.accountManagerId) { params.push(f.accountManagerId); where.push(`c.account_manager_id = $${params.length}`); }
    params.push(f.limit + 1, offset);

    const rows = await q(
      `SELECT c.*, e.full_name AS account_manager_name
         FROM gw.customers c LEFT JOIN gw.employees e ON e.id = c.account_manager_id
        WHERE ${where.join(' AND ')}
        ORDER BY c.name, c.id
        LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    const page = envelope(rows, f.limit, offset);
    return { data: maskAll(ctx, 'customers', page.data, r => ownsCustomer(ctx, r)), nextCursor: page.nextCursor };
  });

  app.get('/api/v1/customers/:id', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'customers.view');
    const { id } = parse(idParams, req.params);

    const sc = scopeSql(ctx, scope, { alias: 'c', ownerCol: 'account_manager_id', entity: 'customers' }, 2);
    const row = await q1(
      `SELECT c.*, e.full_name AS account_manager_name
         FROM gw.customers c LEFT JOIN gw.employees e ON e.id = c.account_manager_id
        WHERE c.id = $1 AND c.deleted_at IS NULL AND ${sc.sql}`, [id, ...sc.params]);
    if (!row) throw notFound('Customer');

    const contacts = await q(
      `SELECT id, customer_id, full_name, designation, email, phone, is_primary, is_active
         FROM gw.customer_contacts WHERE customer_id = $1 AND is_active
        ORDER BY is_primary DESC, full_name`, [id]);
    return { data: { ...mask(ctx, 'customers', row, ownsCustomer(ctx, row)), contacts } };
  });

  app.post('/api/v1/customers', async (req, reply) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'customers.create');
    const b = parse(customerCreate, req.body);

    const accountManagerId = b.accountManagerId === undefined ? ctx.employeeId : b.accountManagerId;
    if (scope === 'O') {
      if (!ctx.employeeId) throw badRequest('no_employee_profile', 'Your user is not linked to an employee record, so you cannot own customers. Ask an administrator to link it.');
      if (accountManagerId !== ctx.employeeId) throw forbidden('With your access level you can only create customers that you manage yourself.');
    }
    const isOwn = accountManagerId !== null && accountManagerId === ctx.employeeId;
    if (b.creditLimit !== undefined || b.creditCurrency !== undefined) assertCanWrite(ctx, 'credit', isOwn, 'the credit limit');

    const row = await guarded(() => tx(txCtx(ctx, scope), async (c) => {
      let companyId = b.companyId ?? null;
      if (!companyId) {
        const cos = (await c.query(`SELECT id FROM gw.companies WHERE is_active ORDER BY code`)).rows as Row[];
        if (cos.length !== 1) throw badRequest('company_required', 'Choose which company this customer belongs to (companyId).');
        companyId = cos[0].id as string;
      }
      const code = b.customerCode ?? await nextNumber(c, 'customer', companyId, 'CUS');
      const res = await c.query(
        `INSERT INTO gw.customers
           (company_id, customer_code, name, industry, location, country, customer_type, account_manager_id,
            payment_terms_days, default_currency, credit_limit, credit_currency, tax_registration, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9,30), COALESCE($10,'AED'), $11, COALESCE($12,'AED'), $13, $14, $14)
         RETURNING *`,
        [companyId, code, b.name, b.industry ?? null, b.location ?? null, b.country ?? null, b.customerType ?? null,
         accountManagerId, b.paymentTermsDays ?? null, b.defaultCurrency ?? null, b.creditLimit ?? null,
         b.creditCurrency ?? null, b.taxRegistration ?? null, ctx.userId]);
      const created = res.rows[0] as Row;
      await audit(c, ctx, { entityType: 'customers', entityId: String(created.id), action: 'create' });
      return created;
    }));
    reply.code(201);
    return { data: mask(ctx, 'customers', row, ownsCustomer(ctx, row)) };
  });

  app.patch('/api/v1/customers/:id', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'customers.edit');
    const { id } = parse(idParams, req.params);
    const b = parse(customerPatch, req.body);
    if (Object.keys(b).filter(k => k !== 'rowVersion').length === 0) {
      throw badRequest('nothing_to_update', 'Send at least one field to change.');
    }

    const row = await guarded(() => tx(txCtx(ctx, scope), async (c) => {
      const sc = scopeSql(ctx, scope, { alias: 'c', ownerCol: 'account_manager_id', entity: 'customers' }, 2);
      const before = (await c.query(
        `SELECT c.* FROM gw.customers c WHERE c.id = $1 AND c.deleted_at IS NULL AND ${sc.sql} FOR UPDATE OF c`,
        [id, ...sc.params])).rows[0] as Row | undefined;
      if (!before) throw notFound('Customer');
      if (b.rowVersion !== undefined && b.rowVersion !== before.row_version) {
        throw conflict('stale_record', 'Someone else changed this customer after you opened it. Reload it and apply your change again.');
      }
      const isOwn = ownsCustomer(ctx, before);
      if (b.creditLimit !== undefined || b.creditCurrency !== undefined) assertCanWrite(ctx, 'credit', isOwn, 'the credit limit');
      if (scope === 'O' && b.accountManagerId !== undefined && b.accountManagerId !== before.account_manager_id) {
        throw forbidden('With your access level you cannot hand a customer over to another account manager. Ask your manager to reassign it.');
      }
      return applyUpdate(c, ctx, {
        table: 'customers', entityType: 'customers', before, stamps: 'customers',
        sensitive: ['credit_limit', 'credit_currency'],
        changes: {
          name: b.name, industry: b.industry, location: b.location, country: b.country,
          customer_type: b.customerType, account_manager_id: b.accountManagerId,
          payment_terms_days: b.paymentTermsDays, default_currency: b.defaultCurrency,
          credit_limit: b.creditLimit, credit_currency: b.creditCurrency,
          tax_registration: b.taxRegistration, is_active: b.isActive,
        },
      });
    }));
    return { data: mask(ctx, 'customers', row, ownsCustomer(ctx, row)) };
  });

  /* ---------------- contacts ---------------- */

  app.post('/api/v1/customers/:id/contacts', async (req, reply) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'customers.edit');
    const { id } = parse(idParams, req.params);
    const b = parse(contactCreate, req.body);

    const row = await guarded(() => tx(txCtx(ctx, scope), async (c) => {
      const sc = scopeSql(ctx, scope, { alias: 'c', ownerCol: 'account_manager_id', entity: 'customers' }, 2);
      const owner = (await c.query(
        `SELECT c.id FROM gw.customers c WHERE c.id = $1 AND c.deleted_at IS NULL AND ${sc.sql} FOR UPDATE OF c`,
        [id, ...sc.params])).rows[0] as Row | undefined;
      if (!owner) throw notFound('Customer');

      const existing = Number((await c.query(
        `SELECT count(*) AS n FROM gw.customer_contacts WHERE customer_id = $1 AND is_active`, [id])).rows[0].n);
      // the first contact is always the primary one
      const primary = b.isPrimary === true || existing === 0;
      if (primary) await c.query(`UPDATE gw.customer_contacts SET is_primary = false WHERE customer_id = $1`, [id]);

      const res = await c.query(
        `INSERT INTO gw.customer_contacts (customer_id, full_name, designation, email, phone, is_primary)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [id, b.fullName, b.designation ?? null, b.email ?? null, b.phone ?? null, primary]);
      const created = res.rows[0] as Row;
      await audit(c, ctx, { entityType: 'customer_contacts', entityId: String(created.id), action: 'create' });
      return created;
    }));
    reply.code(201);
    return { data: row };
  });

  app.patch('/api/v1/contacts/:id', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'customers.edit');
    const { id } = parse(idParams, req.params);
    const b = parse(contactPatch, req.body);
    if (Object.keys(b).length === 0) throw badRequest('nothing_to_update', 'Send at least one field to change.');

    const row = await guarded(() => tx(txCtx(ctx, scope), async (c) => {
      const sc = scopeSql(ctx, scope, { alias: 'c', ownerCol: 'account_manager_id', entity: 'customers' }, 2);
      const before = (await c.query(
        `SELECT ct.* FROM gw.customer_contacts ct
           JOIN gw.customers c ON c.id = ct.customer_id
          WHERE ct.id = $1 AND c.deleted_at IS NULL AND ${sc.sql} FOR UPDATE OF ct`,
        [id, ...sc.params])).rows[0] as Row | undefined;
      if (!before) throw notFound('Contact');
      if (b.isPrimary === true) {
        await c.query(`UPDATE gw.customer_contacts SET is_primary = false WHERE customer_id = $1 AND id <> $2`,
          [before.customer_id, id]);
      }
      return applyUpdate(c, ctx, {
        table: 'customer_contacts', entityType: 'customer_contacts', before, stamps: 'none',
        changes: {
          full_name: b.fullName, designation: b.designation, email: b.email, phone: b.phone,
          is_primary: b.isPrimary, is_active: b.isActive,
        },
      });
    }));
    return { data: row };
  });

  /* ---------------- suppliers ---------------- */

  app.get('/api/v1/suppliers', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'suppliers.view');
    const f = parse(supplierListQuery, req.query, true);
    const offset = decodeCursor(f.cursor);

    const sc = scopeSql(ctx, scope, { alias: 's', entity: 'suppliers' }, 1);
    const params: unknown[] = [...sc.params];
    const where = [sc.sql];
    if (f.active !== 'all') { params.push(f.active === 'true'); where.push(`s.is_active = $${params.length}`); }
    if (f.q) { params.push(like(f.q)); where.push(`(s.name ILIKE $${params.length} OR s.supplier_code ILIKE $${params.length})`); }
    params.push(f.limit + 1, offset);

    const rows = await q(
      `SELECT s.* FROM gw.suppliers s WHERE ${where.join(' AND ')}
        ORDER BY s.name, s.id LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    const page = envelope(rows, f.limit, offset);
    return { data: maskAll(ctx, 'suppliers', page.data), nextCursor: page.nextCursor };
  });

  app.get('/api/v1/suppliers/:id', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'suppliers.view');
    const { id } = parse(idParams, req.params);

    const sc = scopeSql(ctx, scope, { alias: 's', entity: 'suppliers' }, 2);
    const row = await q1(`SELECT s.* FROM gw.suppliers s WHERE s.id = $1 AND ${sc.sql}`, [id, ...sc.params]);
    if (!row) throw notFound('Supplier');
    const contacts = await q(
      `SELECT id, supplier_id, full_name, email, phone, is_primary
         FROM gw.supplier_contacts WHERE supplier_id = $1 ORDER BY is_primary DESC, full_name`, [id]);
    return { data: { ...mask(ctx, 'suppliers', row, false), contacts } };
  });

  app.post('/api/v1/suppliers', async (req, reply) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'suppliers.create');
    const b = parse(supplierCreate, req.body);
    if (b.paymentTermsDays !== undefined || b.creditLimit !== undefined) {
      assertCanWrite(ctx, 'supplier_terms', false, 'the supplier payment terms or credit limit');
    }

    const row = await guarded(() => tx(txCtx(ctx, scope), async (c) => {
      const code = b.supplierCode ?? await nextNumber(c, 'supplier', null, 'SUP');
      const res = await c.query(
        `INSERT INTO gw.suppliers (supplier_code, name, country, default_currency, payment_terms_days, credit_limit, rating)
         VALUES ($1,$2,$3, COALESCE($4,'AED'), COALESCE($5,30), $6, $7) RETURNING *`,
        [code, b.name, b.country ?? null, b.defaultCurrency ?? null, b.paymentTermsDays ?? null,
         b.creditLimit ?? null, b.rating ?? null]);
      const created = res.rows[0] as Row;
      await audit(c, ctx, { entityType: 'suppliers', entityId: String(created.id), action: 'create' });
      return created;
    }));
    reply.code(201);
    return { data: mask(ctx, 'suppliers', row, false) };
  });

  app.patch('/api/v1/suppliers/:id', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'suppliers.edit');
    const { id } = parse(idParams, req.params);
    const b = parse(supplierPatch, req.body);
    if (Object.keys(b).filter(k => k !== 'rowVersion').length === 0) {
      throw badRequest('nothing_to_update', 'Send at least one field to change.');
    }
    if (b.paymentTermsDays !== undefined || b.creditLimit !== undefined) {
      assertCanWrite(ctx, 'supplier_terms', false, 'the supplier payment terms or credit limit');
    }

    const row = await guarded(() => tx(txCtx(ctx, scope), async (c) => {
      const sc = scopeSql(ctx, scope, { alias: 's', entity: 'suppliers' }, 2);
      const before = (await c.query(
        `SELECT s.* FROM gw.suppliers s WHERE s.id = $1 AND ${sc.sql} FOR UPDATE OF s`,
        [id, ...sc.params])).rows[0] as Row | undefined;
      if (!before) throw notFound('Supplier');
      if (b.rowVersion !== undefined && b.rowVersion !== before.row_version) {
        throw conflict('stale_record', 'Someone else changed this supplier after you opened it. Reload it and apply your change again.');
      }
      return applyUpdate(c, ctx, {
        table: 'suppliers', entityType: 'suppliers', before, stamps: 'row_version',
        sensitive: ['payment_terms_days', 'credit_limit'],
        changes: {
          name: b.name, country: b.country, default_currency: b.defaultCurrency,
          payment_terms_days: b.paymentTermsDays, credit_limit: b.creditLimit,
          rating: b.rating, is_active: b.isActive,
        },
      });
    }));
    return { data: mask(ctx, 'suppliers', row, false) };
  });

  /* ---------------- products & SKUs ---------------- */

  /**
   * Products carry no SBU column. Where the caller's scope is narrower than all/department,
   * a product is visible when its category belongs to one of their SBUs (uncategorised
   * products stay visible: they are shared catalogue entries).
   */
  function productScope(ctx: AuthCtx, scope: Scope, startIdx: number): { sql: string; params: unknown[] } {
    if (isFull(scope)) return { sql: 'TRUE', params: [] };
    const sc = scopeSql(ctx, scope, { alias: 'ptc', sbuCol: 'sbu_id' }, startIdx);
    return { sql: `(p.category_id IS NULL OR ${sc.sql})`, params: sc.params };
  }

  async function assertProductWriteScope(
    c: pg.PoolClient, ctx: AuthCtx, scope: Scope, categoryId: string | null,
  ): Promise<void> {
    if (isFull(scope)) return;
    const msg = 'You can only add products to categories that belong to your own SBU. Ask a procurement or admin user to add this one.';
    if (!categoryId) throw forbidden(msg);
    const cat = (await c.query(`SELECT sbu_id FROM gw.technology_categories WHERE id = $1`, [categoryId])).rows[0] as Row | undefined;
    if (!cat || !cat.sbu_id || !ctx.sbuIds.includes(cat.sbu_id as string)) throw forbidden(msg);
  }

  app.get('/api/v1/products', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'products.view');
    const f = parse(productQuery, req.query, true);
    const offset = decodeCursor(f.cursor);

    const sc = productScope(ctx, scope, 1);
    const params: unknown[] = [...sc.params];
    const where = ['p.is_active', sc.sql];
    let order = 'p.name, p.id';
    if (f.q) {
      params.push(like(f.q)); const likeIdx = params.length;
      params.push(f.q); const rawIdx = params.length;
      where.push(`(p.name ILIKE $${likeIdx} OR EXISTS (
                     SELECT 1 FROM gw.product_skus sk WHERE sk.product_id = p.id AND sk.is_active
                        AND sk.part_number ILIKE $${likeIdx}))`);
      order = `GREATEST(similarity(p.name, $${rawIdx}),
                 COALESCE((SELECT max(similarity(sk.part_number, $${rawIdx})) FROM gw.product_skus sk
                            WHERE sk.product_id = p.id AND sk.is_active), 0)) DESC, p.name, p.id`;
    }
    if (f.manufacturerId) { params.push(f.manufacturerId); where.push(`p.manufacturer_id = $${params.length}`); }
    if (f.categoryId) { params.push(f.categoryId); where.push(`p.category_id = $${params.length}`); }
    params.push(f.limit + 1, offset);

    const rows = await q(
      `SELECT p.id, p.name, p.description, p.manufacturer_id, m.name AS manufacturer_name,
              p.category_id, ptc.name AS category_name,
              (SELECT count(*) FROM gw.product_skus sk WHERE sk.product_id = p.id AND sk.is_active)::int AS sku_count
         FROM gw.products p
         LEFT JOIN gw.manufacturers m ON m.id = p.manufacturer_id
         LEFT JOIN gw.technology_categories ptc ON ptc.id = p.category_id
        WHERE ${where.join(' AND ')}
        ORDER BY ${order}
        LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return envelope(rows, f.limit, offset);
  });

  app.get('/api/v1/product-skus', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'products.view');
    const f = parse(productQuery, req.query, true);
    const offset = decodeCursor(f.cursor);

    const sc = productScope(ctx, scope, 1);
    const params: unknown[] = [...sc.params];
    const where = ['sk.is_active', 'p.is_active', sc.sql];
    let order = 'p.name, sk.part_number, sk.id';
    if (f.q) {
      params.push(like(f.q)); const likeIdx = params.length;
      params.push(f.q); const rawIdx = params.length;
      where.push(`(sk.part_number ILIKE $${likeIdx} OR p.name ILIKE $${likeIdx})`);
      order = `GREATEST(similarity(sk.part_number, $${rawIdx}), similarity(p.name, $${rawIdx})) DESC, sk.part_number, sk.id`;
    }
    if (f.productId) { params.push(f.productId); where.push(`sk.product_id = $${params.length}`); }
    if (f.manufacturerId) { params.push(f.manufacturerId); where.push(`p.manufacturer_id = $${params.length}`); }
    if (f.categoryId) { params.push(f.categoryId); where.push(`p.category_id = $${params.length}`); }
    params.push(f.limit + 1, offset);

    const rows = await q(
      `SELECT sk.id, sk.product_id, sk.part_number, sk.description, sk.uom, sk.list_price, sk.list_currency,
              p.name AS product_name, p.manufacturer_id, m.name AS manufacturer_name,
              p.category_id, ptc.name AS category_name
         FROM gw.product_skus sk
         JOIN gw.products p ON p.id = sk.product_id
         LEFT JOIN gw.manufacturers m ON m.id = p.manufacturer_id
         LEFT JOIN gw.technology_categories ptc ON ptc.id = p.category_id
        WHERE ${where.join(' AND ')}
        ORDER BY ${order}
        LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return envelope(rows, f.limit, offset);
  });

  app.post('/api/v1/product-skus', async (req, reply) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'products.create');
    const b = parse(skuCreate, req.body);

    const out = await guarded(() => tx(txCtx(ctx, scope), async (c) => {
      let productId = b.productId ?? null;
      let product: Row | null = null;

      if (productId) {
        const p = (await c.query(`SELECT id, category_id, is_active FROM gw.products WHERE id = $1`, [productId])).rows[0] as Row | undefined;
        if (!p) throw notFound('Product');
        if (!p.is_active) throw badRequest('product_inactive', 'That product is inactive. Reactivate it or pick another product.');
        await assertProductWriteScope(c, ctx, scope, (p.category_id as string | null) ?? null);
      } else if (b.newProduct) {
        const np = b.newProduct;
        await assertProductWriteScope(c, ctx, scope, np.categoryId ?? null);
        product = (await c.query(
          `INSERT INTO gw.products (manufacturer_id, category_id, name, description) VALUES ($1,$2,$3,$4) RETURNING *`,
          [np.manufacturerId ?? null, np.categoryId ?? null, np.name, np.description ?? null])).rows[0] as Row;
        productId = product.id as string;
        await audit(c, ctx, { entityType: 'products', entityId: productId, action: 'create' });
      }

      const sku = (await c.query(
        `INSERT INTO gw.product_skus (product_id, part_number, description, uom, list_price, list_currency)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [productId, b.partNumber, b.description ?? null, b.uom, b.listPrice ?? null, b.listCurrency ?? null])).rows[0] as Row;
      await audit(c, ctx, { entityType: 'product_skus', entityId: String(sku.id), action: 'create' });
      return { sku, product };
    }));
    reply.code(201);
    return { data: out.product ? { ...out.sku, product: out.product } : out.sku };
  });

  /* ---------------- employees ---------------- */

  app.get('/api/v1/employees', async (req) => {
    const ctx = req.auth;
    // Needed by every assignment drop-down, so any authenticated user may list; day rates are masked below.
    if (!ctx) throw forbidden('Sign in to list employees');
    const f = parse(employeeQuery, req.query, true);
    const offset = decodeCursor(f.cursor);

    const params: unknown[] = [];
    const where: string[] = ['TRUE'];
    if (f.active !== 'all') { params.push(f.active === 'true'); where.push(`e.is_active = $${params.length}`); }
    if (f.q) { params.push(like(f.q)); where.push(`(e.full_name ILIKE $${params.length} OR e.employee_code ILIKE $${params.length})`); }
    if (f.sbuId) {
      params.push(f.sbuId);
      where.push(`EXISTS (SELECT 1 FROM gw.employee_sbu_memberships mm
                           WHERE mm.employee_id = e.id AND mm.sbu_id = $${params.length}
                             AND (mm.effective_to IS NULL OR mm.effective_to > current_date))`);
    }
    params.push(f.limit + 1, offset);

    const rows = await q(
      `SELECT e.id, e.employee_code, e.full_name, e.department_id, e.reports_to_id, e.seniority_band,
              e.is_billable, e.is_active, e.internal_day_rate, e.day_rate_currency,
              COALESCE((SELECT json_agg(r.code ORDER BY r.code)
                          FROM gw.user_roles ur JOIN gw.roles r ON r.id = ur.role_id
                         WHERE ur.user_id = e.user_id), '[]'::json) AS roles,
              COALESCE((SELECT json_agg(json_build_object(
                                 'sbu_id', m.sbu_id, 'sbu_code', s.code, 'membership', m.membership,
                                 'is_primary', m.is_primary, 'assigns_work', m.assigns_work)
                               ORDER BY m.is_primary DESC, s.code)
                          FROM gw.employee_sbu_memberships m JOIN gw.sbus s ON s.id = m.sbu_id
                         WHERE m.employee_id = e.id AND (m.effective_to IS NULL OR m.effective_to > current_date)),
                       '[]'::json) AS sbu_memberships
         FROM gw.employees e
        WHERE ${where.join(' AND ')}
        ORDER BY e.full_name, e.id
        LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    const page = envelope(rows, f.limit, offset);
    return {
      data: maskAll(ctx, 'employees', page.data, r => ctx.employeeId !== null && r.id === ctx.employeeId),
      nextCursor: page.nextCursor,
    };
  });
}
