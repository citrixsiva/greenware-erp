/**
 * Golden fixtures for the margin arithmetic, and the OD-06 margin-rule splits.
 *
 * The line figures are generated columns in Postgres:
 *   line_sell = quantity * unit_price * (1 - discount_pct/100)
 *   line_cost = quantity * unit_cost
 *   line_gp   = line_sell - line_cost
 * and the version roll-up is computed by computeMargin() in SQL. Nothing here
 * recomputes them in JavaScript: each expectation is a hand-checked constant.
 */
import './env.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as H from './helpers.js';

const CREATOR = 'siva@greenware.ae'; // only a supplier_cost holder may set unit_cost
const OWNER = 'naveen@greenware.ae';

/** money_amt is numeric(18,4) and pct is numeric(9,4); every constant below is exact at 4dp. */
interface Golden {
  quantity: number; unitPrice: number; discountPct: number; unitCost: number;
  lineSell: number; lineCost: number; lineGp: number; marginPct: number;
  note: string;
}

const GOLDEN: Golden[] = [
  { quantity: 2, unitPrice: 500, discountPct: 10, unitCost: 300,
    lineSell: 900, lineCost: 600, lineGp: 300, marginPct: 33.3333,
    note: '2 × 500 less 10% = 900 sell against 600 cost' },
  { quantity: 1, unitPrice: 1000, discountPct: 0, unitCost: 750,
    lineSell: 1000, lineCost: 750, lineGp: 250, marginPct: 25,
    note: 'no discount' },
  { quantity: 3, unitPrice: 333.33, discountPct: 12, unitCost: 200,
    lineSell: 879.9912, lineCost: 600, lineGp: 279.9912, marginPct: 31.8175,
    note: 'fractional price, 3 × 333.33 × 0.88' },
  { quantity: 1.5, unitPrice: 100, discountPct: 33.333, unitCost: 40,
    lineSell: 100.0005, lineCost: 60, lineGp: 40.0005, marginPct: 40.0003,
    note: 'fractional quantity and a 3dp discount' },
  { quantity: 10, unitPrice: 100, discountPct: 0, unitCost: 100,
    lineSell: 1000, lineCost: 1000, lineGp: 0, marginPct: 0,
    note: 'sold at cost: zero gross profit' },
];

// Hand-added, not summed by the test: Σ lineSell / Σ lineCost / Σ lineGp.
const TOTAL_SELL = 3879.9917;
const TOTAL_COST = 3010;
const TOTAL_GP = 869.9917;
const TOTAL_MARGIN_PCT = 22.4225; // 869.9917 / 3879.9917 × 100, to 4dp
// VAT5 applies to every seeded line: 5% of the discounted sell value.
const TOTAL_TAX = 193.9996; // 3879.9917 × 0.05 = 193.999585 → 193.9996

/** OD-06: the margin split per business type. */
const OD06: Record<string, [number, number, number]> = {
  PRODUCT: [80, 20, 0],
  LICENCE: [80, 20, 0],
  PS: [20, 80, 0],
  AMC: [20, 80, 0],
  SLA: [20, 80, 0],
  MANAGED: [20, 80, 0],
  PRODUCT_PS: [20, 80, 0],
  PROJECT: [20, 80, 0],
  RENEWAL: [50, 0, 50],
};

const MIN_MARGIN_PCT = 3; // OD-09: the hard floor, the same for every business type

interface Fixture {
  m: H.Masters;
  productVersionId: string;
  renewalVersionId: string;
}
let fx: Fixture;

before(async () => {
  const m = await H.masters();

  const productEnq = await H.createEnquiry(OWNER, m, { businessType: 'PRODUCT', title: `Margin golden ${H.STAMP}` });
  const product = await H.createQuotation(CREATOR, productEnq.id, GOLDEN.map(g => ({
    quantity: g.quantity, unitPrice: g.unitPrice, discountPct: g.discountPct, unitCost: g.unitCost,
  })));

  // A second quotation on a RENEWAL enquiry, where the split is 50 sales / 0 technical / 50 company.
  const renewalEnq = await H.createEnquiry(OWNER, m, { businessType: 'RENEWAL', title: `Margin renewal ${H.STAMP}` });
  const renewal = await H.createQuotation(CREATOR, renewalEnq.id, [
    { quantity: 2, unitPrice: 500, discountPct: 10, unitCost: 300 },
  ]);

  fx = { m, productVersionId: product.versionId, renewalVersionId: renewal.versionId };
});

