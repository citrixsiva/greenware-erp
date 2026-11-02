/**
 * The working-hours TAT engine in core/sla.ts, against the seeded Dubai calendar
 * (OD-18: Dubai governs every clock — Mon–Fri, 09:00–18:00 local, UAE holidays).
 *
 * Dubai is UTC+4 all year, so 09:00–18:00 local is 05:00–14:00Z. Every instant
 * below is written in UTC with the local wall-clock time in the test name, so a
 * timezone slip in the engine shows up as a wrong number rather than passing.
 */
import './env.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { workingHoursBetween, slaState, loadCalendar, stopTimer } from '../core/sla.js';
import * as H from './helpers.js';

const CAL = 'Dubai';
const close = (got: number, want: number, what: string) =>
  assert.ok(Math.abs(got - want) < 0.02, `${what}: got ${got}h, expected ${want}h`);

before(async () => {
  const { cal, holidays } = await loadCalendar(CAL);
  assert.equal(cal.timezone, 'Asia/Dubai');
  assert.deepEqual(cal.working_days, [1, 2, 3, 4, 5], 'Dubai works Monday to Friday');
  assert.equal(cal.day_start.slice(0, 5), '09:00');
  assert.equal(cal.day_end.slice(0, 5), '18:00');
  assert.ok(holidays.has('2026-12-01'), 'the seeded UAE holidays must be loaded');
});

after(() => H.closePool());

/* ═════════════════════════ 1. the headline case ═════════════════════════ */

describe('working hours across a weekend', () => {
  test('raised 16:00 Thursday, answered 09:30 Sunday = 11h (2h Thu + 9h Fri, weekend excluded)', async () => {
    // Thu 2026-11-05 16:00 Dubai = 12:00Z; Sun 2026-11-08 09:30 Dubai = 05:30Z.
    // Thursday contributes 16:00→18:00 = 2h, Friday a full 9h, Saturday and
    // Sunday are outside working_days and contribute nothing.
    const got = await workingHoursBetween(
      new Date('2026-11-05T12:00:00Z'), new Date('2026-11-08T05:30:00Z'), CAL);
    close(got, 11, 'Thu 16:00 → Sun 09:30');
  });

  test('elapsed wall-clock time is not the answer: the same span is 65.5 real hours', async () => {
    const from = new Date('2026-11-05T12:00:00Z');
    const to = new Date('2026-11-08T05:30:00Z');
    const wall = (to.getTime() - from.getTime()) / 3_600_000;
    close(wall, 65.5, 'wall clock');
    const working = await workingHoursBetween(from, to, CAL);
    assert.ok(working < wall / 5, 'the SLA clock must not count the weekend or the nights');
  });

  test('raised Friday 17:00, answered Monday 09:30 = 1.5h', async () => {
    const got = await workingHoursBetween(
      new Date('2026-11-06T13:00:00Z'), new Date('2026-11-09T05:30:00Z'), CAL);
    close(got, 1.5, 'Fri 17:00 → Mon 09:30');
  });

  test('a span entirely inside the weekend is zero', async () => {
    const got = await workingHoursBetween(
      new Date('2026-11-07T06:00:00Z'), new Date('2026-11-08T06:00:00Z'), CAL);
    close(got, 0, 'Sat → Sun');
  });

  test('raised on Saturday, the clock starts at Monday 09:00', async () => {
    // Sat 14:00 Dubai → Mon 10:00 Dubai is one working hour.
    const got = await workingHoursBetween(
      new Date('2026-11-07T10:00:00Z'), new Date('2026-11-09T06:00:00Z'), CAL);
    close(got, 1, 'Sat 14:00 → Mon 10:00');
  });
});

/* ═════════════════════════ 2. the working window ═════════════════════════ */

