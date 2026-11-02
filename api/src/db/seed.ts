import { pool, q1, tx } from '../core/db.js';
import { hashPassword } from '../core/auth.js';
import { MATRIX, MODULES, ROLES, actionsFor, scopeOf, permKey, ACTIONS } from './rbac-matrix.js';

const PEOPLE: Array<{ name: string; email: string; role: string; sbus?: Array<[string, 'Head'|'Engineer']> }> = [
  { name: 'Siva Natarajan',    email: 'siva@greenware.ae',    role: 'SUPER_ADMIN' },
  { name: 'Chockalingam M',    email: 'chockas@greenware.ae', role: 'SALES_MGR' },
  { name: 'Naveen',            email: 'naveen@greenware.ae',  role: 'SALES' },
  { name: 'Abi',               email: 'abi@greenware.ae',     role: 'SALES' },
  { name: 'Selva',             email: 'selva@greenware.ae',   role: 'SALES' },
  { name: 'Vishnu',            email: 'vishnu@greenware.ae',  role: 'SALES' },
  { name: 'Bineesh',           email: 'bineesh@greenware.ae', role: 'PROCUREMENT' }, // OD-02: also sells
  { name: 'Sangeetha',         email: 'sangeetha@greenware.ae', role: 'ACCOUNTS' },
  { name: 'Aishwarya',         email: 'aishwarya@greenware.ae', role: 'PM' },
  { name: 'Dhivya',            email: 'dhivya@greenware.ae',  role: 'PM' },
  { name: 'Rock',              email: 'rock@greenware.ae',    role: 'PM' },
  { name: 'Kumar',             email: 'kumar@greenware.ae',   role: 'SBU_HEAD', sbus: [['SBU1','Head']] },
  { name: 'Fayaz',             email: 'fayaz@greenware.ae',   role: 'SBU_HEAD', sbus: [['SBU2','Head']] },
  { name: 'Purush',            email: 'purush@greenware.ae',  role: 'SBU_HEAD', sbus: [['SBU3','Head']] },
  // OD-01: Abdul is ONE person in two SBUs — engineer under Kumar in SBU 1, head of SBU 4.
  { name: 'Abdul',             email: 'abdul@greenware.ae',   role: 'SBU_HEAD', sbus: [['SBU4','Head'], ['SBU1','Engineer']] },
  { name: 'Thousif',           email: 'thousif@greenware.ae', role: 'TECHNICAL', sbus: [['SBU1','Engineer']] },
  { name: 'Godson',            email: 'godson@greenware.ae',  role: 'TECHNICAL', sbus: [['SBU1','Engineer']] },
  { name: 'Anand',             email: 'anand@greenware.ae',   role: 'TECHNICAL', sbus: [['SBU2','Engineer']] },
  { name: 'Henry',             email: 'henry@greenware.ae',   role: 'TECHNICAL', sbus: [['SBU2','Engineer']] },
  { name: 'Abuthahir',         email: 'abuthahir@greenware.ae', role: 'TECHNICAL', sbus: [['SBU2','Engineer']] },
  { name: 'Noushin',           email: 'noushin@greenware.ae', role: 'TECHNICAL', sbus: [['SBU2','Engineer']] },
  { name: 'Vignesh',           email: 'vignesh@greenware.ae', role: 'TECHNICAL', sbus: [['SBU3','Engineer']] },
  { name: 'Santhosh',          email: 'santhosh@greenware.ae',role: 'TECHNICAL', sbus: [['SBU3','Engineer']] },
  { name: 'Sriram Prem',       email: 'sriram@greenware.ae',  role: 'TECHNICAL', sbus: [['SBU3','Engineer']] },
  { name: 'Mubeen',            email: 'mubeen@greenware.ae',  role: 'TECHNICAL', sbus: [['SBU3','Engineer']] },
  { name: 'Aakash',            email: 'aakash@greenware.ae',  role: 'TECHNICAL', sbus: [['SBU3','Engineer']] },
  { name: 'Guhan',             email: 'guhan@greenware.ae',   role: 'TECHNICAL', sbus: [['SBU3','Engineer']] },
  { name: 'Suheal',            email: 'suheal@greenware.ae',  role: 'TECHNICAL', sbus: [['SBU3','Engineer']] },
  { name: 'Saifulla',          email: 'saifulla@greenware.ae',role: 'TECHNICAL', sbus: [['SBU3','Engineer']] },
  { name: 'Kanisk',            email: 'kanisk@greenware.ae',  role: 'TECHNICAL', sbus: [['SBU4','Engineer']] },
  { name: 'Uthandeeshwar',     email: 'uthandeeshwar@greenware.ae', role: 'TECHNICAL', sbus: [['SBU4','Engineer']] },
];