after(() => H.closePool());

/* ═════════════════════════ 1. the line arithmetic ═════════════════════════ */

describe('line arithmetic: line_sell, line_cost, line_gp', () => {
  for (const [i, g] of GOLDEN.entries()) {
    test(`line ${i + 1}: ${g.note}`, async () => {
      const rows = await H.sql(
        `SELECT line_no, quantity, unit_cost, unit_price, discount_pct, line_sell, line_cost, line_gp
           FROM gw.quotation_lines WHERE quotation_version_id = $1 AND line_no = $2`,
        [fx.productVersionId, i + 1]);
      assert.equal(rows.length, 1, `line ${i + 1} should exist`);
      const l = rows[0];
      assert.equal(Number(l.quantity), g.quantity, 'quantity stored as sent');
      assert.equal(Number(l.unit_price), g.unitPrice, 'unit_price stored as sent');
      assert.equal(Number(l.discount_pct), g.discountPct, 'discount_pct stored as sent');
      assert.equal(Number(l.unit_cost), g.unitCost, 'unit_cost stored as sent');
      assert.equal(Number(l.line_sell), g.lineSell, 'line_sell = qty × unit_price × (1 − disc/100)');
      assert.equal(Number(l.line_cost), g.lineCost, 'line_cost = qty × unit_cost');
      assert.equal(Number(l.line_gp), g.lineGp, 'line_gp = line_sell − line_cost');
    });
  }

  test('line_gp is always line_sell minus line_cost, never recomputed from the inputs', async () => {
    const rows = await H.sql(
      `SELECT line_no, line_sell, line_cost, line_gp FROM gw.quotation_lines
        WHERE quotation_version_id = $1 ORDER BY line_no`, [fx.productVersionId]);
    assert.equal(rows.length, GOLDEN.length);
    for (const l of rows) {
      // tolerance covers the JavaScript subtraction only; the stored value is exact numeric(18,4)
      assert.ok(Math.abs(Number(l.line_gp) - (Number(l.line_sell) - Number(l.line_cost))) < 1e-9,
        `line ${l.line_no}: line_gp ${l.line_gp} should be ${l.line_sell} − ${l.line_cost}`);
    }
  });

  test('a line sold at cost has exactly zero gross profit, not a rounding residue', async () => {
    const l = await H.sql1(
      `SELECT line_gp FROM gw.quotation_lines WHERE quotation_version_id = $1 AND line_no = 5`,
      [fx.productVersionId]);
    assert.equal(Number(l!.line_gp), 0);
  });
});

/* ═════════════════════════ 2. the version roll-up ═════════════════════════ */

