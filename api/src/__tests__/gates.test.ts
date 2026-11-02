/**
 * The workflow gates, driven through the HTTP API where a route owns the gate
 * and through direct SQL where the gate is a database constraint or trigger.
 *
 *  1. an enquiry cannot be set to Lost without a loss reason
 *     (route gate + enq_loss_reason_required check constraint)
 *  2. an approved/submitted quotation version cannot be edited
 *     (gw.fn_quote_version_immutable raises)
 *  3. a customer_invoice row cannot exist without a customer_po_id
 *     (NOT NULL on customer_invoices.customer_po_id)
 *  4. a project cannot be Completed without a signoff or a closure override
 *     (prj_closure_gate check constraint)
 */
import './env.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as H from './helpers.js';

const ADMIN = 'siva@greenware.ae';
const OWNER = 'naveen@greenware.ae';

interface Fixture {
  m: H.Masters;
  /** A fresh enquiry used only by the Lost gate. */
  lostEnquiryId: string;
  /** An enquiry whose quotation has been submitted, so its version is frozen. */
  frozenEnquiryId: string;
  frozenQuotationId: string;
  frozenVersionId: string;
  frozenLineId: string;
  customerPoId: string;
  sowVersionId: string;
  projectId: string;
}
let fx: Fixture;

before(async () => {
  const m = await H.masters();
  const admin = await H.login(ADMIN);

  const lost = await H.createEnquiry(OWNER, m, { title: `Gate lost ${H.STAMP}` });

  // A quotation comfortably above the PRODUCT warn threshold (12%), so submit
  // goes straight through to Approved → Submitted rather than raising approval.
  const frozenEnq = await H.createEnquiry(OWNER, m, { title: `Gate frozen ${H.STAMP}` });
  const quote = await H.createQuotation(ADMIN, frozenEnq.id, [
    { quantity: 2, unitPrice: 500, discountPct: 10, unitCost: 300 },
  ]);
  const submit = await H.post(`/api/v1/quotation-versions/${quote.versionId}/submit`, admin, {});
  assert.equal(submit.status, 200, `submit should clear the margin gate: ${JSON.stringify(submit.body)}`);
  assert.equal(submit.body.data.version.status, 'Submitted');
  const line = (await H.sql<{ id: string }>(
    `SELECT id FROM gw.quotation_lines WHERE quotation_version_id = $1 ORDER BY line_no LIMIT 1`,
    [quote.versionId]))[0];

  // A customer PO, its SOW and a project, for gates 3 and 4.
  const po = (await H.sql<{ id: string }>(
    `INSERT INTO gw.customer_pos
       (po_ref, customer_po_number, company_id, customer_id, enquiry_id, quotation_version_id, account_manager_id,
        po_date, po_received_date, currency, po_amount, tax_amount, net_value, payment_terms_days)
     VALUES ($1,$2,$3,$4,$5,$6,$7, current_date, current_date, 'AED', 945, 45, 900, 45)
     RETURNING id`,
    [`PO-G-${H.STAMP}`, `CUST-PO-G-${H.STAMP}`, m.companyId, m.customerId, frozenEnq.id, quote.versionId,
     m.employees[OWNER]]))[0];

  const sow = (await H.sql<{ id: string }>(
    `INSERT INTO gw.sow_versions (customer_po_id, version_no, scope) VALUES ($1, 1, $2) RETURNING id`,
    [po.id, `Scope for ${H.STAMP}`]))[0];
  await H.sql(`UPDATE gw.customer_pos SET sow_version_id = $2 WHERE id = $1`, [po.id, sow.id]);

  const prj = (await H.sql<{ id: string }>(
    `INSERT INTO gw.projects
       (project_no, company_id, customer_po_id, sow_version_id, customer_id, name, sbu_id, project_manager_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Created') RETURNING id`,
    [`PRJ-G-${H.STAMP}`.slice(0, 32), m.companyId, po.id, sow.id, m.customerId,
     `Gate project ${H.STAMP}`, m.sbus.SBU1, m.employees['aishwarya@greenware.ae']]))[0];

  fx = {
    m, lostEnquiryId: lost.id, frozenEnquiryId: frozenEnq.id, frozenQuotationId: quote.quotationId,
    frozenVersionId: quote.versionId, frozenLineId: line.id, customerPoId: po.id, sowVersionId: sow.id,
    projectId: prj.id,
  };
});

after(() => H.closePool());

/* ═════════════════════════ Gate 1: Lost needs a loss reason ═════════════════════════ */

