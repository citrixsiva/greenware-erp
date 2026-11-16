/**
 * Lead scoring: the fit rules, the reversal when a fact stops being true, and
 * the behaviour events that are only awarded when someone says they happened.
 *
 * The expected totals are hand-checked against the weights seeded in
 * 002_marketing.sql and 004_dealdesk.sql, not recomputed from the rules table —
 * a test that re-derives its expectation from the same source as the code
 * agrees with a bug as readily as with correct behaviour.
 *
 *   FIT_EMAIL      +5   email present
 *   FIT_PHONE      +5   phone present
 *   FIT_SENIORITY +15   designation matches the decision-maker pattern
 *   FIT_VALUE     +20   estimated value >= 100,000
 *   FIT_EXISTING  +20   linked to an existing customer
 *   BEH_REPLY     +25   replied to a sequence
 *   BEH_WEBINAR   +22   attended a webinar
 */
import './env.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as H from './helpers.js';

const MARKETER = 'rock@greenware.ae';

let token: string;

/** A lead with none of the scored facts set: the baseline is zero. */
async function bareLead(suffix: string, extra: Record<string, unknown> = {}) {
  const r = await H.post<{ data: any }>('/api/v1/leads', token, {
    companyName: `Scoring test ${H.STAMP}-${suffix}`,
    ...extra,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data;
}

const scoreOf = async (id: string) =>
  Number((await H.get<{ data: any }>(`/api/v1/leads/${id}`, token)).body.data.score);

describe('lead scoring', () => {
  before(async () => {
    token = await H.login(MARKETER);
  });
  after(H.closePool);

  test('a lead with nothing known to the rules scores zero', async () => {
    const lead = await bareLead('bare');
    assert.equal(Number(lead.score), 0);
  });

  test('fit rules are applied at creation', async () => {
    const lead = await bareLead('full', {
      email: `scoring.${H.STAMP}@example.com`,   // +5
      phone: '+971500000001',                     // +5
      designation: 'Head of Infrastructure',      // +15
      estimatedValue: 250_000,                    // +20
    });
    assert.equal(Number(lead.score), 45);
  });

  test('the value rule is a threshold, not a slope', async () => {
    const under = await bareLead('under', { estimatedValue: 99_999.99 });
    assert.equal(Number(under.score), 0);
    const at = await bareLead('at', { estimatedValue: 100_000 });
    assert.equal(Number(at.score), 20);
  });

  test('the seniority pattern is case-insensitive and matches inside a title', async () => {
    const lower = await bareLead('lower', { designation: 'group head of it' });
    assert.equal(Number(lower.score), 15);
    const none = await bareLead('none', { designation: 'Systems Administrator' });
    assert.equal(Number(none.score), 0);
  });

  test('editing a lead re-evaluates it, and a fact that stops being true is reversed', async () => {
    const lead = await bareLead('edit', { estimatedValue: 400_000 });
    assert.equal(Number(lead.score), 20);

    // A detail captured later counts the same as one captured at the start.
    let r = await H.patch<{ data: any }>(`/api/v1/leads/${lead.id}`, token, { designation: 'CTO' });
    assert.equal(r.status, 200);
    assert.equal(Number(r.body.data.score), 35);

    // The deal turns out to be far smaller: the award is taken back.
    r = await H.patch<{ data: any }>(`/api/v1/leads/${lead.id}`, token, { estimatedValue: 5_000 });
    assert.equal(Number(r.body.data.score), 15);

    // ...and awarded again if it grows back. A reversal is not a one-way door.
    r = await H.patch<{ data: any }>(`/api/v1/leads/${lead.id}`, token, { estimatedValue: 900_000 });
    assert.equal(Number(r.body.data.score), 35);
  });

  test('the score events explain the number, including the reversal', async () => {
    const lead = await bareLead('trail', { estimatedValue: 500_000 });
    await H.patch(`/api/v1/leads/${lead.id}`, token, { estimatedValue: 1_000 });

    const events = await H.sql<{ delta: number; reason: string }>(
      `SELECT delta, reason FROM gw.lead_score_events WHERE lead_id = $1 ORDER BY scored_at, delta DESC`,
      [lead.id]);
    assert.equal(events.length, 2, 'the award and its reversal are both kept');
    assert.equal(Number(events[0].delta), 20);
    assert.equal(Number(events[1].delta), -20);
    assert.match(events[1].reason, /No longer true/);
  });

  test('a behaviour event is awarded only when the activity says it happened', async () => {
    const lead = await bareLead('behaviour');

    // An ordinary logged email is not evidence that the customer replied.
    let r = await H.post(`/api/v1/leads/${lead.id}/activities`, token, {
      kind: 'Email', subject: 'Sent the intro deck',
    });
    assert.equal(r.status, 201);
    assert.equal(await scoreOf(lead.id), 0);

    r = await H.post(`/api/v1/leads/${lead.id}/activities`, token, {
      kind: 'Email', subject: 'They came back to us', behaviourEvent: 'email_replied',
    });
    assert.equal(r.status, 201);
    assert.equal(await scoreOf(lead.id), 25);
  });

  test('behaviour accumulates, because it is history rather than a state', async () => {
    const lead = await bareLead('repeat');
    for (const subject of ['First webinar', 'Second webinar']) {
      await H.post(`/api/v1/leads/${lead.id}/activities`, token, {
        kind: 'Meeting', subject, behaviourEvent: 'webinar_attended',
      });
    }
    assert.equal(await scoreOf(lead.id), 44, 'two webinars at +22 each');
  });

  test('a page view is awarded once however many times it is reported', async () => {
    const lead = await bareLead('pageview');
    for (let i = 0; i < 3; i += 1) {
      await H.post(`/api/v1/leads/${lead.id}/activities`, token, {
        kind: 'Note', subject: `Visit ${i}`, behaviourEvent: 'page_view', behaviourValue: '/pricing',
      });
    }
    assert.equal(await scoreOf(lead.id), 14, 'BEH_PRICING once, not three times');
  });

  test('a page view only counts for the page its rule names', async () => {
    const lead = await bareLead('otherpage');
    await H.post(`/api/v1/leads/${lead.id}/activities`, token, {
      kind: 'Note', subject: 'Read the blog', behaviourEvent: 'page_view', behaviourValue: '/blog',
    });
    assert.equal(await scoreOf(lead.id), 0);
  });

  test('an unreported behaviour rule never fires on its own', async () => {
    // BEH_STALE describes a state nobody reports and has no sweep behind it.
    // It must stay dormant rather than quietly docking every lead 15 points.
    const lead = await bareLead('stale');
    await H.patch(`/api/v1/leads/${lead.id}`, token, { phone: '+971500000002' });
    assert.equal(await scoreOf(lead.id), 5, 'only the phone rule fired');
  });

  test('a rule whose field no leads carry stays dormant instead of erroring', async () => {
    // FIT_SIZE reads employee_band, which gw.leads has never had a column for.
    const rule = await H.sql1<{ weight: number }>(
      `SELECT weight FROM gw.scoring_rules WHERE code = 'FIT_SIZE' AND is_active`);
    assert.ok(rule, 'FIT_SIZE is still seeded and active');
    const lead = await bareLead('dormant', { email: `size.${H.STAMP}@example.com` });
    assert.equal(Number(lead.score), 5, 'the email rule only — FIT_SIZE could not be evaluated');
  });

  test('the score is derived, so it cannot be set by hand through the API', async () => {
    const lead = await bareLead('manual');
    const r = await H.patch(`/api/v1/leads/${lead.id}`, token, { score: 99 });
    assert.equal(r.status, 400, 'score is not an accepted field');
    assert.equal(await scoreOf(lead.id), 0);
  });
});