describe('version roll-up: total_sell, total_cost, gross_profit, gross_margin_pct', () => {
  test('the stored totals match the golden sums', async () => {
    const v = await H.sql1(
      `SELECT total_sell, total_cost, total_tax, gross_profit, gross_margin_pct,
              other_project_cost, operation_charges, training_charges
         FROM gw.quotation_versions WHERE id = $1`, [fx.productVersionId]);
    assert.ok(v);
    assert.equal(Number(v.other_project_cost), 0);
    assert.equal(Number(v.operation_charges), 0);
    assert.equal(Number(v.training_charges), 0);
    assert.equal(Number(v.total_sell), TOTAL_SELL, 'total_sell = Σ line_sell');
    assert.equal(Number(v.total_cost), TOTAL_COST, 'total_cost = Σ line_cost + the three cost adders');
    assert.equal(Number(v.gross_profit), TOTAL_GP, 'gross_profit = total_sell − total_cost');
    assert.equal(Number(v.gross_margin_pct), TOTAL_MARGIN_PCT, 'gross_margin_pct = gross_profit / total_sell × 100');
    assert.equal(Number(v.total_tax), TOTAL_TAX, 'total_tax is VAT on the discounted line values');
  });

  test('the cost adders are folded into total_cost and the margin', async () => {
    const creator = await H.login(CREATOR);
    const enq = await H.createEnquiry(OWNER, fx.m, { businessType: 'PRODUCT', title: `Adders ${H.STAMP}` });
    const q = await H.createQuotation(CREATOR, enq.id, [
      { quantity: 1, unitPrice: 1000, discountPct: 0, unitCost: 600 },
    ]);
    const r = await H.patch(`/api/v1/quotation-versions/${q.versionId}`, creator, {
      otherProjectCost: 100, operationCharges: 50, trainingCharges: 25,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const v = r.body.data;
    assert.equal(v.total_sell, 1000);
    assert.equal(v.total_cost, 775, '600 line cost + 100 + 50 + 25');
    assert.equal(v.gross_profit, 225);
    assert.equal(v.gross_margin_pct, 22.5);
  });

  test('a version that totals zero has a null gross_margin_pct, not a division by zero', async () => {
    const creator = await H.login(CREATOR);
    const enq = await H.createEnquiry(OWNER, fx.m, { businessType: 'PRODUCT', title: `Zero ${H.STAMP}` });
    const r = await H.post('/api/v1/quotations', creator, {
      enquiryId: enq.id,
      lines: [{ description: `Free of charge ${H.STAMP}`, quantity: 1, unitPrice: 0, discountPct: 0, unitCost: 0 }],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const v = r.body.data.versions[0];
    assert.equal(v.total_sell, 0);
    assert.equal(v.gross_profit, 0);
    assert.equal(v.gross_margin_pct, null);
  });
});

/* ═════════════════════════ 3. OD-06 margin rules ═════════════════════════ */

describe('OD-06: the seeded margin_rules splits', () => {
  for (const [code, [sales, technical, company]] of Object.entries(OD06)) {
    test(`${code} splits ${sales} sales / ${technical} technical / ${company} company`, async () => {
      const rows = await H.sql(
        `SELECT mr.sales_share_pct, mr.technical_share_pct, mr.company_share_pct, mr.min_margin_pct
           FROM gw.margin_rules mr JOIN gw.business_types bt ON bt.id = mr.business_type_id
          WHERE bt.code = $1 AND (mr.effective_to IS NULL OR mr.effective_to >= current_date)`, [code]);
      assert.equal(rows.length, 1, `${code} should have exactly one rule in force`);
      const r = rows[0];
      assert.equal(Number(r.sales_share_pct), sales);
      assert.equal(Number(r.technical_share_pct), technical);
      assert.equal(Number(r.company_share_pct), company);
      assert.equal(Number(r.min_margin_pct), MIN_MARGIN_PCT, 'OD-09: the hard floor is 3%');
    });
  }

  test('every margin_rules row sums to exactly 100', async () => {
    const rows = await H.sql(
      `SELECT bt.code, mr.sales_share_pct, mr.technical_share_pct, mr.company_share_pct
         FROM gw.margin_rules mr JOIN gw.business_types bt ON bt.id = mr.business_type_id`);
    assert.ok(rows.length >= Object.keys(OD06).length, 'every business type needs a rule');
    for (const r of rows) {
      const sum = Number(r.sales_share_pct) + Number(r.technical_share_pct) + Number(r.company_share_pct);
      assert.equal(sum, 100, `${r.code} shares sum to ${sum}`);
    }
  });

  test('every margin_rules row has min_margin_pct = 3', async () => {
    const rows = await H.sql(
      `SELECT bt.code, mr.min_margin_pct FROM gw.margin_rules mr
         JOIN gw.business_types bt ON bt.id = mr.business_type_id`);
    for (const r of rows) {
      assert.equal(Number(r.min_margin_pct), MIN_MARGIN_PCT, `${r.code} floor is ${r.min_margin_pct}`);
    }
  });

  test('warn_margin_pct is at or above the floor for every business type', async () => {
    const rows = await H.sql(
      `SELECT bt.code, mr.min_margin_pct, mr.warn_margin_pct FROM gw.margin_rules mr
         JOIN gw.business_types bt ON bt.id = mr.business_type_id`);
    for (const r of rows) {
      assert.ok(Number(r.warn_margin_pct) >= Number(r.min_margin_pct),
        `${r.code}: warn ${r.warn_margin_pct} must not sit below the floor ${r.min_margin_pct}`);
    }
  });

  test('every business type has a rule in force today', async () => {
    const missing = await H.sql<{ code: string }>(
      `SELECT bt.code FROM gw.business_types bt
        WHERE NOT EXISTS (SELECT 1 FROM gw.margin_rules mr
                           WHERE mr.business_type_id = bt.id
                             AND mr.effective_from <= current_date
                             AND (mr.effective_to IS NULL OR mr.effective_to >= current_date))`);
    assert.deepEqual(missing.map(r => r.code), [], 'business types without a live margin rule');
  });
});

/* ═════════════════════════ 4. attribution through the API ═════════════════════════ */

describe('margin attribution applies the rule for the business type', () => {
  test('PRODUCT: 80/20/0 of the gross profit, company takes the rounding remainder', async () => {
    const token = await H.login(CREATOR);
    const r = await H.get(`/api/v1/quotation-versions/${fx.productVersionId}/margin`, token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = r.body.data;
    assert.equal(d.totals.totalSell, TOTAL_SELL);
    assert.equal(d.totals.totalCost, TOTAL_COST);
    assert.equal(d.totals.grossProfit, TOTAL_GP);
    assert.equal(d.totals.grossMarginPct, TOTAL_MARGIN_PCT);

    assert.equal(d.rule.salesSharePct, 80);
    assert.equal(d.rule.technicalSharePct, 20);
    assert.equal(d.rule.companySharePct, 0);
    assert.equal(d.rule.minMarginPct, MIN_MARGIN_PCT);

    assert.equal(d.attributionSource, 'rule');
    assert.equal(d.attribution.sales, 695.99, 'ROUND(869.9917 × 80%, 2)');
    assert.equal(d.attribution.technical, 174, 'ROUND(869.9917 × 20%, 2)');
    assert.equal(d.attribution.company, 0.0017, 'the remainder, so the three parts add back to the gross profit');
    const parts = Number(d.attribution.sales) + Number(d.attribution.technical) + Number(d.attribution.company);
    assert.ok(Math.abs(parts - TOTAL_GP) < 1e-9, `attribution ${parts} must add back to gross_profit ${TOTAL_GP}`);
  });

  test('RENEWAL: 50 sales / 0 technical / 50 company', async () => {
    const token = await H.login(CREATOR);
    const r = await H.get(`/api/v1/quotation-versions/${fx.renewalVersionId}/margin`, token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = r.body.data;
    assert.equal(d.totals.grossProfit, 300);
    assert.equal(d.rule.salesSharePct, 50);
    assert.equal(d.rule.technicalSharePct, 0);
    assert.equal(d.rule.companySharePct, 50);
    assert.equal(d.attribution.sales, 150);
    assert.equal(d.attribution.technical, 0);
    assert.equal(d.attribution.company, 150);
  });

  test('the per-line margin percentages match the golden fixtures', async () => {
    const token = await H.login(CREATOR);
    const r = await H.get(`/api/v1/quotation-versions/${fx.productVersionId}/margin`, token);
    assert.equal(r.status, 200);
    const lines = r.body.data.lines;
    assert.equal(lines.length, GOLDEN.length);
    for (const [i, g] of GOLDEN.entries()) {
      const l = lines[i];
      assert.equal(l.lineNo, i + 1);
      assert.equal(Number(l.lineSell), g.lineSell);
      assert.equal(Number(l.lineCost), g.lineCost);
      assert.equal(Number(l.lineGp), g.lineGp);
      if (g.lineSell === 0) {
        assert.equal(l.marginPct, null, 'a zero-value line has no margin percentage');
      } else {
        assert.ok(Math.abs(Number(l.marginPct) - g.marginPct) < 1e-4,
          `line ${i + 1}: margin ${l.marginPct} should be ${g.marginPct}`);
      }
    }
  });

  test('the margin floor from the rule is what the submit gate uses (OD-09)', async () => {
    // 2.5% gross margin on a PRODUCT line: below the 3% floor, so submission is refused outright.
    const creator = await H.login(CREATOR);
    const enq = await H.createEnquiry(OWNER, fx.m, { businessType: 'PRODUCT', title: `Floor ${H.STAMP}` });
    const q = await H.createQuotation(CREATOR, enq.id, [
      { quantity: 1, unitPrice: 1000, discountPct: 0, unitCost: 975 },
    ]);
    const v = await H.sql1(`SELECT gross_margin_pct FROM gw.quotation_versions WHERE id = $1`, [q.versionId]);
    assert.equal(Number(v!.gross_margin_pct), 2.5);

    const r = await H.post(`/api/v1/quotation-versions/${q.versionId}/submit`, creator, {});
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.error.code, 'gate_blocked');
    assert.equal(r.body.error.details.minMarginPct, MIN_MARGIN_PCT);
    assert.equal(r.body.error.details.grossMarginPct, 2.5);
  });
});