describe('the working window is wall-clock time in the calendar timezone', () => {
  test('09:00 → 12:00 on a Monday is 3h', async () => {
    const got = await workingHoursBetween(
      new Date('2026-11-02T05:00:00Z'), new Date('2026-11-02T08:00:00Z'), CAL);
    close(got, 3, 'Mon 09:00 → 12:00');
  });

  test('one full working day is 9h, not 24', async () => {
    const got = await workingHoursBetween(
      new Date('2026-11-02T05:00:00Z'), new Date('2026-11-02T14:00:00Z'), CAL);
    close(got, 9, 'Mon 09:00 → 18:00');
  });

  test('00:00 → 23:59 on a working day still counts only the 9h window', async () => {
    const got = await workingHoursBetween(
      new Date('2026-11-01T20:00:00Z'), new Date('2026-11-02T19:59:00Z'), CAL);
    close(got, 9, 'the whole of Monday local');
  });

  test('time before 09:00 does not count — a 05:00 raise starts at 09:00', async () => {
    // Mon 06:00 Dubai → Mon 10:00 Dubai is one working hour, not four.
    const got = await workingHoursBetween(
      new Date('2026-11-02T02:00:00Z'), new Date('2026-11-02T06:00:00Z'), CAL);
    close(got, 1, 'Mon 06:00 → 10:00');
  });

  test('overnight Monday 17:00 → Tuesday 10:00 is 2h', async () => {
    const got = await workingHoursBetween(
      new Date('2026-11-02T13:00:00Z'), new Date('2026-11-03T06:00:00Z'), CAL);
    close(got, 2, 'Mon 17:00 → Tue 10:00');
  });

  test('a Dubai morning does not read as zero elapsed (the UTC-window trap)', async () => {
    // 09:30 → 11:30 Dubai is 05:30→07:30Z. Treating the window as UTC would make
    // this span fall entirely before 09:00 "UTC" and return 0.
    const got = await workingHoursBetween(
      new Date('2026-11-02T05:30:00Z'), new Date('2026-11-02T07:30:00Z'), CAL);
    close(got, 2, 'Mon 09:30 → 11:30');
  });

  test('a full working week is 45h', async () => {
    const got = await workingHoursBetween(
      new Date('2026-11-02T05:00:00Z'), new Date('2026-11-06T14:00:00Z'), CAL);
    close(got, 45, 'Mon 09:00 → Fri 18:00');
  });

  test('UAE public holidays are excluded', async () => {
    // Mon 30 Nov 17:00 → Fri 4 Dec 10:00; 1–3 Dec are seeded holidays.
    const got = await workingHoursBetween(
      new Date('2026-11-30T13:00:00Z'), new Date('2026-12-04T06:00:00Z'), CAL);
    close(got, 2, '1h Monday + 1h Friday, three holidays skipped');
  });

  test('a backwards or zero-length span is zero, never negative', async () => {
    close(await workingHoursBetween(new Date('2026-11-02T08:00:00Z'), new Date('2026-11-02T05:00:00Z'), CAL), 0, 'backwards');
    close(await workingHoursBetween(new Date('2026-11-02T08:00:00Z'), new Date('2026-11-02T08:00:00Z'), CAL), 0, 'zero length');
  });

  test('the Trichy calendar has its own window, and Dubai still governs by default', async () => {
    // Trichy works Mon–Sat 09:30–18:30 IST. A Saturday is working there, not here.
    const trichy = await workingHoursBetween(
      new Date('2026-11-07T04:00:00Z'), new Date('2026-11-07T08:00:00Z'), 'Trichy');
    close(trichy, 4, 'Sat 09:30 → 13:30 IST');
    const dubai = await workingHoursBetween(
      new Date('2026-11-07T04:00:00Z'), new Date('2026-11-07T08:00:00Z'), CAL);
    close(dubai, 0, 'the same Saturday on the Dubai calendar');
  });
});

/* ═════════════════════════ 3. slaState thresholds ═════════════════════════ */

