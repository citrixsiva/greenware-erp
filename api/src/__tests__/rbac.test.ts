/**
 * Acceptance tests for the RBAC matrix (Part 2 of the blueprint), driven through
 * the real HTTP API on :8080 against the live database.
 *
 * Three layers:
 *  1. every cell of gw.MATRIX, allow AND deny, read back from /api/v1/auth/me
 *     (the only surface that can answer for modules with no routes yet);
 *  2. real endpoints, asserting 403 for every denial and 200 for every allow;
 *  3. field-level masking — a masked column must be ABSENT from the JSON, never
 *     null, on quotation versions, quotation lines, customer POs and supplier
 *     quote lines.
 */
import './env.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  MATRIX, MODULES, ROLES, ACTIONS, actionsFor, scopeOf, permKey,
  type RoleCode, type ModuleCode,
} from '../db/rbac-matrix.js';
import * as H from './helpers.js';

/* ───────────────────────── who holds each role ───────────────────────── */

const DIRECTOR_EMAIL = 'rbactest.director@greenware.test';
const ADMIN_EMAIL = 'rbactest.admin@greenware.test';

/** The seed ships no DIRECTOR or ADMIN holder; those two are created in `before`. */
const HOLDER: Record<RoleCode, string> = {
  SUPER_ADMIN: 'siva@greenware.ae',
  DIRECTOR: DIRECTOR_EMAIL,
  SALES_MGR: 'chockas@greenware.ae',
  SALES: 'naveen@greenware.ae',
  PROCUREMENT: 'bineesh@greenware.ae',
  TECHNICAL: 'thousif@greenware.ae',
  SBU_HEAD: 'kumar@greenware.ae',
  PM: 'aishwarya@greenware.ae',
  ACCOUNTS: 'sangeetha@greenware.ae',
  ADMIN: ADMIN_EMAIL,
};

const OTHER_SALES = 'abi@greenware.ae';

/* ───────────────────────── field groups under test ───────────────────────── */

const LINE_COST = ['unit_cost', 'line_cost'] as const;
const LINE_SELL = ['unit_price', 'line_sell', 'discount_pct'] as const;
const LINE_MARGIN = ['line_gp'] as const;
const VER_COST = ['total_cost', 'other_project_cost', 'operation_charges', 'training_charges'] as const;
const VER_SELL = ['total_sell'] as const;
const VER_MARGIN = ['gross_profit', 'gross_margin_pct'] as const;

const PO_COST = ['booked_cost'] as const;
const PO_MARGIN = ['booked_gross_profit', 'booked_margin_pct'] as const;

/** A masked field must be absent from the payload, not present-and-null. */
function assertAbsent(row: Record<string, unknown>, keys: readonly string[], what: string) {
  for (const k of keys) {
    assert.ok(!(k in row), `${what}: "${k}" must be ABSENT from the payload, got ${JSON.stringify(row[k])}`);
  }
}
function assertPresent(row: Record<string, unknown>, keys: readonly string[], what: string) {
  for (const k of keys) {
    assert.ok(k in row, `${what}: "${k}" should be visible but is missing`);
  }
}

/* ───────────────────────── fixtures ───────────────────────── */

interface Fixture {
  m: H.Masters;
  enquiryId: string;
  quotationId: string;
  versionId: string;
  customerPoId: string;
  procRequestId: string;
  supplierQuoteId: string;
  estRequestId: string;
}
let fx: Fixture;