describe('an enquiry cannot be Lost without a loss reason', () => {
  test('the route refuses Lost with no lossReasonId', async () => {
    const token = await H.login(OWNER);
    const r = await H.post(`/api/v1/enquiries/${fx.lostEnquiryId}/stage`, token, { stage: 'Lost' });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.error.code, 'gate_blocked');
    assert.match(String(r.body.error.message), /loss reason/i, 'the message must say what to do next');
  });

  test('the route refuses a loss reason that is not on the list', async () => {
    const token = await H.login(OWNER);
    const r = await H.post(`/api/v1/enquiries/${fx.lostEnquiryId}/stage`, token, {
      stage: 'Lost', lossReasonId: '00000000-0000-0000-0000-000000000000',
    });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.error.code, 'gate_blocked');
  });

  test('the enquiry is still open after the refused attempts', async () => {
    const row = await H.sql1<{ stage: string; loss_reason_id: string | null }>(
      `SELECT stage::text AS stage, loss_reason_id FROM gw.enquiries WHERE id = $1`, [fx.lostEnquiryId]);
    assert.equal(row!.stage, 'New');
    assert.equal(row!.loss_reason_id, null);
  });

  test('the database refuses stage = Lost with a null loss_reason_id even behind the route', async () => {
    const e = await H.sqlError(
      `UPDATE gw.enquiries SET stage = 'Lost', loss_reason_id = NULL WHERE id = $1`, [fx.lostEnquiryId]);
    assert.ok(e, 'the check constraint must fire');
    assert.equal(e.code, '23514', 'check_violation');
    assert.match(e.message, /enq_loss_reason_required/);
  });

  test('a brand-new enquiry cannot be inserted as Lost without a loss reason', async () => {
    const m = fx.m;
    const e = await H.sqlError(
      `INSERT INTO gw.enquiries
         (enquiry_no, company_id, customer_id, account_manager_id, business_type_id, title, received_at, stage)
       VALUES ($1,$2,$3,$4,$5,$6, now(), 'Lost')`,
      [`ENQ-GATE-${H.STAMP}`.slice(0, 32), m.companyId, m.customerId, m.employees[OWNER],
       m.businessTypes.PRODUCT, `Insert lost ${H.STAMP}`]);
    assert.equal(e?.code, '23514');
  });

  test('with a real loss reason the stage moves and the history is written', async () => {
    const token = await H.login(OWNER);
    const r = await H.post(`/api/v1/enquiries/${fx.lostEnquiryId}/stage`, token, {
      stage: 'Lost', lossReasonId: fx.m.lossReasonId, lossRemarks: `Lost on price ${H.STAMP}`,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.stage, 'Lost');
    const row = await H.sql1<{ stage: string; loss_reason_id: string }>(
      `SELECT stage::text AS stage, loss_reason_id FROM gw.enquiries WHERE id = $1`, [fx.lostEnquiryId]);
    assert.equal(row!.loss_reason_id, fx.m.lossReasonId);
    const hist = await H.sql(
      `SELECT from_stage::text AS from_stage, to_stage::text AS to_stage FROM gw.stage_history WHERE enquiry_id = $1`,
      [fx.lostEnquiryId]);
    assert.ok(hist.some(h => h.to_stage === 'Lost'), 'the stage trigger must log the move');
  });
});

