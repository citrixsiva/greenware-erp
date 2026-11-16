/**
 * Lead scoring.
 *
 * `gw.scoring_rules` holds declarative conditions, `gw.lead_score_events` the
 * append-only trail of what each rule awarded, and `gw.leads.score` the sum.
 * The schema and the Deal Desk screen were both built around that; what was
 * missing was anything that evaluated a rule, so every lead sat at 0 and the
 * screen's promise that "leads score themselves" was not true.
 *
 * Two kinds of rule live in the same table, told apart by their condition:
 *
 *   {"op": ..., "field": ...}   a FACT about the lead as it stands now —
 *                               re-evaluated on every create and edit.
 *   {"event": "..."}            something that HAPPENED — awarded once, when
 *                               that event is reported, never re-derived.
 *
 * Fact rules are re-evaluated rather than recomputed destructively. The events
 * table is append-only (nothing may update or delete a row), and it is also
 * what the lead timeline reads, so a rule that stops holding gets a
 * compensating negative event rather than having its original quietly removed.
 * Deleting the history would make the score right and the story wrong.
 */
import type pg from 'pg';
import type { AuthCtx } from './types.js';

export type ScoringFacts = Record<string, unknown>;

interface Rule {
  id: string;
  code: string;
  name: string;
  dimension: string;
  condition: Record<string, any>;
  weight: number;
}

/** A rule whose condition names an event is awarded by reportLeadEvent, not here. */
const isFactRule = (r: Rule) => typeof r.condition?.op === 'string';

/**
 * Evaluate one condition against the lead's facts.
 *
 * An unknown operator, or a field the lead does not carry, is NOT an error and
 * NOT a zero — it is "this rule does not apply". FIT_SIZE reads
 * `employee_band`, which no lead has ever had a column for; it should sit
 * dormant until someone adds one, not fire or crash.
 */
function holds(cond: Record<string, any>, facts: ScoringFacts): boolean | null {
  const { op, field, value } = cond;
  if (typeof field !== 'string' || !(field in facts)) return null;
  const v = facts[field];

  switch (op) {
    case 'present':
      return typeof v === 'string' ? v.trim().length > 0 : v != null;
    case 'not_null':
      return v != null;
    case 'eq':
      return v === value;
    case 'in':
      return Array.isArray(value) && v != null && value.includes(v);
    case 'gte':
      return v != null && Number.isFinite(Number(v)) && Number(v) >= Number(value);
    case 'lte':
      return v != null && Number.isFinite(Number(v)) && Number(v) <= Number(value);
    case 'matches': {
      if (typeof v !== 'string' || typeof value !== 'string') return null;
      // The seeded patterns carry an inline (?i) flag, which JavaScript does
      // not support — lift it to the RegExp flags instead of letting the
      // constructor throw and take the whole save down with it.
      const inline = value.startsWith('(?i)');
      try {
        return new RegExp(inline ? value.slice(4) : value, inline ? 'i' : '').test(v);
      } catch {
        return null;
      }
    }
    // in_sbu: the technology's SBU, resolved into the facts as `sbu_code`.
    case 'in_sbu':
      return Array.isArray(value) && facts.sbu_code != null && value.includes(facts.sbu_code);
    default:
      return null;
  }
}

/** Everything the seeded rules can ask about a lead, in one flat object. */
async function factsFor(c: pg.PoolClient, leadId: string): Promise<ScoringFacts | null> {
  const r = await c.query(
    `SELECT l.email, l.phone, l.designation, l.customer_id, l.estimated_value,
            l.consent_marketing, l.technology_id, l.country, l.source,
            cu.industry,
            COALESCE(s.code, ts.code, tcs.code) AS sbu_code
       FROM gw.leads l
       LEFT JOIN gw.customers cu ON cu.id = l.customer_id
       LEFT JOIN gw.sbus s ON s.id = l.sbu_id
       LEFT JOIN gw.technologies t ON t.id = l.technology_id
       LEFT JOIN gw.sbus ts ON ts.id = t.sbu_id
       LEFT JOIN gw.technology_categories tc ON tc.id = t.category_id
       LEFT JOIN gw.sbus tcs ON tcs.id = tc.sbu_id
      WHERE l.id = $1`, [leadId]);
  return r.rows[0] ?? null;
}

async function activeRules(c: pg.PoolClient): Promise<Rule[]> {
  const r = await c.query(
    `SELECT id, code, name, dimension, condition, weight
       FROM gw.scoring_rules
      WHERE is_active AND effective_from <= CURRENT_DATE
      ORDER BY dimension, code`);
  return r.rows as Rule[];
}