// OD-17: internal timers keep the proposed defaults. The customer P1-P4 matrix
// is service-side and is seeded by the schema against contracts.
const SLA_RULES: Array<[string, 'Normal'|'Urgent', number]> = [
  ['PROC_RESPONSE','Normal',8], ['PROC_RESPONSE','Urgent',4],
  ['TECH_ESTIMATE','Normal',16],['TECH_ESTIMATE','Urgent',8],
  ['QUOTE_PREP','Normal',8],    ['QUOTE_PREP','Urgent',4],
  ['APPROVAL','Normal',8],      ['APPROVAL','Urgent',4],
  ['INVOICE_SUBMIT','Normal',24],
];

async function main() {
  const dev = process.argv.includes('--demo');
  await tx({}, async (c) => {
    // ---- permissions ----
    for (const m of MODULES) for (const a of ACTIONS) {
      await c.query(
        `INSERT INTO gw.permissions (key, module, entity, action) VALUES ($1,$2,$3,$4)
         ON CONFLICT (key) DO NOTHING`, [permKey(m, a), m, m, a]);
    }
    // ---- role_permissions straight from the matrix ----
    for (const m of MODULES) for (const r of ROLES) {
      const cell = MATRIX[m][r];
      const scope = scopeOf(cell);
      for (const a of actionsFor(cell)) {
        await c.query(
          `INSERT INTO gw.role_permissions (role_id, permission_id, scope)
           SELECT ro.id, p.id, $3 FROM gw.roles ro, gw.permissions p
            WHERE ro.code = $1 AND p.key = $2
           ON CONFLICT (role_id, permission_id) DO UPDATE SET scope = EXCLUDED.scope`,
          [r, permKey(m, a), scope]);
      }
    }

    // ---- UAE public holidays (OD-18: Dubai calendar governs) ----
    const HOL = ['2026-01-01','2026-03-19','2026-03-20','2026-03-21','2026-05-26','2026-05-27',
                 '2026-05-28','2026-06-16','2026-06-25','2026-12-01','2026-12-02','2026-12-03'];
    for (const h of HOL) {
      await c.query(
        `INSERT INTO gw.holidays (calendar_id, holiday_date, description)
         SELECT id, $1::date, 'UAE public holiday' FROM gw.calendars WHERE name='Dubai'
         ON CONFLICT (calendar_id, holiday_date) DO NOTHING`, [h]);
    }

    // ---- SLA rules ----
    for (const [code, urg, hrs] of SLA_RULES) {
      await c.query(
        `INSERT INTO gw.sla_rules (timer_code, urgency, target_hours, calendar_id, effective_from)
         SELECT $1,$2,$3, cal.id, DATE '2026-01-01' FROM gw.calendars cal WHERE cal.name='Dubai'
         ON CONFLICT (timer_code, urgency, effective_from) DO NOTHING`, [code, urg, hrs]);
    }

    // ---- people ----
    const companyId = (await c.query(`SELECT id FROM gw.companies WHERE code='GWT'`)).rows[0].id;
    const dubai = (await c.query(`SELECT id FROM gw.calendars WHERE name='Dubai'`)).rows[0].id;
    const pw = await hashPassword(process.env.SEED_PASSWORD ?? 'Greenware#2026');

    for (const p of PEOPLE) {
      const u = await c.query(
        `INSERT INTO gw.users (email, display_name) VALUES ($1,$2)
         ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING id`,
        [p.email, p.name]);
      const userId = u.rows[0].id;
      await c.query(
        `INSERT INTO gw.settings (key, value) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [`auth.local.${userId}`, JSON.stringify({ hash: pw })]);
      await c.query(
        `INSERT INTO gw.user_roles (user_id, role_id, company_id)
         SELECT $1, r.id, $3 FROM gw.roles r WHERE r.code = $2
         ON CONFLICT (user_id, role_id) DO NOTHING`, [userId, p.role, companyId]);

      const primarySbu = p.sbus?.find(s => s[1] === 'Head')?.[0] ?? p.sbus?.[0]?.[0] ?? null;
      const e = await c.query(
        `INSERT INTO gw.employees (user_id, full_name, calendar_id, sbu_id, is_active)
         VALUES ($1,$2,$3,(SELECT id FROM gw.sbus WHERE code=$4),true)
         ON CONFLICT (user_id) DO UPDATE SET full_name = EXCLUDED.full_name RETURNING id`,
        [userId, p.name, dubai, primarySbu]);
      const empId = e.rows[0].id;

      for (const [code, membership] of p.sbus ?? []) {
        await c.query(
          `INSERT INTO gw.employee_sbu_memberships (employee_id, sbu_id, membership, is_primary, assigns_work)
           SELECT $1, s.id, $3, $4, $5 FROM gw.sbus s WHERE s.code = $2
           ON CONFLICT (employee_id, sbu_id, effective_from) DO NOTHING`,
          [empId, code, membership, code === primarySbu, membership === 'Head']);
      }
    }

    // OD-01: Abdul's SBU 1 estimates are reviewed by Kumar, who assigns his work there.
    await c.query(
      `UPDATE gw.employee_sbu_memberships m SET reviewed_by = k.id
         FROM gw.employees a, gw.employees k, gw.sbus s
        WHERE a.full_name='Abdul' AND k.full_name='Kumar' AND s.code='SBU1'
          AND m.employee_id = a.id AND m.sbu_id = s.id`);

    // SBU heads
    await c.query(
      `UPDATE gw.sbus s SET head_employee_id = m.employee_id
         FROM gw.employee_sbu_memberships m
        WHERE m.sbu_id = s.id AND m.membership = 'Head'`);

    console.log('seeded roles, permissions, calendars, SLA rules and %d people', PEOPLE.length);
  });

  if (dev) await seedDemo();
  await pool.end();
}

async function seedDemo() {
  await tx({}, async (c) => {
    const companyId = (await c.query(`SELECT id FROM gw.companies WHERE code='GWT'`)).rows[0].id;
    const emp = async (n: string) => (await c.query(`SELECT id FROM gw.employees WHERE full_name=$1`, [n])).rows[0]?.id;
    const CUST = [
      ['C001','Meridian Bank','Banking','Dubai','Naveen',45],
      ['C002','Falcon Logistics','Logistics','Dubai','Abi',30],
      ['C003','Northline Healthcare','Healthcare','Abu Dhabi','Selva',60],
      ['C004','Dune Capital','Financial services','Dubai','Vishnu',30],
      ['C005','Cedar Retail Group','Retail','Sharjah','Abi',45],
      ['C006','Atlas Marine Services','Marine','Dubai','Vishnu',30],
    ] as const;
    for (const [code, name, ind, loc, am, terms] of CUST) {
      await c.query(
        `INSERT INTO gw.customers (company_id, customer_code, name, industry, location, country,
                                   account_manager_id, payment_terms_days, default_currency, credit_limit)
         VALUES ($1,$2,$3,$4,$5,'AE',$6,$7,'AED',$8)
         ON CONFLICT (company_id, customer_code) DO NOTHING`,
        [companyId, code, name, ind, loc, await emp(am as string), terms, 1_500_000]);
    }
    console.log('seeded %d demo customers', CUST.length);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