before(async () => {
  await H.ensureRoleUser('DIRECTOR', DIRECTOR_EMAIL, 'RBAC Test Director');
  await H.ensureRoleUser('ADMIN', ADMIN_EMAIL, 'RBAC Test Admin');
  const m = await H.masters();

  // No live field grant may be in force, or the masking expectations below are moot.
  const grants = await H.sql<{ n: number }>(
    `SELECT count(*)::int AS n FROM gw.permission_grants
      WHERE revoked_at IS NULL AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())`);
  assert.equal(grants[0].n, 0, 'a live permission_grant would widen the role baseline under test');

  // An enquiry owned by SALES/naveen, pinned to SBU1 so SBU-scoped roles can reach it.
  const enq = await H.createEnquiry(HOLDER.SALES, m, { sbuCode: 'SBU1', businessType: 'PRODUCT' });

  // Quotation created by SUPER_ADMIN (only a holder of supplier_cost may set unit_cost),
  // but owned by naveen, because ownership follows the enquiry's account manager.
  const quote = await H.createQuotation(HOLDER.SUPER_ADMIN, enq.id, [
    { quantity: 2, unitPrice: 500, discountPct: 10, unitCost: 300 },
  ]);

  // A customer PO carrying booked cost AND booked margin, the second masked table.
  const po = (await H.sql<{ id: string }>(
    `INSERT INTO gw.customer_pos
       (po_ref, customer_po_number, company_id, customer_id, enquiry_id, quotation_version_id, account_manager_id,
        po_date, po_received_date, currency, po_amount, tax_amount, net_value, payment_terms_days,
        booked_cost, booked_gross_profit, booked_margin_pct)
     VALUES ($1,$2,$3,$4,$5,$6,$7, current_date, current_date, 'AED', 945, 45, 900, 45, 600, 300, 33.3333)
     RETURNING id`,
    [`PO-${H.STAMP}`, `CUST-PO-${H.STAMP}`, m.companyId, m.customerId, enq.id, quote.versionId,
     m.employees[HOLDER.SALES]]))[0];

  // Explicit shares: the only way a scope-O role (PM) or an SBU-less manager
  // (SALES_MGR) can reach this record, which is what makes their masking testable.
  const sharedBy = m.users[HOLDER.SUPER_ADMIN];
  await H.shareRecord('quotations', quote.quotationId, m.users[HOLDER.PM], sharedBy);
  await H.shareRecord('quotations', quote.quotationId, m.users[HOLDER.SALES_MGR], sharedBy);
  await H.shareRecord('enquiries', enq.id, m.users[HOLDER.PM], sharedBy);

  // A procurement request with one recorded supplier quotation.
  const admin = await H.login(HOLDER.SUPER_ADMIN);
  const sup = await H.post('/api/v1/suppliers', admin, {
    name: `Test Supplier ${H.STAMP}`, defaultCurrency: 'AED', paymentTermsDays: 60,
  });
  assert.equal(sup.status, 201, `supplier create: ${JSON.stringify(sup.body)}`);

  const pr = await H.post('/api/v1/procurement/requests', admin, {
    enquiryId: enq.id, urgency: 'Normal',
    lines: [{ description: `Sourcing line ${H.STAMP}`, quantity: 2, partNumber: `PN-${H.STAMP}-1` }],
  });
  assert.equal(pr.status, 201, `procurement request: ${JSON.stringify(pr.body)}`);
  const procRequestId = pr.body.data.id as string;

  const buyer = await H.login(HOLDER.PROCUREMENT);
  const asg = await H.patch(`/api/v1/procurement/requests/${procRequestId}/assign`, admin,
    { assignedTo: m.users[HOLDER.PROCUREMENT] });
  assert.equal(asg.status, 200, `assign: ${JSON.stringify(asg.body)}`);

  const sq = await H.post(`/api/v1/procurement/requests/${procRequestId}/supplier-quotes`, buyer, {
    supplierId: sup.body.data.id, currency: 'AED', paymentTermsDays: 45,
    lines: [{ partNumber: `PN-${H.STAMP}-1`, description: `Quoted ${H.STAMP}`, quantity: 2, unitCost: 300 }],
  });
  assert.equal(sq.status, 201, `supplier quote: ${JSON.stringify(sq.body)}`);

  // A technical estimate, raised by the owning salesperson and submitted by the
  // SBU1 engineer, so both halves of the own-only service_cost group are testable.
  const sales = await H.login(HOLDER.SALES);
  const er = await H.post('/api/v1/estimation/requests', sales, {
    enquiryId: enq.id, sbuId: m.sbus.SBU1, scopeNotes: `Estimate please ${H.STAMP}`,
  });
  assert.equal(er.status, 201, `estimation request: ${JSON.stringify(er.body)}`);
  const estRequestId = (Array.isArray(er.body.data) ? er.body.data[0] : er.body.data).id as string;
  const asg2 = await H.patch(`/api/v1/estimation/requests/${estRequestId}/assign`, admin,
    { assignedTo: m.users[HOLDER.TECHNICAL] });
  assert.equal(asg2.status, 200, `estimation assign: ${JSON.stringify(asg2.body)}`);
  const engineer = await H.login(HOLDER.TECHNICAL);
  assert.equal((await H.post(`/api/v1/estimation/requests/${estRequestId}/start`, engineer, {})).status, 200);
  const est = await H.post(`/api/v1/estimation/requests/${estRequestId}/estimate`, engineer, {
    scopeUnderstanding: `Scope ${H.STAMP}`, proposedSolution: `Solution ${H.STAMP}`, totalDays: 4,
    estimatedServiceCost: 12_000, currency: 'AED', travelRequired: true, travelCost: 500, resources: [],
  });
  assert.equal(est.status, 201, `estimate: ${JSON.stringify(est.body)}`);

  fx = {
    m, enquiryId: enq.id, quotationId: quote.quotationId, versionId: quote.versionId,
    customerPoId: po.id, procRequestId, supplierQuoteId: sq.body.data.id, estRequestId,
  };
});

