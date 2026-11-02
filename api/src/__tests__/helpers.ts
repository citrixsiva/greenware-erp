import './env.js';
import argon2 from 'argon2';
import { pool } from '../core/db.js';

export { pool };

export const BASE = process.env.API_URL ?? 'http://127.0.0.1:8080';
export const PASSWORD = process.env.SEED_PASSWORD ?? 'Greenware#2026';

/** Unique per process, so every run makes its own rows and no test depends on another. */
export const STAMP = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

export interface Res<T = any> { status: number; body: T }

export async function call<T = any>(
  method: string,
  path: string,
  opts: { token?: string; authorization?: string; body?: unknown } = {},
): Promise<Res<T>> {
  // No content-type without a body: a declared JSON body that is empty is itself a 400.
  const headers: Record<string, string> = opts.body === undefined ? {} : { 'content-type': 'application/json' };
  if (opts.authorization !== undefined) headers.authorization = opts.authorization;
  else if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: any = null;
  if (text) { try { body = JSON.parse(text); } catch { body = text; } }
  return { status: res.status, body: body as T };
}

export const get = <T = any>(path: string, token?: string) => call<T>('GET', path, { token });
export const post = <T = any>(path: string, token: string, body?: unknown) => call<T>('POST', path, { token, body });
export const patch = <T = any>(path: string, token: string, body?: unknown) => call<T>('PATCH', path, { token, body });
export const del = <T = any>(path: string, token: string) => call<T>('DELETE', path, { token });

export async function sql<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const r = await pool.query(text, params);
  return r.rows as T[];
}
export const sql1 = async <T = any>(text: string, params: any[] = []): Promise<T | null> =>
  (await sql<T>(text, params))[0] ?? null;

/** Runs one statement and returns the Postgres error instead of throwing. */
export async function sqlError(text: string, params: any[] = []): Promise<{ code?: string; message: string } | null> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(text, params);
    await c.query('ROLLBACK');
    return null;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    const err = e as { code?: string; message?: string };
    return { code: err.code, message: err.message ?? String(e) };
  } finally {
    c.release();
  }
}

/** Runs one statement inside a transaction that is always rolled back. */
export async function sqlRollback(fn: (q: (t: string, p?: any[]) => Promise<any[]>) => Promise<void>): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await fn(async (t, p = []) => (await c.query(t, p)).rows);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

const tokens = new Map<string, string>();

