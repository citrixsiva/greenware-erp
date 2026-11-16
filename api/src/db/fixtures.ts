/**
 * Development fixtures: the transactional master data a working local database
 * needs and the migrations do not provide.
 *
 * `001_core.sql` seeds the reference tables — companies, business types, SBUs,
 * tax codes, loss reasons, currencies, technologies, margin rules — and
 * `seed.ts` adds roles, permissions, calendars, SLA rules and the 31 people.
 * Neither creates a customer, a supplier or a product, because those are real
 * business records rather than configuration. That leaves a freshly migrated
 * database unusable: the test helpers' `masters()` reads
 *
 *   SELECT id FROM gw.customers WHERE is_active ... LIMIT 1
 *
 * and dereferences the result, so the whole suite dies in a `before` hook with
 * `Cannot read properties of null (reading 'id')` — a confusing way to learn
 * that you have no customers. This script fills that gap.
 *
 *   DATABASE_URL=postgres://... npm -w api run fixtures
 *
 * It is idempotent (every insert is keyed on a natural code and does nothing on
 * conflict) and it refuses to run against a database that already holds
 * enquiries, so it cannot be mistaken for a production seeder. It is dev and CI
 * only; the DigitalOcean migrate job runs `seed.ts`, never this.
 */
import { pool, q, q1 } from '../core/db.js';

const CUSTOMERS = [
  { code: 'CUS-0001', name: 'Emirates Facilities Management', industry: 'Facilities', location: 'Dubai', type: 'Enterprise', terms: 60 },
  { code: 'CUS-0002', name: 'Gulf Petrochem Industries', industry: 'Oil & Gas', location: 'Sharjah', type: 'Enterprise', terms: 90 },
  { code: 'CUS-0003', name: 'Al Noor Hospital Group', industry: 'Healthcare', location: 'Abu Dhabi', type: 'Enterprise', terms: 45 },
  { code: 'CUS-0004', name: 'Marina Bay Hotels', industry: 'Hospitality', location: 'Dubai', type: 'Mid-market', terms: 30 },
  { code: 'CUS-0005', name: 'Hallmark Logistics', industry: 'Logistics', location: 'Jebel Ali', type: 'Mid-market', terms: 30 },
];

const SUPPLIERS = [
  { code: 'SUP-0001', name: 'Redington Gulf', country: 'AE', ccy: 'AED', terms: 45, rating: 4.5 },
  { code: 'SUP-0002', name: 'Mindware Distribution', country: 'AE', ccy: 'AED', terms: 30, rating: 4.0 },
  { code: 'SUP-0003', name: 'Westcon-Comstor MEA', country: 'AE', ccy: 'USD', terms: 60, rating: 3.5 },
];

const PRODUCTS = [
  { product: 'Veeam Backup & Replication', skus: [['V-VBRENT-0I-SU1YP-00', 'Enterprise socket licence, 1 year', 1850]] },
  { product: 'Fortinet FortiGate 100F', skus: [['FG-100F', 'FortiGate 100F appliance', 3200], ['FC-10-F100F-950-02-12', 'UTP bundle, 1 year', 2100]] },
  { product: 'Dell PowerEdge R760', skus: [['R760-BASE', 'Rack server, 2U, configure to order', 14500]] },
  { product: 'Professional services', skus: [['SVC-IMPL-DAY', 'Implementation engineer, per day', 1400]] },
];

async function main() {
  const existing = await q1<{ n: string }>(`SELECT count(*) AS n FROM gw.enquiries`);
  if (Number(existing?.n ?? 0) > 0) {
    console.error(`fixtures: refusing to run — this database already holds ${existing!.n} enquiries.`);
    console.error('fixtures: it is for a freshly migrated development database only.');
    process.exitCode = 1;
    return;
  }

  const company = await q1<{ id: string }>(`SELECT id FROM gw.companies WHERE code = 'GWT'`);
  if (!company) throw new Error('fixtures: no GWT company — run the migrations and seed.ts first.');

  // Spread the accounts across the account managers so the record-scope rules
  // (own / team / SBU) have something to actually filter on. Sales people are
  // found by role rather than by email, so a renamed seed person cannot
  // silently leave every customer unassigned.
  const ams = await q<{ id: string }>(
    `SELECT e.id
       FROM gw.employees e
       JOIN gw.user_roles ur ON ur.user_id = e.user_id
       JOIN gw.roles r ON r.id = ur.role_id
      WHERE r.code IN ('SALES', 'SALES_MGR') AND e.is_active
      ORDER BY e.employee_code`);

  for (const [i, c] of CUSTOMERS.entries()) {
    await q(
      `INSERT INTO gw.customers
         (company_id, customer_code, name, industry, location, country, customer_type,
          account_manager_id, payment_terms_days, default_currency)
       VALUES ($1,$2,$3,$4,$5,'AE',$6,$7,$8,'AED')
       ON CONFLICT (company_id, customer_code) DO NOTHING`,
      [company.id, c.code, c.name, c.industry, c.location, c.type,
        ams.length ? ams[i % ams.length].id : null, c.terms]);
  }

  // Suppliers are not scoped to a company: the code is unique on its own.
  for (const s of SUPPLIERS) {
    await q(
      `INSERT INTO gw.suppliers
         (supplier_code, name, country, default_currency, payment_terms_days, rating)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (supplier_code) DO NOTHING`,
      [s.code, s.name, s.country, s.ccy, s.terms, s.rating]);
  }

  // gw.products has no unique constraint on the name, so ON CONFLICT has
  // nothing to key on: look first, insert only if it is genuinely missing.
  for (const p of PRODUCTS) {
    const prod = (await q1<{ id: string }>(`SELECT id FROM gw.products WHERE name = $1`, [p.product]))
      ?? (await q1<{ id: string }>(`INSERT INTO gw.products (name) VALUES ($1) RETURNING id`, [p.product]));
    for (const [part, desc, price] of p.skus) {
      await q(
        `INSERT INTO gw.product_skus (product_id, part_number, description, uom, list_price, list_currency)
         VALUES ($1,$2,$3,'EA',$4,'AED')
         ON CONFLICT (product_id, part_number) DO NOTHING`,
        [prod!.id, part, desc, price]);
    }
  }

  const counts = await q1<{ c: string; s: string; k: string }>(
    `SELECT (SELECT count(*) FROM gw.customers) AS c,
            (SELECT count(*) FROM gw.suppliers) AS s,
            (SELECT count(*) FROM gw.product_skus) AS k`);
  console.log(`fixtures: ${counts!.c} customers, ${counts!.s} suppliers, ${counts!.k} part numbers`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool.end());