after(() => H.closePool());

/* ═════════════════════════ 1. authentication ═════════════════════════ */

describe('authentication', () => {
  test('an unauthenticated request is rejected with 401', async () => {
    const r = await H.call('GET', '/api/v1/enquiries');
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, 'unauthenticated');
  });

  test('a bad bearer token is rejected with 401', async () => {
    const r = await H.call('GET', '/api/v1/enquiries', { authorization: 'Bearer not.a.real.token' });
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, 'unauthenticated');
  });

  test('a token signed with the wrong key is rejected with 401', async () => {
    // header.payload.signature shaped, but the signature is junk
    const forged = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDAifQ.xxxx';
    const r = await H.call('GET', '/api/v1/enquiries', { authorization: `Bearer ${forged}` });
    assert.equal(r.status, 401);
  });

  test('a malformed Authorization header is rejected with 401', async () => {
    const r = await H.call('GET', '/api/v1/enquiries', { authorization: 'Basic abc' });
    assert.equal(r.status, 401);
  });

  test('a valid token reaches /auth/me', async () => {
    const token = await H.login(HOLDER.SALES);
    const r = await H.get('/api/v1/auth/me', token);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.roles, ['SALES']);
  });

  test('login with a wrong password is rejected with 401', async () => {
    const r = await H.call('POST', '/api/v1/auth/login', { body: { email: HOLDER.SALES, password: 'wrong' } });
    assert.equal(r.status, 401);
  });

  test('a caller mistake is a 4xx, never a 500', async () => {
    const token = await H.login(HOLDER.SUPER_ADMIN);
    // Declaring a JSON body and sending none is the caller's error; the envelope
    // must say so rather than reporting a server fault.
    const empty = await fetch(`${H.BASE}/api/v1/quotations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    });
    assert.ok(empty.status >= 400 && empty.status < 500,
      `an empty declared body must be a 4xx, got ${empty.status}`);
    const body = await empty.json() as any;
    assert.ok(body.error?.code, 'the error envelope must carry a code');

    // Malformed JSON is the same class of mistake.
    const broken = await fetch(`${H.BASE}/api/v1/quotations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{not json',
    });
    assert.ok(broken.status >= 400 && broken.status < 500, `malformed JSON must be a 4xx, got ${broken.status}`);
  });
});

/* ═════════════════════════ 2. every matrix cell ═════════════════════════ */

describe('permission matrix: every allow and every deny', () => {
  for (const role of ROLES) {
    describe(role, () => {
      for (const mod of MODULES) {
        const cell = MATRIX[mod][role];
        const allowed = new Set<string>(actionsFor(cell));
        const scope = scopeOf(cell);
        const denied = ACTIONS.filter(a => !allowed.has(a));

        test(`${mod} = ${cell} (allows ${[...allowed].join(',') || 'nothing'}; denies ${denied.join(',')})`, async () => {
          const token = await H.login(HOLDER[role]);
          const me = await H.get('/api/v1/auth/me', token);
          assert.equal(me.status, 200);
          assert.deepEqual(me.body.roles, [role], `${HOLDER[role]} must hold exactly ${role}`);
          const perms = me.body.permissions as Record<string, string>;

          for (const a of allowed) {
            const key = permKey(mod as ModuleCode, a as any);
            assert.equal(perms[key], scope, `${role} should hold ${key} at scope ${scope}`);
          }
          for (const a of denied) {
            const key = permKey(mod as ModuleCode, a as any);
            assert.ok(!(key in perms), `${role} must NOT hold ${key} (cell ${cell})`);
          }
          // Nobody ever gets delete: history is append-only.
          assert.ok(!(`${mod}.delete` in perms), `${role} must never hold ${mod}.delete`);
        });
      }
    });
  }
});