export async function login(email: string, password = PASSWORD): Promise<string> {
  const cached = tokens.get(email);
  if (cached) return cached;
  const r = await call<{ token: string }>('POST', '/api/v1/auth/login', { body: { email, password } });
  if (r.status !== 200 || !r.body?.token) {
    throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  tokens.set(email, r.body.token);
  return r.body.token;
}

/**
 * The seed ships no DIRECTOR or ADMIN holder, so the matrix cannot be driven for
 * those two roles without one. Idempotent: the same fixed test account is reused
 * across runs rather than piling up new users.
 */
export async function ensureRoleUser(roleCode: string, email: string, name: string): Promise<string> {
  const companyId = (await sql1<{ id: string }>(`SELECT id FROM gw.companies WHERE code = 'GWT'`))!.id;
  const calendarId = (await sql1<{ id: string }>(`SELECT id FROM gw.calendars WHERE name = 'Dubai'`))!.id;
  const u = (await sql<{ id: string }>(
    `INSERT INTO gw.users (email, display_name) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name, is_active = true, deleted_at = NULL
     RETURNING id`, [email, name]))[0];
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  await sql(
    `INSERT INTO gw.settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [`auth.local.${u.id}`, JSON.stringify({ hash })]);
  await sql(
    `INSERT INTO gw.user_roles (user_id, role_id, company_id)
     SELECT $1, r.id, $3 FROM gw.roles r WHERE r.code = $2 ON CONFLICT (user_id, role_id) DO NOTHING`,
    [u.id, roleCode, companyId]);
  await sql(
    `INSERT INTO gw.employees (user_id, full_name, calendar_id, is_active) VALUES ($1, $2, $3, true)
     ON CONFLICT (user_id) DO UPDATE SET full_name = EXCLUDED.full_name, is_active = true`,
    [u.id, name, calendarId]);
  return u.id;
}

export interface Masters {
  companyId: string;
  customerId: string;
  businessTypes: Record<string, string>;
  sbus: Record<string, string>;
  taxCodes: Record<string, string>;
  lossReasonId: string;
  employees: Record<string, string>;
  users: Record<string, string>;
}

export async function masters(): Promise<Masters> {
  const companyId = (await sql1<{ id: string }>(`SELECT id FROM gw.companies WHERE code = 'GWT'`))!.id;
  const customerId = (await sql1<{ id: string }>(
    `SELECT id FROM gw.customers WHERE is_active AND deleted_at IS NULL ORDER BY customer_code LIMIT 1`))!.id;
  const bt = await sql<{ code: string; id: string }>(`SELECT code, id FROM gw.business_types`);
  const sb = await sql<{ code: string; id: string }>(`SELECT code, id FROM gw.sbus`);
  const tc = await sql<{ code: string; id: string }>(`SELECT code, id FROM gw.tax_codes`);
  const lr = (await sql1<{ id: string }>(`SELECT id FROM gw.loss_reasons WHERE is_active ORDER BY name LIMIT 1`))!.id;
  const people = await sql<{ email: string; user_id: string; employee_id: string | null }>(
    `SELECT u.email, u.id AS user_id, e.id AS employee_id
       FROM gw.users u LEFT JOIN gw.employees e ON e.user_id = u.id`);
  return {
    companyId,
    customerId,
    businessTypes: Object.fromEntries(bt.map(r => [r.code, r.id])),
    sbus: Object.fromEntries(sb.map(r => [r.code, r.id])),
    taxCodes: Object.fromEntries(tc.map(r => [r.code, r.id])),
    lossReasonId: lr,
    employees: Object.fromEntries(people.filter(p => p.employee_id).map(p => [p.email, p.employee_id as string])),
    users: Object.fromEntries(people.map(p => [p.email, p.user_id])),
  };
}

/** Creates an enquiry owned by `asEmail` with one line pinned to `sbuCode`. */
export async function createEnquiry(
  asEmail: string, m: Masters, opts: { businessType?: string; sbuCode?: string; title?: string } = {},
): Promise<{ id: string; enquiry_no: string }> {
  const token = await login(asEmail);
  const r = await post('/api/v1/enquiries', token, {
    customerId: m.customerId,
    businessTypeId: m.businessTypes[opts.businessType ?? 'PRODUCT'],
    title: opts.title ?? `Test enquiry ${STAMP}`,
    lines: [{ description: `Line for ${STAMP}`, quantity: 2, sbuId: m.sbus[opts.sbuCode ?? 'SBU1'] }],
  });
  if (r.status !== 201) throw new Error(`createEnquiry failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data;
}

export interface QuoteLineIn {
  description?: string; quantity: number; unitPrice: number; discountPct?: number; unitCost: number;
  taxCodeId?: string | null; partNumber?: string | null;
}

/** Creates a quotation (v1 Draft) on `enquiryId`. Must be run as a caller holding supplier_cost. */
export async function createQuotation(
  asEmail: string, enquiryId: string, lines: QuoteLineIn[],
): Promise<{ quotationId: string; versionId: string }> {
  const token = await login(asEmail);
  const r = await post('/api/v1/quotations', token, {
    enquiryId,
    lines: lines.map((l, i) => ({
      description: l.description ?? `Item ${i + 1} ${STAMP}`,
      partNumber: l.partNumber ?? `PN-${STAMP}-${i + 1}`,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discountPct: l.discountPct ?? 0,
      unitCost: l.unitCost,
    })),
  });
  if (r.status !== 201) throw new Error(`createQuotation failed: ${r.status} ${JSON.stringify(r.body)}`);
  const data = r.body.data;
  const v1 = data.versions.find((v: any) => v.version_no === 1);
  return { quotationId: data.id, versionId: v1.id };
}

/** Grants a user explicit visibility of one record, the share arm of scopeSql. */
export async function shareRecord(entityType: string, entityId: string, userId: string, sharedBy: string) {
  await sql(
    `INSERT INTO gw.record_shares (entity_type, entity_id, user_id, shared_by) VALUES ($1,$2,$3,$4)`,
    [entityType, entityId, userId, sharedBy]);
}

export const closePool = () => pool.end();
