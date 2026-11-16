/**
 * Deal Desk — the marketing side of the house (cluster 15).
 *
 * The lead list, lead creation, the qualify/disqualify handoff and the campaign
 * board already live in sales.ts, because they share that module's cursor,
 * masking and enquiry-creation machinery. What was missing was everything the
 * Deal Desk screen needs to be usable rather than merely queryable: one lead in
 * full, the ability to work it (own it, score it, move it along), its activity
 * timeline, and the numbers across the top.
 *
 * Permissions are `leads.*`, `campaigns.*` and `activities.*` — their own
 * modules as of migration 004. Before that these routes borrowed `enquiries.*`,
 * which meant a marketer could not touch a lead without also holding the sales
 * pipeline.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { q, tx } from '../core/db.js';
import type { Row } from '../core/db.js';
import { require_, scopeFor, scopeSql } from '../core/rbac.js';
import { audit } from '../core/audit.js';
import { AppError, badRequest, notFound, conflict, gateBlocked } from '../core/errors.js';
import type { AuthCtx, Scope } from '../core/types.js';

/* ───────────────────────── constants ───────────────────────── */

const LEAD_STATUSES = ['New', 'Working', 'Nurturing', 'Qualified', 'Disqualified', 'Recycled'] as const;
/** A lead you can still act on. Qualified and Disqualified are terminal. */
const WORKABLE = ['New', 'Working', 'Nurturing', 'Recycled'];
const ACTIVITY_KINDS = ['Call', 'Email', 'Meeting', 'Note', 'Task', 'LinkedIn', 'WhatsApp', 'SiteVisit'] as const;

/* ───────────────────────── validation ───────────────────────── */

const uuid = z.string().uuid();
const text = (max = 255) => z.string().trim().min(1).max(max);
const idParam = z.object({ id: uuid });