/* ═════════════════════════ 3. endpoints honour the matrix ═════════════════════════ */

const ENDPOINTS: Array<{ perm: string; method: string; path: string; label: string }> = [
  { perm: 'enquiries.view', method: 'GET', path: '/api/v1/enquiries', label: 'enquiry list' },
  { perm: 'quotations.view', method: 'GET', path: '/api/v1/quotations', label: 'quotation list' },
  { perm: 'quotations.approve', method: 'GET', path: '/api/v1/approvals', label: 'approval queue' },
  { perm: 'procurement_requests.view', method: 'GET', path: '/api/v1/procurement/requests', label: 'procurement queue' },
  { perm: 'technical_estimations.view', method: 'GET', path: '/api/v1/estimation/requests', label: 'estimation queue' },
  { perm: 'technical_estimations.view', method: 'GET', path: '/api/v1/estimation/sla', label: 'estimation SLA' },
  { perm: 'customers.view', method: 'GET', path: '/api/v1/customers', label: 'customer list' },
  { perm: 'suppliers.view', method: 'GET', path: '/api/v1/suppliers', label: 'supplier list' },
  { perm: 'products.view', method: 'GET', path: '/api/v1/products', label: 'product list' },
  { perm: 'price_history.view', method: 'GET', path: '/api/v1/price-history/search?q=PN', label: 'price history search' },
  { perm: 'admin.view', method: 'GET', path: '/api/v1/admin/users', label: 'admin users' },
  { perm: 'audit_log.view', method: 'GET', path: '/api/v1/audit', label: 'audit log' },
];

describe('endpoints honour the matrix', () => {
  for (const role of ROLES) {
    for (const ep of ENDPOINTS) {
      const [mod, action] = ep.perm.split('.') as [ModuleCode, string];
      const cell = MATRIX[mod][role];
      const held = actionsFor(cell).includes(action as any);
      test(`${role} ${held ? 'may read' : 'is refused'} ${ep.label}`, async () => {
        const token = await H.login(HOLDER[role]);
        const r = await H.call(ep.method, ep.path, { token });
        if (held) {
          assert.equal(r.status, 200, `${role} holds ${ep.perm} but got ${r.status} ${JSON.stringify(r.body)}`);
        } else {
          assert.equal(r.status, 403, `${role} lacks ${ep.perm} and must get 403, got ${r.status}`);
          assert.equal(r.body.error.code, 'forbidden');
        }
      });
    }
  }

  test('a role without admin.create cannot create users', async () => {
    const token = await H.login(HOLDER.SALES);
    const r = await H.post('/api/v1/admin/users', token, { email: `x${H.STAMP}@greenware.ae`, displayName: 'X' });
    assert.equal(r.status, 403);
  });

  test('ADMIN holds admin.edit but not audit_log.view', async () => {
    const token = await H.login(HOLDER.ADMIN);
    assert.equal((await H.get('/api/v1/admin/roles', token)).status, 200);
    assert.equal((await H.get('/api/v1/audit', token)).status, 403);
  });

  test('DIRECTOR may read the audit log', async () => {
    const token = await H.login(HOLDER.DIRECTOR);
    assert.equal((await H.get('/api/v1/audit', token)).status, 200);
  });

  test('TECHNICAL cannot reach a quotation at all (quotations = N)', async () => {
    const token = await H.login(HOLDER.TECHNICAL);
    const r = await H.get(`/api/v1/quotations/${fx.quotationId}`, token);
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'forbidden');
  });

  test('PM cannot create a quotation (quotations = R/O)', async () => {
    const token = await H.login(HOLDER.PM);
    const r = await H.post('/api/v1/quotations', token, { enquiryId: fx.enquiryId });
    assert.equal(r.status, 403);
  });

  test('SALES cannot see another salesperson\'s quotation (scope O)', async () => {
    const token = await H.login(OTHER_SALES);
    const r = await H.get(`/api/v1/quotations/${fx.quotationId}`, token);
    assert.equal(r.status, 404, 'out-of-scope records are 404, never 403 — existence is not revealed');
  });

  test('SALES cannot set a supplier unit cost on a quotation line', async () => {
    const token = await H.login(HOLDER.SALES);
    const r = await H.post(`/api/v1/quotation-versions/${fx.versionId}/lines`, token, {
      description: `Attempt ${H.STAMP}`, quantity: 1, unitPrice: 10, unitCost: 5,
    });
    assert.equal(r.status, 403, 'SALES has no supplier_cost, so unit_cost must be refused');
    assert.match(String(r.body.error.message), /supplier quote/i);
  });
});

