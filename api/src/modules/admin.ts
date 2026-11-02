import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { q, tx } from '../core/db.js';
import type { Row } from '../core/db.js';
import { require_ } from '../core/rbac.js';
import { audit } from '../core/audit.js';
import { badRequest, notFound, forbidden, conflict } from '../core/errors.js';
import type { AuthCtx, Scope } from '../core/types.js';

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
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD');
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
function envelope<T>(rows: T[], limit: number, offset: number): { data: T[]; nextCursor: string | null } {
  const more = rows.length > limit;
  return { data: more ? rows.slice(0, limit) : rows, nextCursor: more ? encodeCursor(offset + limit) : null };
}

const like = (s: string) => `%${s.replace(/[\\%_]/g, m => `\\${m}`)}%`;

function translatePgError(e: unknown): unknown {
  const err = e as { code?: string; constraint?: string } | null;
  if (!err || typeof err !== 'object') return e;
  if (err.code === '23505') {
    return conflict('duplicate', 'A record with the same email or identifier already exists. Open the existing one instead.',
      { constraint: err.constraint });
  }
  if (err.code === '23503') {
    return badRequest('invalid_reference', 'One of the linked records (user, role, calendar or company) does not exist. Pick it again.',
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

const isSuperAdmin = (ctx: AuthCtx) => ctx.roles.includes('SUPER_ADMIN');

const norm = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
};

interface UpdateOpts {
  table: string;
  entityType: string;
  before: Row;
  changes: Record<string, unknown>;
  /** SQL cast per column, e.g. { escalate_role_ids: 'uuid[]' }. */
  casts?: Record<string, string>;
  /** users carry updated_at / updated_by. */
  stampUser?: boolean;
}

/** Applies only the columns that really changed and writes one audit row per changed field. */
async function applyUpdate(c: pg.PoolClient, ctx: AuthCtx, o: UpdateOpts): Promise<Row> {
  const changed = Object.entries(o.changes)
    .filter(([k, v]) => v !== undefined && norm(v) !== norm(o.before[k]));
  if (!changed.length) return o.before;

  const params: unknown[] = [o.before.id];
  const sets = changed.map(([k, v]) => {
    params.push(v);
    return `${k} = $${params.length}${o.casts?.[k] ? `::${o.casts[k]}` : ''}`;
  });
  if (o.stampUser) {
    params.push(ctx.userId);
    sets.push('updated_at = now()', `updated_by = $${params.length}`);
  }
  const res = await c.query(`UPDATE gw.${o.table} SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);

  for (const [k, v] of changed) {
    await audit(c, ctx, {
      entityType: o.entityType, entityId: String(o.before.id), action: 'update', field: k,
      oldValue: o.before[k] == null ? undefined : o.before[k],
      newValue: v == null ? undefined : v,
    });
  }
  return res.rows[0] as Row;
}

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const FIELD_GROUPS = ['supplier_cost', 'sell_price', 'margin', 'day_rate', 'supplier_terms', 'credit'] as const;

const userListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  active: z.enum(['true', 'false', 'all']).default('all'),
  role: z.string().trim().max(40).optional(),
  ...pageFields,
});
const userCreate = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  displayName: z.string().trim().min(1).max(255),
  entraObjectId: uuid.optional(),
  employeeId: uuid.optional(),
  roleCodes: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
});
const userPatch = z.object({
  isActive: z.boolean().optional(),
  displayName: z.string().trim().min(1).max(255).optional(),
});
const roleAssign = z.object({
  roleCode: z.string().trim().min(1).max(40),
  companyId: uuid.optional(),
});
const roleParams = z.object({ id: uuid, roleCode: z.string().trim().min(1).max(40) });

const grantCreate = z.object({
  userId: uuid,
  fieldGroup: z.enum(FIELD_GROUPS),
  reason: z.string().trim().min(5, 'Say why this access is needed (at least a few words)').max(1000),
  validTo: z.union([z.string().datetime({ offset: true }), isoDate]).optional(),
});
const grantListQuery = z.object({
  userId: uuid.optional(),
  status: z.enum(['live', 'all']).default('live'),
  ...pageFields,
});
const grantRevokeQuery = z.object({ reason: z.string().trim().max(1000).optional() });

const settingKeyParams = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/, 'Setting keys use lower-case letters, digits, dot, dash and underscore'),
});

const slaListQuery = z.object({
  timerCode: z.string().trim().max(48).optional(),
  active: z.enum(['true', 'false', 'all']).default('all'),
});
const slaPatch = z.object({
  targetHours: z.number().positive().max(8760).optional(),
  warnAtPct: z.number().min(0).max(100).optional(),
  calendarId: uuid.nullable().optional(),
  escalateRoleIds: z.array(uuid).max(20).nullable().optional(),
  effectiveTo: isoDate.nullable().optional(),
  isActive: z.boolean().optional(),
});

const marginListQuery = z.object({
  businessTypeId: uuid.optional(),
});
const pct = z.number().min(0).max(100);
const marginPatch = z.object({
  minMarginPct: pct.nullable().optional(),
  warnMarginPct: pct.nullable().optional(),
  salesSharePct: pct.optional(),
  technicalSharePct: pct.optional(),
  companySharePct: pct.optional(),
  effectiveFrom: isoDate.optional(),
  effectiveTo: isoDate.nullable().optional(),
});

const auditQuery = z.object({
  entityType: z.string().trim().max(100).optional(),
  entityId: uuid.optional(),
  actorUserId: uuid.optional(),
  action: z.enum(['create', 'update', 'soft_delete', 'approve', 'reject', 'override', 'grant', 'revoke',
    'export', 'download', 'login', 'login_failed']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.coerce.number().int().positive().optional(),
});

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

const USER_SELECT = `
  SELECT u.id, u.email, u.display_name, u.is_active, u.last_login_at, u.created_at,
         e.id AS employee_id, e.full_name AS employee_name,
         COALESCE((SELECT json_agg(json_build_object('code', r.code, 'name', r.name) ORDER BY r.code)
                     FROM gw.user_roles ur JOIN gw.roles r ON r.id = ur.role_id
                    WHERE ur.user_id = u.id), '[]'::json) AS roles
    FROM gw.users u
    LEFT JOIN gw.employees e ON e.user_id = u.id
   WHERE u.deleted_at IS NULL`;

const SLA_SELECT = `
  SELECT r.id, r.timer_code, r.urgency, r.target_hours, r.calendar_id, cal.name AS calendar_name,
         r.warn_at_pct, r.escalate_role_ids, r.effective_from::text AS effective_from,
         r.effective_to::text AS effective_to, r.is_active
    FROM gw.sla_rules r LEFT JOIN gw.calendars cal ON cal.id = r.calendar_id`;

const MARGIN_SELECT = `
  SELECT m.id, m.business_type_id, bt.code AS business_type_code, bt.name AS business_type_name,
         m.min_margin_pct, m.warn_margin_pct, m.sales_share_pct, m.technical_share_pct, m.company_share_pct,
         m.effective_from::text AS effective_from, m.effective_to::text AS effective_to
    FROM gw.margin_rules m JOIN gw.business_types bt ON bt.id = m.business_type_id`;

export async function adminRoutes(app: FastifyInstance) {
  /** Role codes the caller may hand out: only a SUPER_ADMIN can create another SUPER_ADMIN. */
  function assertMayGrantRole(ctx: AuthCtx, roleCode: string): void {
    if (roleCode === 'SUPER_ADMIN' && !isSuperAdmin(ctx)) {
      throw forbidden('Only a Super Administrator can give or take away the Super Administrator role.');
    }
  }

  async function userRoleCodes(c: pg.PoolClient, userId: string): Promise<string[]> {
    const r = await c.query(
      `SELECT r.code FROM gw.user_roles ur JOIN gw.roles r ON r.id = ur.role_id WHERE ur.user_id = $1`, [userId]);
    return r.rows.map((x: Row) => x.code as string);
  }

  /** Admins and other non-super users may not touch the accounts of Super Administrators. */
  async function assertMayManageUser(c: pg.PoolClient, ctx: AuthCtx, userId: string): Promise<void> {
    if (isSuperAdmin(ctx)) return;
    if ((await userRoleCodes(c, userId)).includes('SUPER_ADMIN')) {
      throw forbidden('Only a Super Administrator can change a Super Administrator account.');
    }
  }

  async function assignRole(
    c: pg.PoolClient, ctx: AuthCtx, userId: string, roleCode: string, companyId: string | null,
  ): Promise<void> {
    assertMayGrantRole(ctx, roleCode);
    const role = (await c.query(`SELECT id FROM gw.roles WHERE code = $1`, [roleCode])).rows[0] as Row | undefined;
    if (!role) throw badRequest('unknown_role', `There is no role called ${roleCode}. Choose one from the roles list.`);
    const ins = await c.query(
      `INSERT INTO gw.user_roles (user_id, role_id, company_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [userId, role.id, companyId]);
    if (ins.rowCount) {
      await audit(c, ctx, { entityType: 'user_roles', entityId: userId, action: 'grant', field: 'role', newValue: roleCode });
    }
  }

  /* ---------------- users ---------------- */

  app.get('/api/v1/admin/users', async (req) => {
    const ctx = req.auth;
    require_(ctx, 'admin.view');
    const f = parse(userListQuery, req.query, true);
    const offset = decodeCursor(f.cursor);

    const params: unknown[] = [];
    const where: string[] = [];
    if (f.active !== 'all') { params.push(f.active === 'true'); where.push(`u.is_active = $${params.length}`); }
    if (f.q) { params.push(like(f.q)); where.push(`(u.email ILIKE $${params.length} OR u.display_name ILIKE $${params.length})`); }
    if (f.role) {
      params.push(f.role);
      where.push(`EXISTS (SELECT 1 FROM gw.user_roles x JOIN gw.roles xr ON xr.id = x.role_id
                           WHERE x.user_id = u.id AND xr.code = $${params.length})`);
    }
    params.push(f.limit + 1, offset);

    const rows = await q(
      `${USER_SELECT} ${where.length ? 'AND ' + where.join(' AND ') : ''}
        ORDER BY u.display_name, u.id LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return envelope(rows, f.limit, offset);
  });

  app.post('/api/v1/admin/users', async (req, reply) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'admin.create');
    const b = parse(userCreate, req.body);
    for (const code of b.roleCodes) assertMayGrantRole(ctx, code);

    const row = await guarded(() => tx(txCtx(ctx, scope), async (c) => {
      const exists = await c.query(`SELECT 1 FROM gw.users WHERE lower(email) = $1`, [b.email]);
      if (exists.rowCount) throw conflict('duplicate', `A user with the email ${b.email} already exists. Search the user list and reactivate or edit that account.`);

      const u = (await c.query(
        `INSERT INTO gw.users (email, display_name, entra_object_id, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$4) RETURNING id`,
        [b.email, b.displayName, b.entraObjectId ?? null, ctx.userId])).rows[0] as Row;
      const userId = u.id as string;
      await audit(c, ctx, { entityType: 'users', entityId: userId, action: 'create' });

      if (b.employeeId) {
        const link = await c.query(
          `UPDATE gw.employees SET user_id = $1 WHERE id = $2 AND user_id IS NULL`, [userId, b.employeeId]);
        if (!link.rowCount) {
          throw conflict('employee_unavailable', 'That employee record does not exist or is already linked to another login. Pick a different employee.');
        }
        await audit(c, ctx, { entityType: 'employees', entityId: b.employeeId, action: 'update', field: 'user_id', newValue: userId });
      }
      for (const code of new Set(b.roleCodes)) await assignRole(c, ctx, userId, code, null);

      return (await c.query(`${USER_SELECT} AND u.id = $1`, [userId])).rows[0] as Row;
    }));
    reply.code(201);
    return { data: row };
  });

  app.patch('/api/v1/admin/users/:id', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'admin.edit');
    const { id } = parse(idParams, req.params);
    const b = parse(userPatch, req.body);
    if (Object.keys(b).length === 0) throw badRequest('nothing_to_update', 'Send isActive and/or displayName.');
    if (b.isActive === false && id === ctx.userId) {
      throw badRequest('cannot_deactivate_self', 'You cannot deactivate your own account. Ask another administrator to do it.');
    }

    const row = await guarded(() => tx(txCtx(ctx, scope), async (c) => {
      const before = (await c.query(
        `SELECT * FROM gw.users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id])).rows[0] as Row | undefined;
      if (!before) throw notFound('User');
      await assertMayManageUser(c, ctx, id);
      await applyUpdate(c, ctx, {
        table: 'users', entityType: 'users', before, stampUser: true,
        changes: { is_active: b.isActive, display_name: b.displayName },
      });
      return (await c.query(`${USER_SELECT} AND u.id = $1`, [id])).rows[0] as Row;
    }));
    return { data: row };
  });

  app.post('/api/v1/admin/users/:id/roles', async (req, reply) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'admin.edit');
    const { id } = parse(idParams, req.params);
    const b = parse(roleAssign, req.body);

    const row = await guarded(() => tx(txCtx(ctx, scope), async (c) => {
      const user = (await c.query(`SELECT id FROM gw.users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id])).rows[0];
      if (!user) throw notFound('User');
      await assertMayManageUser(c, ctx, id);
      await assignRole(c, ctx, id, b.roleCode, b.companyId ?? null);
      return (await c.query(`${USER_SELECT} AND u.id = $1`, [id])).rows[0] as Row;
    }));
    reply.code(201);
    return { data: row };
  });

  app.delete('/api/v1/admin/users/:id/roles/:roleCode', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'admin.edit');
    const { id, roleCode } = parse(roleParams, req.params);
    assertMayGrantRole(ctx, roleCode);
    if (roleCode === 'SUPER_ADMIN' && id === ctx.userId) {
      throw badRequest('cannot_remove_own_super_admin', 'You cannot remove your own Super Administrator role. Ask another Super Administrator to do it.');
    }

    const row = await guarded(() => tx(txCtx(ctx, scope), async (c) => {
      const user = (await c.query(`SELECT id FROM gw.users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id])).rows[0];
      if (!user) throw notFound('User');
      await assertMayManageUser(c, ctx, id);
      const del = await c.query(
        `DELETE FROM gw.user_roles ur USING gw.roles r
          WHERE ur.role_id = r.id AND ur.user_id = $1 AND r.code = $2`, [id, roleCode]);
      if (!del.rowCount) throw notFound('Role assignment');
      await audit(c, ctx, { entityType: 'user_roles', entityId: id, action: 'revoke', field: 'role', oldValue: roleCode });
      return (await c.query(`${USER_SELECT} AND u.id = $1`, [id])).rows[0] as Row;
    }));
    return { data: row };
  });

  /* ---------------- roles ---------------- */

  app.get('/api/v1/admin/roles', async (req) => {
    const ctx = req.auth;
    require_(ctx, 'admin.view');
    const rows = await q(
      `SELECT r.id, r.code, r.name, r.description, r.is_system,
              (SELECT count(*) FROM gw.role_permissions rp WHERE rp.role_id = r.id)::int AS permission_count,
              (SELECT count(*) FROM gw.user_roles ur JOIN gw.users u ON u.id = ur.user_id
                WHERE ur.role_id = r.id AND u.deleted_at IS NULL AND u.is_active)::int AS user_count
         FROM gw.roles r ORDER BY r.code`);
    return { data: rows };
  });

  /* ---------------- sensitive-field grants ---------------- */

  app.get('/api/v1/admin/grants', async (req) => {
    const ctx = req.auth;
    require_(ctx, 'admin.view');
    const f = parse(grantListQuery, req.query, true);
    const offset = decodeCursor(f.cursor);

    const params: unknown[] = [];
    const where: string[] = ['TRUE'];
    if (f.userId) { params.push(f.userId); where.push(`g.user_id = $${params.length}`); }
    const live = `(g.revoked_at IS NULL AND g.valid_from <= now() AND (g.valid_to IS NULL OR g.valid_to > now()))`;
    if (f.status === 'live') where.push(live);
    params.push(f.limit + 1, offset);

    const rows = await q(
      `SELECT g.id, g.user_id, u.display_name AS user_name, g.field_group, g.granted_by,
              gb.display_name AS granted_by_name, g.reason, g.valid_from, g.valid_to,
              g.revoked_at, g.revoked_by, ${live} AS is_live
         FROM gw.permission_grants g
         JOIN gw.users u ON u.id = g.user_id
         LEFT JOIN gw.users gb ON gb.id = g.granted_by
        WHERE ${where.join(' AND ')}
        ORDER BY g.valid_from DESC, g.id LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return envelope(rows, f.limit, offset);
  });

  app.post('/api/v1/admin/grants', async (req, reply) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'admin.create');
    if (!isSuperAdmin(ctx)) {
      throw forbidden('Only a Super Administrator can grant access to restricted fields such as cost, margin or credit.');
    }
    const b = parse(grantCreate, req.body);
    if (b.userId === ctx.userId) {
      throw badRequest('cannot_grant_self', 'You cannot grant restricted-field access to yourself. Ask another Super Administrator.');
    }
    let validTo: Date | null = null;
    if (b.validTo) {
      validTo = new Date(/^\d{4}-\d{2}-\d{2}$/.test(b.validTo) ? `${b.validTo}T23:59:59Z` : b.validTo);
      if (Number.isNaN(validTo.getTime()) || validTo.getTime() <= Date.now()) {
        throw badRequest('valid_to_in_past', 'The end date of a grant must be in the future.');
      }
    }

    const row = await guarded(() => tx(txCtx(ctx, scope), async (c) => {
      const target = (await c.query(
        `SELECT id FROM gw.users WHERE id = $1 AND is_active AND deleted_at IS NULL`, [b.userId])).rows[0];
      if (!target) throw notFound('User');

      const dup = await c.query(
        `SELECT 1 FROM gw.permission_grants
          WHERE user_id = $1 AND field_group = $2 AND revoked_at IS NULL
            AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())`, [b.userId, b.fieldGroup]);
      if (dup.rowCount) {
        throw conflict('grant_exists', 'This user already has a live grant for that field group. Revoke it first if you want to change its end date.');
      }

      const g = (await c.query(
        `INSERT INTO gw.permission_grants (user_id, field_group, granted_by, reason, valid_to)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [b.userId, b.fieldGroup, ctx.userId, b.reason, validTo])).rows[0] as Row;
      await audit(c, ctx, {
        entityType: 'permission_grants', entityId: String(g.id), action: 'grant', field: b.fieldGroup,
        newValue: `user ${b.userId} until ${validTo ? validTo.toISOString() : 'open-ended'}`,
        reason: b.reason,
      });
      return g;
    }));
    reply.code(201);
    return { data: row };
  });

  app.delete('/api/v1/admin/grants/:id', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'admin.edit');
    const { id } = parse(idParams, req.params);
    const { reason } = parse(grantRevokeQuery, req.query, true);

    const row = await guarded(() => tx(txCtx(ctx, scope), async (c) => {
      const g = (await c.query(`SELECT * FROM gw.permission_grants WHERE id = $1 FOR UPDATE`, [id])).rows[0] as Row | undefined;
      if (!g) throw notFound('Grant');
      if (g.revoked_at) throw conflict('already_revoked', 'This grant was already revoked.');
      const upd = (await c.query(
        `UPDATE gw.permission_grants SET revoked_at = now(), revoked_by = $2 WHERE id = $1 RETURNING *`,
        [id, ctx.userId])).rows[0] as Row;
      await audit(c, ctx, {
        entityType: 'permission_grants', entityId: id, action: 'revoke', field: String(g.field_group),
        oldValue: `user ${String(g.user_id)}`, reason: reason ?? 'Revoked by administrator',
      });
      return upd;
    }));
    return { data: row };
  });

  /* ---------------- settings ---------------- */

  app.get('/api/v1/admin/settings', async (req) => {
    const ctx = req.auth;
    require_(ctx, 'admin.view');
    // auth.* keys hold credential material (password hashes); they are never listed.
    const rows = await q(
      `SELECT key, value, updated_at, updated_by FROM gw.settings WHERE key NOT LIKE 'auth.%' ORDER BY key`);
    return { data: rows };
  });

  app.put('/api/v1/admin/settings/:key', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'admin.edit');
    const { key } = parse(settingKeyParams, req.params);
    if (key.startsWith('auth.')) {
      throw forbidden('Settings under auth. hold login credentials and cannot be edited here.');
    }
    const body = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body) || !('value' in body)) {
      throw badRequest('validation_failed', 'Send the new setting as { "value": ... }.');
    }
    const json = JSON.stringify((body as { value: unknown }).value);
    if (json === undefined) throw badRequest('validation_failed', 'The setting value must be valid JSON.');
    if (json.length > 100_000) throw badRequest('value_too_large', 'That setting value is too large. Keep it under 100 KB.');

    const row = await guarded(() => tx(txCtx(ctx, scope), async (c) => {
      const before = (await c.query(`SELECT key, value FROM gw.settings WHERE key = $1 FOR UPDATE`, [key])).rows[0] as Row | undefined;
      const res = (await c.query(
        `INSERT INTO gw.settings (key, value, updated_at, updated_by) VALUES ($1, $2::jsonb, now(), $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by
         RETURNING key, value, updated_at, updated_by`,
        [key, json, ctx.userId])).rows[0] as Row;
      await audit(c, ctx, {
        entityType: 'settings', action: before ? 'update' : 'create', field: key,
        oldValue: before ? JSON.stringify(before.value) : undefined, newValue: json,
      });
      return res;
    }));
    return { data: row };
  });

  /* ---------------- SLA rules ---------------- */

  app.get('/api/v1/admin/sla-rules', async (req) => {
    const ctx = req.auth;
    require_(ctx, 'admin.edit');
    const f = parse(slaListQuery, req.query, true);
    const params: unknown[] = [];
    const where: string[] = ['TRUE'];
    if (f.timerCode) { params.push(f.timerCode); where.push(`r.timer_code = $${params.length}`); }
    if (f.active !== 'all') { params.push(f.active === 'true'); where.push(`r.is_active = $${params.length}`); }
    const rows = await q(
      `${SLA_SELECT} WHERE ${where.join(' AND ')} ORDER BY r.timer_code, r.urgency, r.effective_from DESC`, params);
    return { data: rows };
  });

  app.put('/api/v1/admin/sla-rules/:id', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'admin.edit');
    const { id } = parse(idParams, req.params);
    const b = parse(slaPatch, req.body);
    if (Object.keys(b).length === 0) throw badRequest('nothing_to_update', 'Send at least one SLA field to change.');

    const row = await guarded(() => tx(txCtx(ctx, scope), async (c) => {
      const before = (await c.query(
        `SELECT id, timer_code, urgency, target_hours, calendar_id, warn_at_pct, escalate_role_ids,
                effective_from::text AS effective_from, effective_to::text AS effective_to, is_active
           FROM gw.sla_rules WHERE id = $1 FOR UPDATE`, [id])).rows[0] as Row | undefined;
      if (!before) throw notFound('SLA rule');
      if (b.effectiveTo && b.effectiveTo < String(before.effective_from)) {
        throw badRequest('invalid_dates', `The rule cannot end (${b.effectiveTo}) before it starts (${String(before.effective_from)}).`);
      }
      await applyUpdate(c, ctx, {
        table: 'sla_rules', entityType: 'sla_rules', before,
        casts: { escalate_role_ids: 'uuid[]', effective_to: 'date' },
        changes: {
          target_hours: b.targetHours, warn_at_pct: b.warnAtPct, calendar_id: b.calendarId,
          escalate_role_ids: b.escalateRoleIds, effective_to: b.effectiveTo, is_active: b.isActive,
        },
      });
      return (await c.query(`${SLA_SELECT} WHERE r.id = $1`, [id])).rows[0] as Row;
    }));
    return { data: row };
  });

  /* ---------------- margin rules ---------------- */

  app.get('/api/v1/admin/margin-rules', async (req) => {
    const ctx = req.auth;
    require_(ctx, 'admin.edit');
    const f = parse(marginListQuery, req.query, true);
    const params: unknown[] = [];
    const where: string[] = ['TRUE'];
    if (f.businessTypeId) { params.push(f.businessTypeId); where.push(`m.business_type_id = $${params.length}`); }
    const rows = await q(
      `${MARGIN_SELECT} WHERE ${where.join(' AND ')} ORDER BY bt.name, m.effective_from DESC`, params);
    return { data: rows };
  });

  app.put('/api/v1/admin/margin-rules/:id', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'admin.edit');
    const { id } = parse(idParams, req.params);
    const b = parse(marginPatch, req.body);
    if (Object.keys(b).length === 0) throw badRequest('nothing_to_update', 'Send at least one margin field to change.');

    const row = await guarded(() => tx(txCtx(ctx, scope), async (c) => {
      const before = (await c.query(
        `SELECT id, business_type_id, min_margin_pct, warn_margin_pct, sales_share_pct, technical_share_pct,
                company_share_pct, effective_from::text AS effective_from, effective_to::text AS effective_to
           FROM gw.margin_rules WHERE id = $1 FOR UPDATE`, [id])).rows[0] as Row | undefined;
      if (!before) throw notFound('Margin rule');

      // validate the rule as it will be after the change, not just the fields sent
      const sales = b.salesSharePct ?? Number(before.sales_share_pct);
      const technical = b.technicalSharePct ?? Number(before.technical_share_pct);
      const company = b.companySharePct ?? Number(before.company_share_pct);
      if (Math.round((sales + technical + company) * 10_000) !== 1_000_000) {
        throw badRequest('margin_shares_invalid',
          `Sales (${sales}), technical (${technical}) and company (${company}) shares must add up to exactly 100, but they add up to ${Math.round((sales + technical + company) * 10_000) / 10_000}. Adjust one of them.`,
          { sales, technical, company });
      }
      const min = b.minMarginPct !== undefined ? b.minMarginPct : (before.min_margin_pct as number | null);
      const warn = b.warnMarginPct !== undefined ? b.warnMarginPct : (before.warn_margin_pct as number | null);
      if (min != null && warn != null && warn < min) {
        throw badRequest('margin_thresholds_invalid',
          `The warning margin (${warn}%) cannot be lower than the minimum margin (${min}%). Raise the warning level or lower the minimum.`);
      }
      const from = b.effectiveFrom ?? String(before.effective_from);
      const to = b.effectiveTo !== undefined ? b.effectiveTo : (before.effective_to as string | null);
      if (to && to < from) {
        throw badRequest('invalid_dates', `The rule cannot end (${to}) before it starts (${from}).`);
      }

      await applyUpdate(c, ctx, {
        table: 'margin_rules', entityType: 'margin_rules', before,
        casts: { effective_from: 'date', effective_to: 'date' },
        changes: {
          min_margin_pct: b.minMarginPct, warn_margin_pct: b.warnMarginPct,
          sales_share_pct: b.salesSharePct, technical_share_pct: b.technicalSharePct,
          company_share_pct: b.companySharePct, effective_from: b.effectiveFrom, effective_to: b.effectiveTo,
        },
      });
      return (await c.query(`${MARGIN_SELECT} WHERE m.id = $1`, [id])).rows[0] as Row;
    }));
    return { data: row };
  });

  /* ---------------- audit log ---------------- */

  app.get('/api/v1/audit', async (req) => {
    const ctx = req.auth;
    require_(ctx, 'audit_log.view');
    const f = parse(auditQuery, req.query, true);

    const params: unknown[] = [];
    const where: string[] = ['TRUE'];
    if (f.entityType) { params.push(f.entityType); where.push(`a.entity_type = $${params.length}`); }
    if (f.entityId) { params.push(f.entityId); where.push(`a.entity_id = $${params.length}`); }
    if (f.actorUserId) { params.push(f.actorUserId); where.push(`a.actor_user_id = $${params.length}`); }
    if (f.action) { params.push(f.action); where.push(`a.action = $${params.length}::gw.audit_action`); }
    if (f.cursor) { params.push(f.cursor); where.push(`a.id < $${params.length}`); }
    params.push(f.limit + 1);

    const rows = await q(
      `SELECT a.id, a.occurred_at, a.actor_user_id, u.display_name AS actor_name, a.actor_role,
              a.entity_type, a.entity_id, a.action, a.field_name, a.old_value, a.new_value, a.reason
         FROM gw.audit_log a LEFT JOIN gw.users u ON u.id = a.actor_user_id
        WHERE ${where.join(' AND ')}
        ORDER BY a.id DESC LIMIT $${params.length}`, params);
    const more = rows.length > f.limit;
    const data = more ? rows.slice(0, f.limit) : rows;
    return { data, nextCursor: more ? String(data[data.length - 1].id) : null };
  });
}