async function sumScore(c: pg.PoolClient, leadId: string): Promise<number> {
  const r = await c.query(
    `SELECT COALESCE(SUM(delta), 0)::int AS score FROM gw.lead_score_events WHERE lead_id = $1`, [leadId]);
  return Number(r.rows[0].score);
}

/**
 * Re-evaluate every fact rule for a lead and bring `leads.score` into line.
 * Safe to call on create and after any edit; it only writes when something
 * actually changed. Returns the lead's new score.
 */
export async function rescoreLead(c: pg.PoolClient, ctx: AuthCtx | null, leadId: string): Promise<number> {
  const facts = await factsFor(c, leadId);
  if (!facts) return 0;

  const rules = (await activeRules(c)).filter(isFactRule);

  // The net position per rule so far: a rule awarded and later reversed nets
  // to zero and may be awarded again if it becomes true once more.
  const prior = await c.query(
    `SELECT rule_id, COALESCE(SUM(delta), 0)::int AS net
       FROM gw.lead_score_events
      WHERE lead_id = $1 AND rule_id IS NOT NULL
      GROUP BY rule_id`, [leadId]);
  const net = new Map<string, number>(prior.rows.map((r: any) => [r.rule_id as string, Number(r.net)]));

  for (const rule of rules) {
    const now = holds(rule.condition, facts);
    if (now === null) continue;              // does not apply to this lead
    const awarded = (net.get(rule.id) ?? 0) !== 0;

    if (now && !awarded) {
      await c.query(
        `INSERT INTO gw.lead_score_events (lead_id, rule_id, delta, reason)
         VALUES ($1,$2,$3,$4)`,
        [leadId, rule.id, rule.weight, rule.name]);
    } else if (!now && awarded) {
      await c.query(
        `INSERT INTO gw.lead_score_events (lead_id, rule_id, delta, reason)
         VALUES ($1,$2,$3,$4)`,
        [leadId, rule.id, -(net.get(rule.id) ?? rule.weight), `No longer true: ${rule.name}`]);
    }
  }

  const score = await sumScore(c, leadId);
  await c.query(
    `UPDATE gw.leads SET score = $2, updated_at = now(), row_version = row_version + 1
      WHERE id = $1 AND score IS DISTINCT FROM $2`, [leadId, score]);
  return score;
}

/**
 * Award a behaviour rule, once, for something that happened — a form
 * submission, a webinar attended, a reply to a sequence.
 *
 * Behaviour is history: attending two webinars is two events, so unlike a fact
 * rule this does not check whether the rule has fired before. The exception is
 * BEH_STALE, which describes a state rather than an act and would otherwise
 * stack every time the sweep ran; `once` covers that.
 */
export async function reportLeadEvent(
  c: pg.PoolClient, leadId: string, event: string,
  opts: { value?: string; once?: boolean } = {},
): Promise<number> {
  const rules = (await activeRules(c)).filter((r) => r.condition?.event === event);
  for (const rule of rules) {
    // A rule may pin itself to one value of the event, e.g. the pricing page.
    if (rule.condition.value !== undefined && opts.value !== undefined
        && String(rule.condition.value) !== String(opts.value)) continue;
    if (opts.once) {
      const seen = await c.query(
        `SELECT 1 FROM gw.lead_score_events WHERE lead_id = $1 AND rule_id = $2 LIMIT 1`, [leadId, rule.id]);
      if (seen.rows.length) continue;
    }
    await c.query(
      `INSERT INTO gw.lead_score_events (lead_id, rule_id, delta, reason) VALUES ($1,$2,$3,$4)`,
      [leadId, rule.id, rule.weight, rule.name]);
  }

  const score = await sumScore(c, leadId);
  await c.query(
    `UPDATE gw.leads SET score = $2, updated_at = now(), row_version = row_version + 1
      WHERE id = $1 AND score IS DISTINCT FROM $2`, [leadId, score]);
  return score;
}

/**
 * The behaviour events a person (or an integration) can report against a lead.
 *
 * Deliberately explicit rather than inferred from the activity kind. A logged
 * "Email" is as often one we sent as one they answered, and awarding BEH_REPLY
 * (+25) for every email in the timeline would inflate every score in the
 * inbox. Whoever logs the activity says what it evidenced, or says nothing.
 *
 * `inactive_days` (BEH_STALE, -15) is absent on purpose: it describes a state
 * nobody reports, and wants a scheduled sweep. The rule sits dormant until
 * that exists rather than being faked from an activity.
 */
export const BEHAVIOUR_EVENTS = ['email_replied', 'webinar_attended', 'form_submission', 'page_view'] as const;
export type BehaviourEvent = (typeof BEHAVIOUR_EVENTS)[number];