/* ═════════════════════════ 4. field masking: quotations ═════════════════════════ */

interface MaskCase {
  role: RoleCode | 'OTHER_SALES';
  email: string;
  cost: boolean;
  sell: boolean;
  margin: boolean;
  note: string;
}

const QUOTE_CASES: MaskCase[] = [
  { role: 'SUPER_ADMIN', email: HOLDER.SUPER_ADMIN, cost: true, sell: true, margin: true, note: 'sees everything' },
  { role: 'DIRECTOR', email: HOLDER.DIRECTOR, cost: true, sell: true, margin: true, note: 'sees everything' },
  { role: 'ACCOUNTS', email: HOLDER.ACCOUNTS, cost: true, sell: true, margin: true, note: 'sees everything' },
  { role: 'PROCUREMENT', email: HOLDER.PROCUREMENT, cost: true, sell: false, margin: false, note: 'supplier cost only' },
  { role: 'SALES', email: HOLDER.SALES, cost: false, sell: true, margin: true, note: 'owns this record' },
  { role: 'SALES_MGR', email: HOLDER.SALES_MGR, cost: true, sell: true, margin: false, note: 'margin is own-only and this is not theirs' },
  { role: 'SBU_HEAD', email: HOLDER.SBU_HEAD, cost: false, sell: false, margin: false, note: 'service cost only, margin own-only' },
  { role: 'PM', email: HOLDER.PM, cost: false, sell: false, margin: false, note: 'no sensitive field groups at all' },
];

describe('field masking on quotation versions and lines', () => {
  for (const c of QUOTE_CASES) {
    test(`${c.role}: cost=${c.cost} sell=${c.sell} margin=${c.margin} (${c.note})`, async () => {
      const token = await H.login(c.email);
      const r = await H.get(`/api/v1/quotations/${fx.quotationId}`, token);
      assert.equal(r.status, 200, `${c.role} should be able to read the quotation: ${JSON.stringify(r.body)}`);
      const ver = r.body.data.versions.find((v: any) => v.id === fx.versionId);
      assert.ok(ver, `${c.role}: version missing from payload`);
      const line = ver.lines[0];
      assert.ok(line, `${c.role}: line missing from payload`);

      (c.cost ? assertPresent : assertAbsent)(line, LINE_COST, `${c.role} line cost`);
      (c.cost ? assertPresent : assertAbsent)(ver, VER_COST, `${c.role} version cost`);
      (c.sell ? assertPresent : assertAbsent)(line, LINE_SELL, `${c.role} line sell`);
      (c.sell ? assertPresent : assertAbsent)(ver, VER_SELL, `${c.role} version sell`);
      (c.margin ? assertPresent : assertAbsent)(line, LINE_MARGIN, `${c.role} line margin`);
      (c.margin ? assertPresent : assertAbsent)(ver, VER_MARGIN, `${c.role} version margin`);

      // supplier identity leaks cost just as surely as the cost does
      if (!c.cost) assertAbsent(line, ['supplier_id', 'supplier_quote_line_id'], `${c.role} supplier provenance`);

      // description and quantity are never masked, so the row is still usable
      assertPresent(line, ['description', 'quantity', 'line_no'], `${c.role} line identity`);
    });
  }

  test('a masked field is absent, not null — PROCUREMENT margin and sell', async () => {
    const token = await H.login(HOLDER.PROCUREMENT);
    const r = await H.get(`/api/v1/quotations/${fx.quotationId}`, token);
    const ver = r.body.data.versions.find((v: any) => v.id === fx.versionId);
    const line = ver.lines[0];
    assert.ok(!('unit_price' in line));
    assert.ok(!('line_gp' in line));
    assert.ok(!('gross_margin_pct' in ver));
    assert.equal(Object.keys(line).filter(k => (LINE_SELL as readonly string[]).includes(k)).length, 0);
    // and the cost it IS entitled to is a real number, not stripped by accident
    assert.equal(line.unit_cost, 300);
    assert.equal(line.line_cost, 600);
  });

  test('the margin breakdown endpoint is refused to roles without margin', async () => {
    for (const role of ['PROCUREMENT', 'PM', 'SBU_HEAD'] as RoleCode[]) {
      const token = await H.login(HOLDER[role]);
      const r = await H.get(`/api/v1/quotation-versions/${fx.versionId}/margin`, token);
      assert.equal(r.status, 403, `${role} must not get a margin breakdown, got ${r.status}`);
      assert.equal(r.body.error.code, 'forbidden');
    }
  });

  test('the margin breakdown endpoint is served to the owning salesperson', async () => {
    const token = await H.login(HOLDER.SALES);
    const r = await H.get(`/api/v1/quotation-versions/${fx.versionId}/margin`, token);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.totals.grossProfit, 300);
    // cost stays hidden even inside the margin payload
    assert.ok(!('linesCost' in r.body.data.totals));
    assert.ok(!('totalCost' in r.body.data.totals));
  });
});

