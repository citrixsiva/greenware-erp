import { workingHoursBetween } from '../core/sla.js';
const T = async (label: string, a: string, b: string, exp: number) => {
  const got = await workingHoursBetween(new Date(a), new Date(b), 'Dubai');
  const ok = Math.abs(got - exp) < 0.02;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${got}h, expected ${exp}h`);
  if (!ok) process.exitCode = 1;
};
// Dubai = UTC+4, working Mon-Fri 09:00-18:00 local = 05:00-14:00 UTC
async function main() {
  await T('same morning 09:00->12:00 Dubai (Mon)',   '2026-11-02T05:00:00Z', '2026-11-02T08:00:00Z', 3);
  await T('Thu 16:00 -> Sun 09:00 = 2h Thu + 9h Fri', '2026-11-05T12:00:00Z', '2026-11-08T05:00:00Z', 11);
  await T('one full working day',                    '2026-11-02T05:00:00Z', '2026-11-02T14:00:00Z', 9);
  await T('overnight Mon 17:00 -> Tue 10:00 = 2h',   '2026-11-02T13:00:00Z', '2026-11-03T06:00:00Z', 2);
  await T('weekend only (Sat->Sun)',                 '2026-11-07T06:00:00Z', '2026-11-08T06:00:00Z', 0);
  await T('before hours start counts from 09:00',    '2026-11-02T02:00:00Z', '2026-11-02T06:00:00Z', 1);
  await T('spans 1-3 Dec holidays: 1h Mon + 1h Fri', '2026-11-30T13:00:00Z', '2026-12-04T06:00:00Z', 2);
  await T('Sat raise lands on Monday open',          '2026-11-07T10:00:00Z', '2026-11-09T06:00:00Z', 1);
  await T('Fri 17:00 -> Mon 09:30 skips the weekend',      '2026-11-06T13:00:00Z', '2026-11-09T05:30:00Z', 1.5);
  process.exit(process.exitCode ?? 0);
}
main();
