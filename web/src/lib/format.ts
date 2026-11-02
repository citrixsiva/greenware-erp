const TZ = 'Asia/Dubai'; // OD-18: the Dubai calendar governs every clock the API reports.

/** True when the API sent a usable number. `undefined` (masked) and `null` (no value) are both "not a number". */
export function isNum(v: unknown): v is number | string {
  if (v === undefined || v === null || v === '') return false;
  return Number.isFinite(Number(v));
}

const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nfCompact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export const fmtInt = (v: unknown) => (isNum(v) ? nf0.format(Number(v)) : '');
export const fmtDec = (v: unknown, d = 2) =>
  isNum(v) ? new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }).format(Number(v)) : '';
export const fmtCompact = (v: unknown) => (isNum(v) ? nfCompact.format(Number(v)) : '');

/** "AED 12,500.00". Whole amounts drop the decimals when `dense` is set. */
export function fmtMoney(v: unknown, ccy?: string | null, dense = false): string {
  if (!isNum(v)) return '';
  const n = Number(v);
  const body = dense && Number.isInteger(n) ? nf0.format(n) : nf2.format(n);
  return ccy ? `${ccy.trim()} ${body}` : body;
}

export const fmtPct = (v: unknown, d = 1) => (isNum(v) ? `${fmtDec(v, d)}%` : '');

export function fmtDate(v: string | Date | null | undefined): string {
  if (!v) return '';
  const d = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00:00Z`) : new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? 'UTC' : TZ }).format(d);
}

export function fmtDateTime(v: string | Date | null | undefined): string {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ,
  }).format(d);
}

/** Working hours as "6.5 h". */
export const fmtHours = (v: unknown) => (isNum(v) ? `${fmtDec(v, 1)} h` : '');

/** Today's date (YYYY-MM-DD) on the Dubai calendar, for date inputs. */
export function dubaiToday(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export const humanize = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');

export function initials(name: string): string {
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? '') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}