describe('slaState: Within below 80%, Approaching at 80–99%, Breached at 100%+', () => {
  const target = 10;
  const cases: Array<[number, string, string]> = [
    [0, 'Within', '0%'],
    [5, 'Within', '50%'],
    [7.9, 'Within', '79%'],
    [7.999, 'Within', 'just under 80%'],
    [8, 'Approaching', 'exactly 80%'],
    [9, 'Approaching', '90%'],
    [9.99, 'Approaching', '99.9%'],
    [10, 'Breached', 'exactly 100%'],
    [10.01, 'Breached', 'just over 100%'],
    [25, 'Breached', '250%'],
  ];
  for (const [elapsed, want, label] of cases) {
    test(`${elapsed}h of a ${target}h target (${label}) is ${want}`, () => {
      assert.equal(slaState(elapsed, target), want);
    });
  }

  test('the warn threshold is configurable per call', () => {
    assert.equal(slaState(5, 10, 50), 'Approaching', 'a 50% warn threshold fires at 5h');
    assert.equal(slaState(4.9, 10, 50), 'Within');
  });

  test('a zero or negative target cannot breach', () => {
    assert.equal(slaState(100, 0), 'Within');
    assert.equal(slaState(100, -1), 'Within');
  });

  test('the engine agrees with slaState end to end: 11h against an 8h target is Breached', async () => {
    const elapsed = await workingHoursBetween(
      new Date('2026-11-05T12:00:00Z'), new Date('2026-11-08T05:30:00Z'), CAL);
    assert.equal(slaState(elapsed, 8), 'Breached', '11h working against the 8h PROC_RESPONSE target');
    assert.equal(slaState(elapsed, 16), 'Within', '11h of a 16h target is 68.75%');
    assert.equal(slaState(elapsed, 13), 'Approaching', '11h of a 13h target is 84.6%');
  });
});

/* ═════════════════════════ 4. the pause state is excluded ═════════════════════════ */

describe('paused time is excluded from the elapsed working hours', () => {
  const TIMER_CODE = `TEST_${H.STAMP}`.slice(0, 48);

  /**
   * A timer whose start is ten days back — far enough that the gross working
   * hours are well over any target used here, whatever weekday the suite runs on.
   */
  async function runTimer(pausedMinutes: number, targetHours: number) {
    const entityId = (await H.sql1<{ id: string }>(`SELECT gen_random_uuid() AS id`))!.id;
    const calendarId = (await H.sql1<{ id: string }>(`SELECT id FROM gw.calendars WHERE name = $1`, [CAL]))!.id;
    await H.sql(
      `INSERT INTO gw.sla_timers (timer_code, entity_type, entity_id, calendar_id, started_at, paused_minutes, target_hours)
       VALUES ($1, 'sla_test', $2, $3, now() - interval '10 days', $4, $5)`,
      [TIMER_CODE, entityId, calendarId, pausedMinutes, targetHours]);

    const client = await H.pool.connect();
    try {
      await stopTimer(client, TIMER_CODE, 'sla_test', entityId);
    } finally {
      client.release();
    }
    const row = (await H.sql(
      `SELECT started_at, stopped_at, paused_minutes, elapsed_working_hours, state::text AS state, target_hours
         FROM gw.sla_timers WHERE entity_type = 'sla_test' AND entity_id = $1`, [entityId]))[0];
    const gross = await workingHoursBetween(new Date(row.started_at), new Date(row.stopped_at), CAL);
    return { row, gross, entityId };
  }

  test('stopTimer subtracts paused_minutes from the gross working hours', async () => {
    const { row, gross } = await runTimer(120, 1000);
    assert.ok(gross > 0, 'the fixture must span some working time');
    close(Number(row.elapsed_working_hours), gross - 2, 'elapsed = gross − 2h paused');
    assert.ok(Number(row.elapsed_working_hours) < gross, 'the pause must actually come off');
  });

  test('a pause longer than the gross time floors the elapsed at zero, never negative', async () => {
    const { row } = await runTimer(100_000, 1000);
    assert.equal(Number(row.elapsed_working_hours), 0);
    assert.equal(row.state, 'Stopped');
  });

  test('the state recorded on stop reflects the paused figure, not the gross one', async () => {
    // Gross is far above the 4h target; a pause big enough to bring the net
    // under 4h must leave the timer Stopped rather than Breached.
    const { gross } = await runTimer(0, 4);
    assert.ok(gross > 4, 'the fixture must be over target before the pause');

    const breached = await runTimer(0, 4);
    assert.equal(breached.row.state, 'Breached', 'no pause: over target is Breached');

    const rescued = await runTimer(Math.ceil(gross * 60) - 60, 4);
    assert.equal(rescued.row.state, 'Stopped', 'with the pause excluded it is inside target');
    assert.ok(Number(rescued.row.elapsed_working_hours) < 4);
  });

  test('stopTimer is a no-op on a timer that is already stopped', async () => {
    const { entityId } = await runTimer(60, 100);
    const client = await H.pool.connect();
    try {
      const again = await stopTimer(client, TIMER_CODE, 'sla_test', entityId);
      assert.equal(again, null, 'a stopped timer must not be restamped');
    } finally {
      client.release();
    }
  });
});
