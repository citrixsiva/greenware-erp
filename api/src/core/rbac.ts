import { q } from './db.js';
import { forbidden } from './errors.js';
import type { AuthCtx, FieldGroup, Scope } from './types.js';

const SCOPE_RANK: Record<Scope, number> = { O: 1, T: 2, S: 3, D: 4, A: 5 };
export const widest = (a: Scope, b: Scope): Scope => (SCOPE_RANK[a] >= SCOPE_RANK[b] ? a : b);

/**
 * Role baseline for the sensitive-field matrix in Part 2 of the blueprint.
 * 'own' means the group is visible only on records the user owns.
 * Anything not listed is masked, and permission_grants can add to this per user.
 */
export const ROLE_FIELDS: Record<string, { all: FieldGroup[]; own: FieldGroup[] }> = {
  SUPER_ADMIN: { all: ['supplier_cost','sell_price','margin','day_rate','service_cost','supplier_terms','credit'], own: [] },
  DIRECTOR:    { all: ['supplier_cost','sell_price','margin','day_rate','service_cost','supplier_terms','credit'], own: [] },
  SALES_MGR:   { all: ['supplier_cost','sell_price','service_cost'], own: ['margin','credit'] },
  // Sales must see the service cost to price the deal (OD-10: it is entered,
  // not derived), but never the engineer day rate behind it.
  SALES:       { all: [], own: ['sell_price','margin','credit','service_cost'] },
  PROCUREMENT: { all: ['supplier_cost','supplier_terms'], own: [] },
  // The engineer who types the service cost has to be able to read it back.
  TECHNICAL:   { all: [], own: ['service_cost'] },
  SBU_HEAD:    { all: ['service_cost'], own: ['margin'] },
  PM:          { all: [], own: [] },
  ACCOUNTS:    { all: ['supplier_cost','sell_price','margin','day_rate','service_cost','supplier_terms','credit'], own: [] },
  ADMIN:       { all: [], own: [] },
};

/** Which field group each maskable column belongs to, by table. */
export const FIELD_MAP: Record<string, Partial<Record<FieldGroup, string[]>>> = {
  quotation_versions: {
    supplier_cost: ['total_cost'],
    margin: ['gross_profit', 'gross_margin_pct'],
    sell_price: ['total_sell'],
  },
  quotation_lines: {
    supplier_cost: ['unit_cost', 'line_cost'],
    margin: ['line_gp'],
    sell_price: ['unit_price', 'line_sell', 'discount_pct'],
  },
  supplier_quote_lines: { supplier_cost: ['unit_cost'] },
  supplier_quotes:      { supplier_terms: ['payment_terms_days'] },
  suppliers:            { supplier_terms: ['payment_terms_days', 'credit_limit'] },
  customers:            { credit: ['credit_limit', 'credit_currency'] },
  employees:            { day_rate: ['internal_day_rate', 'day_rate_currency'] },
  technical_estimates:  { service_cost: ['estimated_service_cost', 'travel_cost'] },
  estimate_resources:   { day_rate: ['day_rate'] },
  customer_pos:         { supplier_cost: ['booked_cost'], margin: ['booked_gross_profit','booked_margin_pct'] },
  cost_price_points:    { supplier_cost: ['unit_cost','unit_cost_base'] },
  sell_price_points:    { supplier_cost: ['unit_cost'], margin: ['margin_pct'], sell_price: ['unit_price','discount_pct'] },
};