/* ═════════════════════════ 5. field masking: customer POs ═════════════════════════ */

const PO_CASES: MaskCase[] = [
  { role: 'DIRECTOR', email: HOLDER.DIRECTOR, cost: true, sell: true, margin: true, note: 'sees everything' },
  { role: 'ACCOUNTS', email: HOLDER.ACCOUNTS, cost: true, sell: true, margin: true, note: 'sees everything' },
  { role: 'PROCUREMENT', email: HOLDER.PROCUREMENT, cost: true, sell: false, margin: false, note: 'booked cost only' },
  { role: 'SALES', email: HOLDER.SALES, cost: false, sell: true, margin: true, note: 'owns this record' },
  { role: 'TECHNICAL', email: HOLDER.TECHNICAL, cost: false, sell: false, margin: false, note: 'neither cost nor margin' },
  { role: 'SBU_HEAD', email: HOLDER.SBU_HEAD, cost: false, sell: false, margin: false, note: 'neither cost nor margin' },
  { role: 'PM', email: HOLDER.PM, cost: false, sell: false, margin: false, note: 'neither cost nor margin' },
];

describe('field masking on customer POs, via the enquiry detail', () => {
  for (const c of PO_CASES) {
    test(`${c.role}: booked cost=${c.cost} booked margin=${c.margin} (${c.note})`, async () => {
      const token = await H.login(c.email);
      const r = await H.get(`/api/v1/enquiries/${fx.enquiryId}`, token);
      assert.equal(r.status, 200, `${c.role} should read the enquiry: ${JSON.stringify(r.body)}`);
      const pos = r.body.data.customer_pos;
      assert.ok(Array.isArray(pos), `${c.role}: customer_pos should be a list, got ${JSON.stringify(pos)}`);
      const po = pos.find((p: any) => p.id === fx.customerPoId);
      assert.ok(po, `${c.role}: the fixture PO is missing`);
      (c.cost ? assertPresent : assertAbsent)(po, PO_COST, `${c.role} booked cost`);
      (c.margin ? assertPresent : assertAbsent)(po, PO_MARGIN, `${c.role} booked margin`);
      // the commercial face of the PO is never masked
      assertPresent(po, ['po_amount', 'net_value', 'customer_po_number'], `${c.role} PO identity`);
    });
  }

  test('TECHNICAL sees neither supplier cost nor margin anywhere on the enquiry', async () => {
    const token = await H.login(HOLDER.TECHNICAL);
    const r = await H.get(`/api/v1/enquiries/${fx.enquiryId}`, token);
    assert.equal(r.status, 200);
    const d = r.body.data;
    const po = d.customer_pos.find((p: any) => p.id === fx.customerPoId);
    assert.ok(!('booked_cost' in po));
    assert.ok(!('booked_gross_profit' in po));
    assert.ok(!('booked_margin_pct' in po));
    // sections the caller holds no permission for come back as null, not as empty lists
    assert.equal(d.quotations, null, 'TECHNICAL holds no quotations.view');
    assert.equal(d.procurement_requests, null, 'TECHNICAL holds no procurement_requests.view');
  });

  test('the customer credit limit is masked from roles without the credit group', async () => {
    for (const role of ['PROCUREMENT', 'TECHNICAL', 'PM'] as RoleCode[]) {
      const token = await H.login(HOLDER[role]);
      const r = await H.get(`/api/v1/enquiries/${fx.enquiryId}`, token);
      assert.equal(r.status, 200);
      const cust = r.body.data.customer;
      assert.ok(!('credit_limit' in cust), `${role} must not see credit_limit`);
      assert.ok(!('credit_currency' in cust), `${role} must not see credit_currency`);
    }
    const acct = await H.login(HOLDER.ACCOUNTS);
    const r = await H.get(`/api/v1/enquiries/${fx.enquiryId}`, acct);
    assert.ok('credit_limit' in r.body.data.customer, 'ACCOUNTS holds the credit group');
  });
});

