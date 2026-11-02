import type pg from 'pg';
import type { AuthCtx } from './types.js';

type Action = 'create'|'update'|'soft_delete'|'approve'|'reject'|'override'|'grant'|'revoke'|'export'|'download'|'login'|'login_failed';

/**
 * Application-level audit for things the database triggers cannot see:
 * approvals, overrides, exports, logins, and permission grants.
 * Field-level change rows are written by the schema's own triggers.
 */
export async function audit(
  client: pg.PoolClient,
  ctx: Pick<AuthCtx, 'userId' | 'roles'> | null,
  e: { entityType: string; entityId?: string | null; action: Action; field?: string;
       oldValue?: unknown; newValue?: unknown; reason?: string; ip?: string | null },
) {
  await client.query(
    `INSERT INTO gw.audit_log
       (actor_user_id, actor_role, entity_type, entity_id, action, field_name,
        old_value, new_value, reason, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [ctx?.userId ?? null, ctx?.roles?.[0] ?? null, e.entityType, e.entityId ?? null, e.action,
     e.field ?? null,
     e.oldValue === undefined ? null : String(e.oldValue),
     e.newValue === undefined ? null : String(e.newValue),
     e.reason ?? null, e.ip ?? null],
  );
}