const patchLeadBody = z
  .object({
    status: z.enum(['New', 'Working', 'Nurturing', 'Recycled']).optional(),
    ownerId: uuid.nullish(),
    score: z.number().int().min(0).max(100).optional(),
    contactName: text().nullish(),
    designation: text().nullish(),
    email: z.string().trim().email().max(255).nullish(),
    phone: text().nullish(),
    technologyId: uuid.nullish(),
    sbuId: uuid.nullish(),
    estimatedValue: z.number().nonnegative().max(1e14).nullish(),
    sourceDetail: z.string().trim().max(10_000).nullish(),
    consentMarketing: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Change at least one field' });

const activityBody = z.object({
  kind: z.enum(ACTIVITY_KINDS),
  subject: text(),
  body: z.string().trim().max(10_000).nullish(),
  outcome: text().nullish(),
  durationMins: z.number().int().min(0).max(24 * 60).nullish(),
  occurredAt: z.string().datetime({ offset: true }).optional(),
});

const summaryQuery = z.object({
  ownerId: uuid.optional(),
  campaignId: uuid.optional(),
});

/* ───────────────────────── helpers ───────────────────────── */

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

function pgToApp(e: unknown): unknown {
  if (e instanceof AppError) return e;
  const err = e as { code?: string; constraint?: string } | null;
  switch (err?.code) {
    case '23503':
      return badRequest(
        'invalid_reference',
        'A linked record (owner, technology, SBU or campaign) does not exist any more. Refresh the form and pick it again.',
      );
    case '23505':
      return conflict('duplicate', 'That record already exists. Refresh and try again.');
    case '22P02':
    case '22003':
      return badRequest('invalid_value', 'A number or ID in the request is malformed or out of range.');
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

/** Identical shape to the lead list in sales.ts, so one row type serves both screens. */
const LEAD_COLS = `
  l.id, l.lead_no, l.company_name, l.customer_id, l.contact_name, l.designation, l.email, l.phone, l.country,
  l.source, l.source_detail, l.estimated_value, l.currency, l.score, l.status::text AS status,
  l.campaign_id, camp.campaign_code, camp.name AS campaign_name,
  l.technology_id, t.name AS technology_name,
  COALESCE(l.sbu_id, t.sbu_id, tc.sbu_id) AS sbu_id, s.code AS sbu_code,
  l.owner_id, ow.full_name AS owner_name,
  floor(extract(epoch FROM (now() - l.created_at)) / 86400)::int AS age_days,
  l.qualified_at, l.qualified_enquiry_id, qe.enquiry_no AS qualified_enquiry_no,
  l.disqualify_reason, l.consent_marketing, l.consent_at, l.created_at`;
const LEAD_FROM = `
  FROM gw.leads l
  LEFT JOIN gw.campaigns camp ON camp.id = l.campaign_id
  LEFT JOIN gw.technologies t ON t.id = l.technology_id
  LEFT JOIN gw.technology_categories tc ON tc.id = t.category_id
  LEFT JOIN gw.sbus s ON s.id = COALESCE(l.sbu_id, t.sbu_id, tc.sbu_id)
  LEFT JOIN gw.employees ow ON ow.id = l.owner_id
  LEFT JOIN gw.enquiries qe ON qe.id = l.qualified_enquiry_id`;

/** Reads one lead inside the caller's scope. Out-of-scope reads 404, never 403:
 *  a record you may not see should not confirm that it exists. */
async function leadInScope(c: pg.PoolClient, ctx: AuthCtx, scope: Scope, id: string): Promise<Row> {
  const sc = scopeSql(ctx, scope, { alias: 'l', ownerCol: 'owner_id', sbuCol: 'sbu_id', entity: 'leads' }, 2);
  const r = await c.query(
    `SELECT ${LEAD_COLS} ${LEAD_FROM} WHERE l.id = $1 AND ${sc.sql}`,
    [id, ...sc.params],
  );
  if (!r.rows.length) throw notFound('Lead');
  return r.rows[0];
}

/* ───────────────────────── routes ───────────────────────── */

export async function dealDeskRoutes(app: FastifyInstance) {
  /* ═════════════ One lead, in full ═════════════ */

  app.get('/api/v1/leads/:id', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'leads.view');
    const { id } = parse(idParam, req.params);

    const sc = scopeSql(ctx, scope, { alias: 'l', ownerCol: 'owner_id', sbuCol: 'sbu_id', entity: 'leads' }, 2);
    const rows = await guard(() =>
      q(`SELECT ${LEAD_COLS} ${LEAD_FROM} WHERE l.id = $1 AND ${sc.sql}`, [id, ...sc.params]));
    if (!rows.length) throw notFound('Lead');
    const lead = rows[0];

    // The timeline is the point of the detail screen, so it ships with the record
    // rather than behind a second round trip.
    const canActivities = scopeFor(ctx, 'activities.view') !== null;
    const activities = canActivities
      ? await q(
          `SELECT a.id, a.kind::text AS kind, a.subject, a.body, a.outcome, a.duration_mins,
                  a.occurred_at, u.display_name AS performed_by_name
             FROM gw.activities a
             LEFT JOIN gw.users u ON u.id = a.performed_by
            WHERE a.lead_id = $1
            ORDER BY a.occurred_at DESC, a.created_at DESC
            LIMIT 200`, [id])
      : [];

    // Why the score is what it is — the table is append-only for exactly this.
    const scoreEvents = await q(
      `SELECT e.id, e.delta AS points, e.reason, e.scored_at AS created_at, r.name AS rule_name
         FROM gw.lead_score_events e
         LEFT JOIN gw.scoring_rules r ON r.id = e.rule_id
        WHERE e.lead_id = $1
        ORDER BY e.scored_at DESC
        LIMIT 50`, [id]);

    return { data: { ...lead, activities, score_events: scoreEvents } };
  });

  /* ═════════════ Work the lead ═════════════ */

  app.patch('/api/v1/leads/:id', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'leads.edit');
    const { id } = parse(idParam, req.params);
    const b = parse(patchLeadBody, req.body);

    return guard(() =>
      tx(txCtx(ctx, scope), async (c) => {
        const before = await leadInScope(c, ctx, scope, id);
        if (!WORKABLE.includes(before.status)) {
          throw gateBlocked(
            before.status === 'Qualified'
              ? 'This lead has already been qualified. Work the enquiry it became instead.'
              : 'A disqualified lead cannot be edited. Recycle it first if it is worth another look.',
          );
        }

        // A scope that is not 'A' may not hand a lead to someone else: that is a
        // reassignment, and reassignment is a manager's call.
        if (b.ownerId !== undefined && b.ownerId !== before.owner_id && scope !== 'A' && scope !== 'T') {
          throw badRequest('cannot_reassign', 'You can only change the owner of leads within your team. Ask a manager to reassign it.');
        }

        const sets: string[] = [];
        const params: any[] = [];
        const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };

        if (b.status !== undefined) set('status', b.status);
        if (b.ownerId !== undefined) set('owner_id', b.ownerId);
        if (b.contactName !== undefined) set('contact_name', b.contactName);
        if (b.designation !== undefined) set('designation', b.designation);
        if (b.email !== undefined) set('email', b.email);
        if (b.phone !== undefined) set('phone', b.phone);
        if (b.technologyId !== undefined) set('technology_id', b.technologyId);
        if (b.sbuId !== undefined) set('sbu_id', b.sbuId);
        if (b.estimatedValue !== undefined) set('estimated_value', b.estimatedValue);
        if (b.sourceDetail !== undefined) set('source_detail', b.sourceDetail);
        if (b.consentMarketing !== undefined) {
          set('consent_marketing', b.consentMarketing);
          // The timestamp is the evidence; it is set when consent is given and
          // left in place as a record when it is withdrawn.
          if (b.consentMarketing) sets.push('consent_at = now()');
        }
        if (b.score !== undefined) set('score', b.score);

        sets.push('updated_at = now()', 'row_version = row_version + 1');
        params.push(id);
        await c.query(`UPDATE gw.leads SET ${sets.join(', ')} WHERE id = $${params.length}`, params);

        // A manual score change is a scoring event like any other, so the trail
        // explains the number even when a person set it by hand.
        if (b.score !== undefined && b.score !== before.score) {
          await c.query(
            `INSERT INTO gw.lead_score_events (lead_id, delta, reason) VALUES ($1,$2,$3)`,
            [id, b.score - Number(before.score ?? 0), `Set to ${b.score} by ${ctx.displayName}`]);
        }

        for (const [field, value] of Object.entries(b)) {
          await audit(c, ctx, {
            entityType: 'leads', entityId: id, action: 'update',
            field, oldValue: (before as Row)[field] ?? null, newValue: value as unknown,
          });
        }
        return { data: await leadInScope(c, ctx, scope, id) };
      }));
  });

  /* ═════════════ Timeline ═════════════ */

  app.post('/api/v1/leads/:id/activities', async (req, reply) => {
    const ctx = req.auth;
    const leadScope = require_(ctx, 'leads.view');
    require_(ctx, 'activities.create');
    const { id } = parse(idParam, req.params);
    const b = parse(activityBody, req.body);

    const row = await guard(() =>
      tx(txCtx(ctx, leadScope), async (c) => {
        const lead = await leadInScope(c, ctx, leadScope, id);
        const ins = await c.query(
          `INSERT INTO gw.activities
             (kind, entity_type, entity_id, lead_id, customer_id, subject, body, outcome,
              duration_mins, occurred_at, performed_by)
           VALUES ($1,'lead',$2,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz, now()),$9)
           RETURNING id, kind::text AS kind, subject, body, outcome, duration_mins, occurred_at`,
          [b.kind, id, lead.customer_id ?? null, b.subject, b.body ?? null, b.outcome ?? null,
           b.durationMins ?? null, b.occurredAt ?? null, ctx.userId]);

        // Touching a lead moves it out of the New pile — recording the call is
        // the signal that someone is working it, so the status follows the work
        // rather than waiting for a second click.
        if (lead.status === 'New') {
          await c.query(`UPDATE gw.leads SET status = 'Working', updated_at = now() WHERE id = $1`, [id]);
        }
        await audit(c, ctx, { entityType: 'activities', entityId: ins.rows[0].id, action: 'create' });
        return { ...ins.rows[0], performed_by_name: ctx.displayName };
      }));

    reply.code(201);
    return { data: row };
  });

  /* ═════════════ The numbers across the top ═════════════ */

  app.get('/api/v1/dealdesk/summary', async (req) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'leads.view');
    const qs = parse(summaryQuery, req.query);

    const sc = scopeSql(ctx, scope, { alias: 'l', ownerCol: 'owner_id', sbuCol: 'sbu_id', entity: 'leads' }, 1);
    const params: any[] = [...sc.params];
    const w: string[] = [sc.sql];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (qs.ownerId) w.push(`l.owner_id = ${p(qs.ownerId)}`);
    if (qs.campaignId) w.push(`l.campaign_id = ${p(qs.campaignId)}`);

    // One pass, computed in SQL. Conversion is qualified / everything that
    // reached a terminal state — a lead still sitting in the inbox has not
    // failed to convert yet, and counting it as a miss flatters nothing.
    const rows = await guard(() =>
      q(`SELECT
             COUNT(*) FILTER (WHERE l.status IN ('New','Working','Nurturing','Recycled'))::int AS open_leads,
             COUNT(*) FILTER (WHERE l.status = 'New')::int                                     AS untouched,
             COUNT(*) FILTER (WHERE l.status = 'Qualified')::int                               AS qualified,
             COUNT(*) FILTER (WHERE l.status = 'Disqualified')::int                            AS disqualified,
             COUNT(*) FILTER (WHERE l.status = 'New'
                                AND l.created_at < now() - interval '3 days')::int              AS stale,
             COALESCE(SUM(l.estimated_value) FILTER
                      (WHERE l.status IN ('New','Working','Nurturing','Recycled')), 0)          AS open_value,
             ROUND(AVG(l.score) FILTER
                   (WHERE l.status IN ('New','Working','Nurturing','Recycled')), 1)             AS avg_score,
             CASE WHEN COUNT(*) FILTER (WHERE l.status IN ('Qualified','Disqualified')) > 0
                  THEN ROUND(100.0 * COUNT(*) FILTER (WHERE l.status = 'Qualified')
                             / COUNT(*) FILTER (WHERE l.status IN ('Qualified','Disqualified')), 1)
             END                                                                                AS conversion_pct
           FROM gw.leads l
          WHERE ${w.join(' AND ')}`, params));

    return { data: rows[0] };
  });

  /* ═════════════ Reference data for the filters ═════════════ */

  app.get('/api/v1/dealdesk/sources', async (req) => {
    require_(req.auth, 'leads.view');
    const rows = await q(
      `SELECT l.source, COUNT(*)::int AS leads
         FROM gw.leads l
        WHERE l.source IS NOT NULL
        GROUP BY l.source
        ORDER BY leads DESC, l.source
        LIMIT 50`);
    return { data: rows };
  });
}

export { LEAD_STATUSES, ACTIVITY_KINDS };