/* ═════════════════════════ 6. field masking: supplier quotes ═════════════════════════ */

describe('field masking on supplier quotes', () => {
  test('PROCUREMENT sees the supplier unit cost and payment terms', async () => {
    const token = await H.login(HOLDER.PROCUREMENT);
    const r = await H.get(`/api/v1/procurement/requests/${fx.procRequestId}`, token);
    assert.equal(r.status, 200);
    const sq = r.body.data.supplier_quotes.find((x: any) => x.id === fx.supplierQuoteId);
    assert.ok(sq);
    assert.equal(sq.payment_terms_days, 45);
    assert.equal(sq.lines[0].unit_cost, 300);
  });

  test('SBU_HEAD may read the request but not the supplier unit cost or terms', async () => {
    const token = await H.login(HOLDER.SBU_HEAD);
    const r = await H.get(`/api/v1/procurement/requests/${fx.procRequestId}`, token);
    assert.equal(r.status, 200);
    const sq = r.body.data.supplier_quotes.find((x: any) => x.id === fx.supplierQuoteId);
    assert.ok(sq, 'SBU_HEAD holds supplier_quotes R/S for this SBU');
    assert.ok(!('payment_terms_days' in sq), 'payment_terms_days must be ABSENT');
    assert.ok(!('unit_cost' in sq.lines[0]), 'unit_cost must be ABSENT');
    assert.ok('quantity' in sq.lines[0], 'the quantity is not sensitive');
  });

  test('PM holds no supplier_quotes permission, so the section is null', async () => {
    const token = await H.login(HOLDER.PM);
    const r = await H.get(`/api/v1/procurement/requests/${fx.procRequestId}`, token);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.supplier_quotes, null);
  });

  test('ACCOUNTS sees the supplier unit cost', async () => {
    const token = await H.login(HOLDER.ACCOUNTS);
    const r = await H.get(`/api/v1/procurement/requests/${fx.procRequestId}`, token);
    assert.equal(r.status, 200);
    const sq = r.body.data.supplier_quotes.find((x: any) => x.id === fx.supplierQuoteId);
    assert.equal(sq.lines[0].unit_cost, 300);
  });

  test('the supplier payment terms are masked on the supplier master too', async () => {
    const sales = await H.login(HOLDER.SALES);
    const r = await H.get('/api/v1/suppliers?limit=200', sales);
    assert.equal(r.status, 200);
    const row = r.body.data.find((s: any) => s.name === `Test Supplier ${H.STAMP}`);
    assert.ok(row, 'SALES holds suppliers R/A');
    assert.ok(!('payment_terms_days' in row), 'SALES has no supplier_terms group');
    assert.ok(!('credit_limit' in row), 'SALES has no supplier_terms group');

    const buyer = await H.login(HOLDER.PROCUREMENT);
    const r2 = await H.get('/api/v1/suppliers?limit=200', buyer);
    const row2 = r2.body.data.find((s: any) => s.name === `Test Supplier ${H.STAMP}`);
    assert.ok('payment_terms_days' in row2, 'PROCUREMENT holds supplier_terms');
  });

  test('the employee internal day rate is masked from everyone but the day_rate holders', async () => {
    for (const role of ['SALES', 'PROCUREMENT', 'TECHNICAL', 'PM', 'SBU_HEAD', 'SALES_MGR'] as RoleCode[]) {
      const token = await H.login(HOLDER[role]);
      const r = await H.get('/api/v1/employees?limit=200', token);
      assert.equal(r.status, 200);
      const other = r.body.data.find((e: any) => e.id !== fx.m.employees[HOLDER[role]]);
      assert.ok(other, `${role}: expected at least one other employee`);
      assert.ok(!('internal_day_rate' in other), `${role} must not see another employee's day rate`);
    }
  });
});

