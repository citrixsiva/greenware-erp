import { q, q1 } from './db.js';
import { config } from './config.js';

interface Calendar { id: string; name: string; timezone: string; working_days: number[]; day_start: string; day_end: string; }

const cache = new Map<string, { cal: Calendar; holidays: Set<string> }>();

export async function loadCalendar(name = config.defaultCalendar) {
  if (cache.has(name)) return cache.get(name)!;
  const cal = await q1<Calendar>(`SELECT id, name, timezone, working_days, day_start, day_end FROM gw.calendars WHERE name = $1`, [name]);
  if (!cal) throw new Error(`Calendar not found: ${name}`);
  const hol = await q<{ holiday_date: Date }>(`SELECT holiday_date FROM gw.holidays WHERE calendar_id = $1`, [cal.id]);
  const entry = { cal, holidays: new Set(hol.map(h => h.holiday_date.toISOString().slice(0, 10))) };
  cache.set(name, entry);
  return entry;
}

const hhmm = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

/** Offset in ms between a UTC instant and wall-clock time in `tz`. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find(p => p.type === t)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - utcMs;
}

/** The UTC instant of a wall-clock time in `tz`. Two passes settle DST edges. */
function zonedToUtc(y: number, m: number, d: number, minutes: number, tz: string): number {
  const naive = Date.UTC(y, m - 1, d, 0, 0, 0) + minutes * 60_000;
  const o1 = tzOffsetMs(naive, tz);
  const o2 = tzOffsetMs(naive - o1, tz);
  return naive - o2;
}

/** Local calendar date parts for a UTC instant, in `tz`. */
function localParts(utcMs: number, tz: string) {
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
  const p = dtf.formatToParts(new Date(utcMs));
  const v = (t: string) => p.find(x => x.type === t)!.value;
  const WD: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return { y: Number(v('year')), m: Number(v('month')), d: Number(v('day')),
           dow: WD[v('weekday')], iso: `${v('year')}-${v('month')}-${v('day')}` };
}

/**
 * Working hours between two instants against a named calendar.
 *
 * OD-18: the Dubai calendar governs every clock, Trichy included. The window
 * (day_start..day_end) is wall-clock time in the CALENDAR'S timezone, not UTC —
 * treating it as UTC shifts every SLA figure by the offset, which for Dubai is
 * four hours and makes a morning request read as zero elapsed.
 *
 * Elapsed time is meaningless for an SLA: a request raised 16:00 Thursday is
 * not overdue at 09:00 Sunday.
 */
export async function workingHoursBetween(from: Date, to: Date, calendarName = config.defaultCalendar): Promise<number> {
  if (!(from instanceof Date) || !(to instanceof Date)) return 0;
  if (to <= from) return 0;
  const { cal, holidays } = await loadCalendar(calendarName);
  const tz = cal.timezone || 'UTC';
  const startMin = hhmm(cal.day_start);
  const endMin = hhmm(cal.day_end);
  if (endMin <= startMin) return 0;

  let minutes = 0;
  // walk local calendar days, one day before to one day after, so partial
  // days at either boundary are picked up whatever the offset
  let cursor = from.getTime() - 86_400_000;
  const limit = to.getTime() + 86_400_000;
  const seen = new Set<string>();
  while (cursor <= limit) {
    const lp = localParts(cursor, tz);
    if (!seen.has(lp.iso)) {
      seen.add(lp.iso);
      if (cal.working_days.includes(lp.dow) && !holidays.has(lp.iso)) {
        const dayStart = zonedToUtc(lp.y, lp.m, lp.d, startMin, tz);
        const dayEnd = zonedToUtc(lp.y, lp.m, lp.d, endMin, tz);
        const a = Math.max(dayStart, from.getTime());
        const b = Math.min(dayEnd, to.getTime());
        if (b > a) minutes += (b - a) / 60_000;
      }
    }
    cursor += 43_200_000; // half-day steps: never skips a date, cheap enough
  }
  return Math.round((minutes / 60) * 100) / 100;
}

export type SlaState = 'Within' | 'Approaching' | 'Breached' | 'Stopped' | 'Paused';

export function slaState(elapsedHours: number, targetHours: number, warnPct = 80): SlaState {
  if (targetHours <= 0) return 'Within';
  const pct = (elapsedHours / targetHours) * 100;
  if (pct >= 100) return 'Breached';
  if (pct >= warnPct) return 'Approaching';
  return 'Within';
}

/** Starts a timer for an entity. Idempotent on (timer, entity). */
export async function startTimer(client: any, opts: {
  timerCode: string; entityType: string; entityId: string; ownerUserId?: string | null;
  urgency?: 'Normal' | 'Urgent'; calendarName?: string;
}) {
  const rule = await q1<{ id: string; target_hours: number; calendar_id: string | null }>(
    `SELECT id, target_hours, calendar_id FROM gw.sla_rules
      WHERE timer_code = $1 AND urgency = $2 AND is_active
        AND effective_from <= current_date AND (effective_to IS NULL OR effective_to >= current_date)
      ORDER BY effective_from DESC LIMIT 1`,
    [opts.timerCode, opts.urgency ?? 'Normal']);
  if (!rule) return null;
  const { cal } = await loadCalendar(opts.calendarName ?? config.defaultCalendar);
  await client.query(
    `INSERT INTO gw.sla_timers (timer_code, sla_rule_id, entity_type, entity_id, owner_user_id,
                                calendar_id, started_at, target_hours)
     VALUES ($1,$2,$3,$4,$5,$6, now(), $7)
     ON CONFLICT (timer_code, entity_type, entity_id) DO NOTHING`,
    [opts.timerCode, rule.id, opts.entityType, opts.entityId, opts.ownerUserId ?? null, rule.calendar_id ?? cal.id, rule.target_hours]);
  return rule;
}

export async function stopTimer(client: any, timerCode: string, entityType: string, entityId: string) {
  const t = await q1<{ id: string; started_at: Date; target_hours: number; paused_minutes: number; calendar_id: string }>(
    `SELECT id, started_at, target_hours, paused_minutes, calendar_id FROM gw.sla_timers
      WHERE timer_code=$1 AND entity_type=$2 AND entity_id=$3 AND stopped_at IS NULL`,
    [timerCode, entityType, entityId]);
  if (!t) return null;
  const cal = await q1<{ name: string }>(`SELECT name FROM gw.calendars WHERE id=$1`, [t.calendar_id]);
  const now = new Date();
  const gross = await workingHoursBetween(new Date(t.started_at), now, cal?.name);
  const elapsed = Math.max(0, gross - t.paused_minutes / 60);
  await client.query(
    `UPDATE gw.sla_timers SET stopped_at = now(), elapsed_working_hours = $2, state = $3 WHERE id = $1`,
    [t.id, elapsed, slaState(elapsed, t.target_hours) === 'Breached' ? 'Breached' : 'Stopped']);
  return { elapsed, target: t.target_hours };
}
