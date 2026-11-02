# Greenware ERP — implementation conventions

Stack: Node 22, TypeScript (ESM, NodeNext), Fastify 5, PostgreSQL 16, raw SQL via `pg`.
All DB objects live in schema `gw`. Always schema-qualify: `gw.enquiries`.

## Imports (ESM — always use the `.js` extension)
```ts
import { q, q1, tx } from '../core/db.js';
import { require_, scopeFor, scopeSql, mask, maskAll } from '../core/rbac.js';
import { audit } from '../core/audit.js';
import { badRequest, notFound, forbidden, conflict, gateBlocked } from '../core/errors.js';
import { nextNumber } from '../core/numbering.js';
import { startTimer, stopTimer, workingHoursBetween, slaState } from '../core/sla.js';
import type { AuthCtx } from '../core/types.js';
```

## Route module shape
Every module exports one Fastify plugin:
```ts
import type { FastifyInstance } from 'fastify';
export async function salesRoutes(app: FastifyInstance) {
  app.get('/api/v1/enquiries', async (req) => { ... });
}
```
`req.auth` is the `AuthCtx` (already populated by the auth plugin). Never trust the body for identity.

## The three non-negotiables
1. **Permission first.** Every handler starts with `const scope = require_(req.auth, 'enquiries.view')`.
   Write actions use `.create` / `.edit` / `.approve` / `.export`.
2. **Scope in the query, never after it.** Use `scopeSql(ctx, scope, {alias, ownerCol, sbuCol, entity}, nextParamIndex)`
   and AND its `sql` into the WHERE clause, appending its `params`.
3. **Mask on the way out.** Any row from a table in `FIELD_MAP` goes through `mask(ctx, 'table_name', row, isOwn)`
   or `maskAll(...)`. A masked field must be ABSENT from the payload, not null.

## Mutations
All writes go through `tx()`, which sets the `app.*` settings the DB triggers and RLS read:
```ts
return tx({ userId: ctx.userId, employeeId: ctx.employeeId, sbuId: ctx.sbuIds[0], scope },
  async (c) => {
    const n = await nextNumber(c, 'enquiry', companyId, 'ENQ');
    const row = (await c.query(`INSERT INTO gw.enquiries (...) VALUES (...) RETURNING *`, [...])).rows[0];
    await audit(c, ctx, { entityType: 'enquiries', entityId: row.id, action: 'create' });
    return row;
  });
```
Field-level change rows are written by database triggers — do not duplicate them.

## Errors
Throw the helpers from `core/errors.js`. Use `gateBlocked()` for workflow gates
(no PO → cannot win; no sign-off → cannot close; frozen version → cannot edit).
Messages are addressed to the user and say what to do next, never "invalid input".

## Validation
`zod` schemas declared at the top of the module; parse `req.body` / `req.query` and let
the error handler turn failures into a 400 with field details.

## House rules
- Money is `numeric` and arrives as a JS number (parsers are already configured). Never use floats for arithmetic you then store — let Postgres compute where it can.
- Derived values (margin, consumed days, ageing, completion %) are COMPUTED in SQL or by generated columns. Never accept them from the client.
- Status values are enums in the DB. Never accept free text.
- Append-only tables (`cost_price_points`, `sell_price_points`, `quotation_versions`, `audit_log`, `stage_history`) are never UPDATEd or DELETEd by application code.
- List endpoints: `?limit=&cursor=&q=&sort=` with a `{ data, nextCursor }` envelope. Default limit 50, max 200.
- Single records: `{ data }`. Errors: `{ error: { code, message, details? } }`.

## Key decisions already made (do not re-litigate)
- OD-11: one invoicing entity, Greenware Technologies LLC. `company_id` still on every row.
- OD-06: margin split per business type lives in `gw.margin_rules` (sales/technical/company shares);
  a per-deal exception goes in `gw.margin_overrides` with a mandatory reason and an approval.
- OD-09: `min_margin_pct` is a hard floor (3%); `warn_margin_pct` is what actually fires the approval chain.
- OD-10: there is no engineer day rate. `technical_estimates.estimated_service_cost` is ENTERED, not derived.
- OD-18: the Dubai calendar governs every SLA clock.
- OD-01: a person can sit in more than one SBU — read `gw.employee_sbu_memberships`, not `employees.sbu_id`.