export async function loadAuthCtx(userId: string): Promise<AuthCtx | null> {
  const u = await q(
    `SELECT u.id, u.email, u.display_name, e.id AS employee_id
       FROM gw.users u LEFT JOIN gw.employees e ON e.user_id = u.id
      WHERE u.id = $1 AND u.is_active AND u.deleted_at IS NULL`, [userId]);
  if (!u.length) return null;

  const roles = (await q(
    `SELECT r.code FROM gw.user_roles ur JOIN gw.roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
    [userId])).map(r => r.code as string);

  const permRows = await q(
    `SELECT p.key, rp.scope
       FROM gw.user_roles ur
       JOIN gw.role_permissions rp ON rp.role_id = ur.role_id
       JOIN gw.permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = $1`, [userId]);
  const perms = new Map<string, Scope>();
  for (const r of permRows) {
    const prev = perms.get(r.key);
    perms.set(r.key, prev ? widest(prev, r.scope as Scope) : (r.scope as Scope));
  }

  const sbuIds = u[0].employee_id
    ? (await q(`SELECT sbu_id FROM gw.employee_sbu_memberships
                 WHERE employee_id = $1 AND (effective_to IS NULL OR effective_to > current_date)`,
               [u[0].employee_id])).map(r => r.sbu_id as string)
    : [];

  const fields = new Set<FieldGroup>();
  const fieldsOwnOnly = new Set<FieldGroup>();
  for (const code of roles) {
    const f = ROLE_FIELDS[code];
    if (!f) continue;
    f.all.forEach(g => fields.add(g));
    f.own.forEach(g => { if (!fields.has(g)) fieldsOwnOnly.add(g); });
  }
  // live grants widen the baseline, and are time-boxed
  const grants = await q(
    `SELECT field_group FROM gw.permission_grants
      WHERE user_id = $1 AND revoked_at IS NULL
        AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())`, [userId]);
  for (const g of grants) { fields.add(g.field_group as FieldGroup); fieldsOwnOnly.delete(g.field_group as FieldGroup); }

  return {
    userId: u[0].id, employeeId: u[0].employee_id, email: u[0].email,
    displayName: u[0].display_name, roles, perms, sbuIds, fields, fieldsOwnOnly,
  };
}

/** Returns the scope held for a permission, or null. */
export function scopeFor(ctx: AuthCtx, permKey: string): Scope | null {
  return ctx.perms.get(permKey) ?? null;
}

export function require_(ctx: AuthCtx, permKey: string): Scope {
  const s = scopeFor(ctx, permKey);
  if (!s) throw forbidden(`Missing permission: ${permKey}`);
  return s;
}

/**
 * SQL predicate implementing the scope rules, as a union with assignment and
 * explicit shares. Returns a fragment plus the params to append.
 */
export function scopeSql(
  ctx: AuthCtx, scope: Scope, opts: { alias: string; ownerCol?: string; sbuCol?: string; entity?: string },
  startIdx: number,
): { sql: string; params: any[] } {
  const a = opts.alias;
  const params: any[] = [];
  let i = startIdx;
  if (scope === 'A' || scope === 'D') return { sql: 'TRUE', params };

  const parts: string[] = [];
  if (opts.ownerCol && ctx.employeeId) { parts.push(`${a}.${opts.ownerCol} = $${i++}`); params.push(ctx.employeeId); }
  if ((scope === 'S' || scope === 'T') && opts.sbuCol && ctx.sbuIds.length) {
    parts.push(`${a}.${opts.sbuCol} = ANY($${i++}::uuid[])`); params.push(ctx.sbuIds);
  }
  if (opts.entity) {
    parts.push(`EXISTS (SELECT 1 FROM gw.record_shares rs
                         WHERE rs.entity_type = $${i} AND rs.entity_id = ${a}.id
                           AND rs.user_id = $${i + 1}
                           AND (rs.valid_to IS NULL OR rs.valid_to > now()))`);
    params.push(opts.entity, ctx.userId); i += 2;
  }
  return { sql: parts.length ? `(${parts.join(' OR ')})` : 'FALSE', params };
}

/**
 * Removes fields the caller may not see. A masked field is ABSENT from the
 * payload, never nulled or hidden client-side — the blueprint is explicit that
 * the interface must never hold data the user is not entitled to.
 */
export function mask<T extends Record<string, any>>(
  ctx: AuthCtx, table: string, row: T, isOwn = false,
): Partial<T> {
  const rules = FIELD_MAP[table];
  if (!rules) return row;
  const out: Record<string, any> = { ...row };
  for (const [group, cols] of Object.entries(rules) as [FieldGroup, string[]][]) {
    const allowed = ctx.fields.has(group) || (isOwn && ctx.fieldsOwnOnly.has(group));
    if (!allowed) for (const c of cols) delete out[c];
  }
  return out as Partial<T>;
}

export const maskAll = <T extends Record<string, any>>(
  ctx: AuthCtx, table: string, rows: T[], ownOf?: (r: T) => boolean,
) => rows.map(r => mask(ctx, table, r, ownOf ? ownOf(r) : false));