/* ═════════════════════════ 7. field masking: technical estimates ═════════════════════════ */

const SERVICE_COST = ['estimated_service_cost', 'travel_cost'] as const;

describe('field masking on technical estimates (the own-only service_cost group)', () => {
  test('the engineer who typed the service cost can read it back', async () => {
    const token = await H.login(HOLDER.TECHNICAL);
    const r = await H.get(`/api/v1/estimation/requests/${fx.estRequestId}`, token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const est = r.body.data.estimate;
    assert.ok(est, 'the engineer must see their own estimate');
    assertPresent(est, SERVICE_COST, 'TECHNICAL own estimate');
    assert.equal(est.estimated_service_cost, 12_000);
    assert.equal(est.travel_cost, 500);
  });

  test('the service cost comes back on the submit response itself', async () => {
    // A second version, so the assertion covers the POST payload and not only a re-read.
    const engineer = await H.login(HOLDER.TECHNICAL);
    const r = await H.post(`/api/v1/estimation/requests/${fx.estRequestId}/estimate`, engineer, {
      scopeUnderstanding: `Revised ${H.STAMP}`, proposedSolution: `Revised solution ${H.STAMP}`,
      totalDays: 5, estimatedServiceCost: 15_000, currency: 'AED', travelRequired: false, resources: [],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.estimate.estimated_service_cost, 15_000,
      'the submitter must get back the figure they just entered');
  });

  test('the owning salesperson sees the service cost, to price the deal (OD-10)', async () => {
    const token = await H.login(HOLDER.SALES);
    const r = await H.get(`/api/v1/estimation/requests/${fx.estRequestId}`, token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assertPresent(r.body.data.estimate, ['estimated_service_cost'], 'SALES own enquiry');
  });

  test('the SBU head holds service_cost outright', async () => {
    const token = await H.login(HOLDER.SBU_HEAD);
    const r = await H.get(`/api/v1/estimation/requests/${fx.estRequestId}`, token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assertPresent(r.body.data.estimate, SERVICE_COST, 'SBU_HEAD');
  });

  test('a PM on the same enquiry sees no service cost at all', async () => {
    const token = await H.login(HOLDER.PM);
    const r = await H.get(`/api/v1/estimation/requests/${fx.estRequestId}`, token);
    if (r.status === 200 && r.body.data.estimate) {
      assertAbsent(r.body.data.estimate, SERVICE_COST, 'PM');
    } else {
      assert.equal(r.status, 404, 'a PM outside the scope must get 404, never a leak');
    }
  });

  test('PROCUREMENT and ACCOUNTS hold no technical_estimations permission at all', async () => {
    for (const role of ['PROCUREMENT', 'ACCOUNTS'] as RoleCode[]) {
      const token = await H.login(HOLDER[role]);
      const r = await H.get(`/api/v1/estimation/requests/${fx.estRequestId}`, token);
      assert.equal(r.status, 403, `${role} must be refused, got ${r.status}`);
    }
  });

  test('an engineer in another SBU cannot read the estimate', async () => {
    // Anand sits in SBU2; this request belongs to SBU1 and is assigned to Thousif.
    const token = await H.login('anand@greenware.ae');
    const r = await H.get(`/api/v1/estimation/requests/${fx.estRequestId}`, token);
    assert.equal(r.status, 404, 'out of scope is 404, never 403 or a leak');
  });
});