describe('the other closing gates on the enquiry stage', () => {
  test('Won is refused until a customer PO is on file', async () => {
    const token = await H.login(OWNER);
    const enq = await H.createEnquiry(OWNER, fx.m, { title: `Gate won ${H.STAMP}` });
    const r = await H.post(`/api/v1/enquiries/${enq.id}/stage`, token, { stage: 'Won' });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.error.code, 'gate_blocked');
    assert.match(String(r.body.error.message), /customer PO/i);
  });

  test('Submitted is refused until a quotation version is approved or submitted', async () => {
    const token = await H.login(OWNER);
    const enq = await H.createEnquiry(OWNER, fx.m, { title: `Gate submitted ${H.STAMP}` });
    const r = await H.post(`/api/v1/enquiries/${enq.id}/stage`, token, { stage: 'Submitted' });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.match(String(r.body.error.message), /approved quotation/i);
  });

  test('Won succeeds once the PO exists', async () => {
    const token = await H.login(OWNER);
    const r = await H.post(`/api/v1/enquiries/${fx.frozenEnquiryId}/stage`, token, { stage: 'Won' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.stage, 'Won');
  });

  test('Cancelled and Dropped are refused without remarks', async () => {
    const token = await H.login(OWNER);
    const enq = await H.createEnquiry(OWNER, fx.m, { title: `Gate cancel ${H.STAMP}` });
    for (const stage of ['Cancelled', 'Dropped']) {
      const r = await H.post(`/api/v1/enquiries/${enq.id}/stage`, token, { stage });
      assert.equal(r.status, 422, `${stage}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error.code, 'gate_blocked');
    }
  });
});

/* ═════════════════════════ Gate 2: a frozen version is immutable ═════════════════════════ */

describe('an approved quotation version cannot be edited', () => {
  test('the fixture version really is frozen', async () => {
    const v = await H.sql1<{ status: string }>(
      `SELECT status::text AS status FROM gw.quotation_versions WHERE id = $1`, [fx.frozenVersionId]);
    assert.equal(v!.status, 'Submitted');
  });

  test('PATCH on the version is refused with gate_blocked', async () => {
    const token = await H.login(ADMIN);
    const r = await H.patch(`/api/v1/quotation-versions/${fx.frozenVersionId}`, token, {
      warranty: `Rewritten ${H.STAMP}`,
    });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.error.code, 'gate_blocked');
    assert.match(String(r.body.error.message), /frozen/i);
    assert.match(String(r.body.error.message), /next version/i, 'the message must say what to do next');
  });

  test('adding a line to the frozen version is refused', async () => {
    const token = await H.login(ADMIN);
    const r = await H.post(`/api/v1/quotation-versions/${fx.frozenVersionId}/lines`, token, {
      description: `Sneaked in ${H.STAMP}`, quantity: 1, unitPrice: 10, unitCost: 5,
    });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.error.code, 'gate_blocked');
  });

  test('editing a line of the frozen version is refused', async () => {
    const token = await H.login(ADMIN);
    const r = await H.patch(`/api/v1/quotation-lines/${fx.frozenLineId}`, token, { unitPrice: 1 });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.error.code, 'gate_blocked');
  });

  test('deleting a line of the frozen version is refused', async () => {
    const token = await H.login(ADMIN);
    const r = await H.del(`/api/v1/quotation-lines/${fx.frozenLineId}`, token);
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.error.code, 'gate_blocked');
  });

  test('submitting it again is refused', async () => {
    const token = await H.login(ADMIN);
    const r = await H.post(`/api/v1/quotation-versions/${fx.frozenVersionId}/submit`, token, {});
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.error.code, 'gate_blocked');
  });

  test('fn_quote_version_immutable raises on a direct UPDATE behind the API', async () => {
    const e = await H.sqlError(
      `UPDATE gw.quotation_versions SET total_sell = total_sell + 1 WHERE id = $1`, [fx.frozenVersionId]);
    assert.ok(e, 'the trigger must raise');
    assert.equal(e.code, 'P0001', 'raise_exception');
    assert.match(e.message, /frozen/i);
  });

  test('the frozen version still holds its original figures', async () => {
    const v = await H.sql1<{ total_sell: number; total_cost: number; warranty: string | null }>(
      `SELECT total_sell, total_cost, warranty FROM gw.quotation_versions WHERE id = $1`, [fx.frozenVersionId]);
    assert.equal(Number(v!.total_sell), 900);
    assert.equal(Number(v!.total_cost), 600);
    assert.equal(v!.warranty, null, 'the refused PATCH must not have landed');
  });

  test('the sanctioned path is a new version, which is allowed', async () => {
    const token = await H.login(ADMIN);
    const r = await H.post(`/api/v1/quotations/${fx.frozenQuotationId}/versions`, token, {
      warranty: `12 months ${H.STAMP}`,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const versions = r.body.data.versions;
    assert.equal(versions.length, 2);
    const v2 = versions.find((v: any) => v.version_no === 2);
    assert.equal(v2.status, 'Draft');
    assert.equal(v2.warranty, `12 months ${H.STAMP}`);
    // the costs are copied server-side, not taken from the client
    assert.equal(v2.total_cost, 600);
    assert.equal(v2.total_sell, 900);
  });
});

/* ═════════════════════════ Gate 3: no invoice without a customer PO ═════════════════════════ */

describe('a customer invoice cannot exist without a customer PO', () => {
  const insert = (poRef: string) =>
    `INSERT INTO gw.customer_invoices
       (invoice_no, company_id, customer_id, customer_po_id, invoice_date, currency,
        taxable_amount, tax_amount, total_amount, payment_terms_days, due_date)
     VALUES ($1, $2, $3, ${poRef}, current_date, 'AED', 900, 45, 945, 45, current_date + 45)`;

  test('an explicit NULL customer_po_id is refused', async () => {
    const e = await H.sqlError(insert('NULL'), [`INV-NULL-${H.STAMP}`.slice(0, 32), fx.m.companyId, fx.m.customerId]);
    assert.ok(e, 'the NOT NULL constraint must fire');
    assert.equal(e.code, '23502', 'not_null_violation');
    assert.match(e.message, /customer_po_id/);
  });

  test('omitting customer_po_id altogether is refused', async () => {
    const e = await H.sqlError(
      `INSERT INTO gw.customer_invoices
         (invoice_no, company_id, customer_id, invoice_date, currency,
          taxable_amount, tax_amount, total_amount, payment_terms_days, due_date)
       VALUES ($1, $2, $3, current_date, 'AED', 900, 45, 945, 45, current_date + 45)`,
      [`INV-OMIT-${H.STAMP}`.slice(0, 32), fx.m.companyId, fx.m.customerId]);
    assert.equal(e?.code, '23502');
  });

  test('a customer_po_id that does not exist is refused', async () => {
    const e = await H.sqlError(
      insert(`'00000000-0000-0000-0000-000000000000'::uuid`),
      [`INV-FK-${H.STAMP}`.slice(0, 32), fx.m.companyId, fx.m.customerId]);
    assert.equal(e?.code, '23503', 'foreign_key_violation');
  });

  test('with a real customer PO the invoice is accepted', async () => {
    const e = await H.sqlError(
      insert('$4::uuid'),
      [`INV-OK-${H.STAMP}`.slice(0, 32), fx.m.companyId, fx.m.customerId, fx.customerPoId]);
    assert.equal(e, null, 'the only thing the gate asks for is the PO');
  });

  test('no invoice row anywhere is missing its PO', async () => {
    const orphans = await H.sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM gw.customer_invoices WHERE customer_po_id IS NULL`);
    assert.equal(orphans[0].n, 0);
  });
});

/* ═════════════════════════ Gate 4: no project closure without sign-off ═════════════════════════ */

describe('a project cannot be Completed without a sign-off or a closure override', () => {
  test('the fixture project has neither', async () => {
    const p = await H.sql1<{ status: string; signoff_id: string | null; closure_override_id: string | null }>(
      `SELECT status::text AS status, signoff_id, closure_override_id FROM gw.projects WHERE id = $1`, [fx.projectId]);
    assert.equal(p!.status, 'Created');
    assert.equal(p!.signoff_id, null);
    assert.equal(p!.closure_override_id, null);
  });

  test('setting status = Completed is refused by prj_closure_gate', async () => {
    const e = await H.sqlError(`UPDATE gw.projects SET status = 'Completed' WHERE id = $1`, [fx.projectId]);
    assert.ok(e, 'the check constraint must fire');
    assert.equal(e.code, '23514', 'check_violation');
    assert.match(e.message, /prj_closure_gate/);
  });

  test('inserting a project straight into Completed is refused too', async () => {
    const m = fx.m;
    const e = await H.sqlError(
      `INSERT INTO gw.projects
         (project_no, company_id, customer_po_id, sow_version_id, customer_id, name, status)
       VALUES ($1,$2,$3,$4,$5,$6,'Completed')`,
      [`PRJ-X-${H.STAMP}`.slice(0, 32), m.companyId, fx.customerPoId, fx.sowVersionId, m.customerId,
       `Insert completed ${H.STAMP}`]);
    assert.equal(e?.code, '23514');
  });

  test('other statuses are unaffected by the gate', async () => {
    for (const status of ['InProgress', 'OnHold']) {
      const e = await H.sqlError(`UPDATE gw.projects SET status = $2::gw.project_status WHERE id = $1`,
        [fx.projectId, status]);
      // a status the enum does not carry would be 22P02; anything else means the gate over-reaches
      if (e) assert.notEqual(e.code, '23514', `${status} must not trip prj_closure_gate`);
    }
  });

  test('a recorded sign-off opens the gate', async () => {
    await H.sqlRollback(async (q) => {
      const so = (await q(
        `INSERT INTO gw.signoffs (project_id, signoff_date, signed_by_name, recorded_by)
         VALUES ($1, current_date, $2, $3) RETURNING id`,
        [fx.projectId, `Customer rep ${H.STAMP}`, fx.m.users[ADMIN]]))[0];
      const rows = await q(
        `UPDATE gw.projects SET status = 'Completed', signoff_id = $2, actual_end_date = current_date
          WHERE id = $1 RETURNING status::text AS status`, [fx.projectId, so.id]);
      assert.equal(rows[0].status, 'Completed');
    });
  });

  test('a closure override opens the gate as well', async () => {
    await H.sqlRollback(async (q) => {
      const rows = await q(
        `UPDATE gw.projects SET status = 'Completed', closure_override_id = gen_random_uuid()
          WHERE id = $1 RETURNING status::text AS status`, [fx.projectId]);
      assert.equal(rows[0].status, 'Completed');
    });
  });

  test('setting the sign-off without the status is harmless, and the project stays open', async () => {
    const p = await H.sql1<{ status: string }>(
      `SELECT status::text AS status FROM gw.projects WHERE id = $1`, [fx.projectId]);
    assert.notEqual(p!.status, 'Completed', 'the rolled-back closures must not have stuck');
  });

  test('no project anywhere is Completed without a sign-off or an override', async () => {
    const bad = await H.sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM gw.projects
        WHERE status = 'Completed' AND signoff_id IS NULL AND closure_override_id IS NULL`);
    assert.equal(bad[0].n, 0);
  });
});
