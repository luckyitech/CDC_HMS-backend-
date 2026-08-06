const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

const db = require('../models');
const {
  createDraft, updateDraft, issueInvoice, voidInvoice, discardDraft,
  recordPayment, reversePayment, rebuildInvoiceTotals, BillingError,
} = require('../utils/billingLedger');
const { clearBillingConfigCache } = require('../utils/billingConfig');

// =====================================================================
// Billing ledger invariants — the promises the money rests on:
//
//   an invoice's totals can never disagree with its lines and payments,
//   an issued invoice can never be edited,
//   a payment can never be reversed twice,
//   a bill can never be overpaid,
//   a visit can never carry two live invoices.
//
// These talk to a REAL database. The guarantees being tested are row locks and
// unique indexes — the two things a mock would happily let you violate, which
// would make the tests pass and the till wrong.
//
// Everything is created under a TEST_TAG prefix and removed in after(), pass
// or fail.
//
//   npm test
// =====================================================================

if (process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to run billing ledger tests against production.');
}

const TAG = '__TEST_BILLING__';
const made = { invoices: [], services: [], patients: [] };

let admin;
let patient;
let consultation; // priced 2,000.00, exempt
let labTest;      // priced 3,500.00, exempt
let unpriced;     // no price set
let vatable;      // priced 1,160.00, standard-rated

const KES = (shillings) => shillings * 100;

// A draft for our test patient, recorded for cleanup.
const draftWith = async (lines, extra = {}) => {
  const invoice = await createDraft({ PatientId: patient.id, lines, ...extra });
  made.invoices.push(invoice.id);
  return invoice;
};

// The common case: a draft, issued, ready to be paid.
const issuedWith = async (lines, extra = {}) => {
  const draft = await draftWith(lines, extra);
  return issueInvoice(draft.id, { userId: admin.id });
};

const reload = (invoice) => db.Invoice.findByPk(invoice.id);

const linesOf = (invoice) =>
  db.InvoiceLine.findAll({ where: { invoiceId: invoice.id }, order: [['sortOrder', 'ASC']] });

/**
 * Remove everything this suite has ever created, by TAG rather than by a list
 * of ids collected during the run.
 *
 * Called at the START as well as the end. A run killed part-way through leaves
 * fixtures behind, and the next run then dies in before() on the unique index
 * over ServiceItem.name — with every test reported as failing for a reason that
 * has nothing to do with the code. Purging up front makes the suite
 * re-runnable after an interruption, which is the normal state of affairs while
 * developing against it.
 *
 * Order follows the foreign keys: payments hold invoices (ON DELETE RESTRICT),
 * invoices hold patients.
 */
const purgeFixtures = async () => {
  const patients = await db.Patient.findAll({
    where: { uhid: { [Op.like]: `%${TAG}%` } }, attributes: ['id'], raw: true,
  });
  const patientIds = patients.map((p) => p.id);

  if (patientIds.length) {
    const invoices = await db.Invoice.findAll({
      where: { PatientId: { [Op.in]: patientIds } }, attributes: ['id'], raw: true,
    });
    const invoiceIds = invoices.map((i) => i.id);

    if (invoiceIds.length) {
      const onInvoices = { invoiceId: { [Op.in]: invoiceIds } };
      // Reversals point at the payment they undid with ON DELETE RESTRICT, so
      // one bulk DELETE can try to remove a parent before its reversal and be
      // refused. The pointing rows go first.
      await db.Payment.destroy({ where: { ...onInvoices, reversesPaymentId: { [Op.ne]: null } } });
      await db.Payment.destroy({ where: onInvoices });
      await db.InvoiceLine.destroy({ where: onInvoices });
      await db.Invoice.destroy({ where: { id: { [Op.in]: invoiceIds } } });
    }
    await db.Queue.destroy({ where: { PatientId: { [Op.in]: patientIds } } });
  }

  await db.ServiceItem.destroy({ where: { name: { [Op.like]: `%${TAG}%` } } });
  await db.Patient.destroy({ where: { uhid: { [Op.like]: `%${TAG}%` } } });
};

before(async () => {
  await db.sequelize.authenticate();
  clearBillingConfigCache();
  await purgeFixtures();

  admin = await db.User.findOne({ where: { role: 'admin' } });
  assert.ok(admin, 'these tests need an admin user to attribute payments to');

  patient = await db.Patient.create({
    uhid: `${TAG}-P1`,
    firstName: 'Billing',
    lastName: 'Fixture',
    gender: 'Female',
    dateOfBirth: '1980-01-01',
    phone: '0700000000',
  });
  made.patients.push(patient.id);

  [consultation, labTest, unpriced, vatable] = await Promise.all([
    db.ServiceItem.create({ name: `${TAG} Consultation`, category: 'consultation', unitPriceMinor: KES(2000), vatClass: 'exempt' }),
    db.ServiceItem.create({ name: `${TAG} HbA1c`, category: 'laboratory', unitPriceMinor: KES(3500), vatClass: 'exempt' }),
    db.ServiceItem.create({ name: `${TAG} Glucometer`, category: 'supply', unitPriceMinor: null, vatClass: 'exempt' }),
    db.ServiceItem.create({ name: `${TAG} Vatable`, category: 'other', unitPriceMinor: KES(1160), vatClass: 'standard' }),
  ]);
  made.services.push(consultation.id, labTest.id, unpriced.id, vatable.id);
});

after(async () => {
  try {
    await purgeFixtures();

    const leftover = await db.ServiceItem.count({ where: { name: { [Op.like]: `%${TAG}%` } } })
      + await db.Patient.count({ where: { uhid: { [Op.like]: `%${TAG}%` } } });
    assert.equal(leftover, 0, 'test fixtures were not fully cleaned up');
  } finally {
    // Always close, even if the cleanup assertion fails. An open pool keeps the
    // process alive after the runner has finished, and the suite then looks
    // like it hung rather than like it failed.
    await db.sequelize.close();
  }
});

// ---------------------------------------------------------------------

describe('totals always follow the lines', () => {
  test('a draft totals its lines', async () => {
    const invoice = await draftWith([
      { serviceItemId: consultation.id },
      { serviceItemId: labTest.id },
    ]);

    assert.equal(invoice.totalMinor, KES(5500));
    assert.equal(invoice.subtotalMinor, KES(5500));
    assert.equal(invoice.vatTotalMinor, 0);
    assert.equal(invoice.balanceMinor, KES(5500));
    assert.equal(invoice.status, 'draft');
  });

  test('quantity multiplies', async () => {
    const invoice = await draftWith([{ serviceItemId: consultation.id, quantity: 3 }]);
    assert.equal(invoice.totalMinor, KES(6000));
  });

  test('editing a draft re-totals it', async () => {
    const invoice = await draftWith([{ serviceItemId: consultation.id }]);
    assert.equal(invoice.totalMinor, KES(2000));

    await updateDraft(invoice.id, { lines: [
      { serviceItemId: consultation.id },
      { serviceItemId: labTest.id },
    ] });

    assert.equal((await reload(invoice)).totalMinor, KES(5500));
  });

  test('removing every line leaves a zero draft, not a stale total', async () => {
    const invoice = await draftWith([{ serviceItemId: consultation.id }]);
    await updateDraft(invoice.id, { lines: [] });

    const after = await reload(invoice);
    assert.equal(after.totalMinor, 0);
    assert.equal(after.balanceMinor, 0);
    assert.equal((await linesOf(invoice)).length, 0);
  });

  test('a standard-rated line splits into net and VAT', async () => {
    const invoice = await draftWith([{ serviceItemId: vatable.id }]);
    // 1,160.00 inclusive of 16% = 1,000.00 + 160.00
    assert.equal(invoice.totalMinor, KES(1160));
    assert.equal(invoice.subtotalMinor, KES(1000));
    assert.equal(invoice.vatTotalMinor, KES(160));
  });

  test('an ad-hoc line needs no price list entry', async () => {
    const invoice = await draftWith([
      { description: 'Crutches hire', unitPriceMinor: KES(750) },
    ]);
    assert.equal(invoice.totalMinor, KES(750));
    const [line] = await linesOf(invoice);
    assert.equal(line.serviceItemId, null);
    assert.equal(line.description, 'Crutches hire');
  });
});

describe('every price on a line is a snapshot', () => {
  test('re-pricing a service does not touch invoices already raised', async () => {
    const invoice = await issuedWith([{ serviceItemId: consultation.id }]);
    assert.equal(invoice.totalMinor, KES(2000));

    await consultation.update({ unitPriceMinor: KES(9999) });
    try {
      const [line] = await linesOf(invoice);
      assert.equal(line.unitPriceMinor, KES(2000));
      assert.equal((await reload(invoice)).totalMinor, KES(2000));
    } finally {
      await consultation.update({ unitPriceMinor: KES(2000) });
    }
  });

  test('renaming a service does not rewrite what the bill says', async () => {
    const invoice = await issuedWith([{ serviceItemId: labTest.id }]);
    await labTest.update({ name: `${TAG} Renamed` });
    try {
      const [line] = await linesOf(invoice);
      assert.equal(line.description, `${TAG} HbA1c`);
    } finally {
      await labTest.update({ name: `${TAG} HbA1c` });
    }
  });
});

describe('unpriced services block issuing but not drafting', () => {
  test('an unpriced line sits on the draft contributing nothing', async () => {
    const invoice = await draftWith([
      { serviceItemId: consultation.id },
      { serviceItemId: unpriced.id },
    ]);

    assert.equal(invoice.totalMinor, KES(2000), 'the unpriced line must not be counted as free');
    const lines = await linesOf(invoice);
    assert.equal(lines.length, 2);
    assert.equal(lines[1].unitPriceMinor, null);
  });

  test('issuing is refused while one remains', async () => {
    const invoice = await draftWith([
      { serviceItemId: consultation.id },
      { serviceItemId: unpriced.id },
    ]);

    await assert.rejects(
      () => issueInvoice(invoice.id, { userId: admin.id }),
      (err) => err instanceof BillingError && /set a price/i.test(err.message)
    );
    assert.equal((await reload(invoice)).status, 'draft');
  });

  test('an empty bill cannot be issued', async () => {
    const invoice = await draftWith([]);
    await assert.rejects(
      () => issueInvoice(invoice.id, { userId: admin.id }),
      (err) => err instanceof BillingError && /at least one item/i.test(err.message)
    );
  });

  test('a retired service can no longer be billed', async () => {
    await unpriced.update({ status: 'retired' });
    try {
      await assert.rejects(
        () => draftWith([{ serviceItemId: unpriced.id }]),
        (err) => err instanceof BillingError && /retired/i.test(err.message)
      );
    } finally {
      await unpriced.update({ status: 'active' });
    }
  });
});

describe('issuing freezes the invoice', () => {
  test('a number is assigned only at issue', async () => {
    const draft = await draftWith([{ serviceItemId: consultation.id }]);
    assert.equal(draft.invoiceNumber, null, 'a draft must not burn an invoice number');

    const issued = await issueInvoice(draft.id, { userId: admin.id });
    assert.match(issued.invoiceNumber, /^INV-\d{4}-\d{3,}$/);
    assert.equal(issued.status, 'issued');
    assert.ok(issued.issuedAt);
    assert.equal(issued.issuedById, admin.id);
  });

  test('an issued invoice cannot be edited', async () => {
    const invoice = await issuedWith([{ serviceItemId: consultation.id }]);
    await assert.rejects(
      () => updateDraft(invoice.id, { lines: [{ serviceItemId: labTest.id }] }),
      (err) => err instanceof BillingError && /void it and raise a new one/i.test(err.message)
    );

    const lines = await linesOf(invoice);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].unitPriceMinor, KES(2000));
  });

  test('an issued invoice cannot be issued twice', async () => {
    const invoice = await issuedWith([{ serviceItemId: consultation.id }]);
    await assert.rejects(
      () => issueInvoice(invoice.id, { userId: admin.id }),
      (err) => err instanceof BillingError && /already been issued/i.test(err.message)
    );
  });

  test('an issued invoice cannot be discarded', async () => {
    const invoice = await issuedWith([{ serviceItemId: consultation.id }]);
    await assert.rejects(() => discardDraft(invoice.id), BillingError);
  });

  test('a zero-total bill settles itself', async () => {
    const free = await db.ServiceItem.create({
      name: `${TAG} No Charge`, category: 'other', unitPriceMinor: 0, vatClass: 'exempt',
    });
    made.services.push(free.id);

    const invoice = await issuedWith([{ serviceItemId: free.id }]);
    assert.equal(invoice.totalMinor, 0);
    assert.equal(invoice.balanceMinor, 0);
    assert.equal(invoice.status, 'paid', 'a bill for nothing is not owed');
  });
});

describe('payments move the balance', () => {
  test('a part payment leaves a balance', async () => {
    const invoice = await issuedWith([{ serviceItemId: consultation.id }]);
    await recordPayment({
      invoiceId: invoice.id, method: 'cash', amountMinor: KES(500), receivedById: admin.id,
    });

    const after = await reload(invoice);
    assert.equal(after.amountPaidMinor, KES(500));
    assert.equal(after.balanceMinor, KES(1500));
    assert.equal(after.status, 'partially_paid');
  });

  test('paying the balance settles it', async () => {
    const invoice = await issuedWith([{ serviceItemId: consultation.id }]);
    await recordPayment({ invoiceId: invoice.id, method: 'cash', amountMinor: KES(2000), receivedById: admin.id });

    const after = await reload(invoice);
    assert.equal(after.balanceMinor, 0);
    assert.equal(after.status, 'paid');
  });

  test('overpayment is refused', async () => {
    const invoice = await issuedWith([{ serviceItemId: consultation.id }]);
    await assert.rejects(
      () => recordPayment({ invoiceId: invoice.id, method: 'cash', amountMinor: KES(2500), receivedById: admin.id }),
      (err) => err instanceof BillingError && /more than the outstanding balance/i.test(err.message)
    );
    assert.equal((await reload(invoice)).amountPaidMinor, 0);
  });

  test('a second payment cannot exceed what is left', async () => {
    const invoice = await issuedWith([{ serviceItemId: consultation.id }]);
    await recordPayment({ invoiceId: invoice.id, method: 'cash', amountMinor: KES(1500), receivedById: admin.id });
    await assert.rejects(
      () => recordPayment({ invoiceId: invoice.id, method: 'cash', amountMinor: KES(600), receivedById: admin.id }),
      BillingError
    );
  });

  test('a draft cannot be paid', async () => {
    const invoice = await draftWith([{ serviceItemId: consultation.id }]);
    await assert.rejects(
      () => recordPayment({ invoiceId: invoice.id, method: 'cash', amountMinor: KES(100), receivedById: admin.id }),
      (err) => err instanceof BillingError && /issue this bill/i.test(err.message)
    );
  });

  test('every payment gets its own receipt number', async () => {
    const invoice = await issuedWith([{ serviceItemId: labTest.id }]);
    const first = await recordPayment({ invoiceId: invoice.id, method: 'cash', amountMinor: KES(1000), receivedById: admin.id });
    const second = await recordPayment({ invoiceId: invoice.id, method: 'cash', amountMinor: KES(1000), receivedById: admin.id });

    assert.match(first.receiptNumber, /^RCT-\d{4}-\d{3,}$/);
    assert.notEqual(first.receiptNumber, second.receiptNumber);
  });
});

describe('payment method rules', () => {
  test('M-Pesa needs its code', async () => {
    const invoice = await issuedWith([{ serviceItemId: consultation.id }]);
    await assert.rejects(
      () => recordPayment({ invoiceId: invoice.id, method: 'mpesa', amountMinor: KES(2000), receivedById: admin.id }),
      (err) => err instanceof BillingError && /M-Pesa code/i.test(err.message)
    );
  });

  test('cash needs nothing, and stores nothing it was given', async () => {
    const invoice = await issuedWith([{ serviceItemId: consultation.id }]);
    const payment = await recordPayment({
      invoiceId: invoice.id, method: 'cash', amountMinor: KES(2000),
      reference: 'typed by mistake', receivedById: admin.id,
    });
    assert.equal(payment.reference, null);
    assert.equal(payment.uniqueReference, null);
  });

  test('the same M-Pesa code cannot be banked twice', async () => {
    const code = `${TAG}CODE1`;
    const first = await issuedWith([{ serviceItemId: consultation.id }]);
    await recordPayment({
      invoiceId: first.id, method: 'mpesa', amountMinor: KES(2000),
      reference: code, receivedById: admin.id,
    });

    const second = await issuedWith([{ serviceItemId: consultation.id }]);
    await assert.rejects(
      () => recordPayment({
        invoiceId: second.id, method: 'mpesa', amountMinor: KES(2000),
        reference: code, receivedById: admin.id,
      }),
      (err) => err instanceof BillingError && /already been recorded/i.test(err.message)
    );
  });

  test('the guard is not defeated by case or padding', async () => {
    const code = `${TAG}CODE2`;
    const first = await issuedWith([{ serviceItemId: consultation.id }]);
    await recordPayment({
      invoiceId: first.id, method: 'mpesa', amountMinor: KES(2000), reference: code, receivedById: admin.id,
    });

    const second = await issuedWith([{ serviceItemId: consultation.id }]);
    await assert.rejects(
      () => recordPayment({
        invoiceId: second.id, method: 'mpesa', amountMinor: KES(2000),
        reference: `  ${code.toLowerCase()}  `, receivedById: admin.id,
      }),
      BillingError
    );
  });

  test('card auth codes may legitimately repeat', async () => {
    const first = await issuedWith([{ serviceItemId: consultation.id }]);
    const second = await issuedWith([{ serviceItemId: consultation.id }]);

    await recordPayment({
      invoiceId: first.id, method: 'card', amountMinor: KES(2000),
      reference: '123456', cardLast4: '4242', receivedById: admin.id,
    });
    // Must NOT throw — a six-digit terminal code repeating is normal.
    const payment = await recordPayment({
      invoiceId: second.id, method: 'card', amountMinor: KES(2000),
      reference: '123456', cardLast4: '4242', receivedById: admin.id,
    });
    assert.equal(payment.cardLast4, '4242');
  });

  test('only four card digits are accepted', async () => {
    const invoice = await issuedWith([{ serviceItemId: consultation.id }]);
    await assert.rejects(
      () => recordPayment({
        invoiceId: invoice.id, method: 'card', amountMinor: KES(2000),
        reference: '999999', cardLast4: '4111111111111111', receivedById: admin.id,
      }),
      (err) => err instanceof BillingError && /last four digits/i.test(err.message)
    );
  });

  test('an unknown method is refused', async () => {
    const invoice = await issuedWith([{ serviceItemId: consultation.id }]);
    await assert.rejects(
      () => recordPayment({ invoiceId: invoice.id, method: 'bitcoin', amountMinor: KES(2000), receivedById: admin.id }),
      (err) => err instanceof BillingError && /unknown payment method/i.test(err.message)
    );
  });
});

describe('reversal is the only correction', () => {
  test('reversing puts the balance back', async () => {
    const invoice = await issuedWith([{ serviceItemId: consultation.id }]);
    const payment = await recordPayment({
      invoiceId: invoice.id, method: 'cash', amountMinor: KES(2000), receivedById: admin.id,
    });
    assert.equal((await reload(invoice)).status, 'paid');

    await reversePayment(payment.id, { userId: admin.id, reason: 'Wrong patient' });

    const after = await reload(invoice);
    assert.equal(after.amountPaidMinor, 0);
    assert.equal(after.balanceMinor, KES(2000));
    assert.equal(after.status, 'issued');
  });

  test('both rows survive — nothing is edited away', async () => {
    const invoice = await issuedWith([{ serviceItemId: consultation.id }]);
    const payment = await recordPayment({
      invoiceId: invoice.id, method: 'cash', amountMinor: KES(2000), receivedById: admin.id,
    });
    await reversePayment(payment.id, { userId: admin.id, reason: 'Keyed twice' });

    const rows = await db.Payment.findAll({ where: { invoiceId: invoice.id }, order: [['id', 'ASC']] });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].type, 'payment');
    assert.equal(rows[1].type, 'reversal');
    assert.equal(rows[1].reversesPaymentId, payment.id);
    assert.equal(rows[1].reason, 'Keyed twice');
    // Amount stays POSITIVE; the type carries the direction.
    assert.equal(Number(rows[1].amountMinor), KES(2000));
  });

  test('a payment cannot be reversed twice', async () => {
    const invoice = await issuedWith([{ serviceItemId: consultation.id }]);
    const payment = await recordPayment({
      invoiceId: invoice.id, method: 'cash', amountMinor: KES(2000), receivedById: admin.id,
    });
    await reversePayment(payment.id, { userId: admin.id, reason: 'First' });

    await assert.rejects(
      () => reversePayment(payment.id, { userId: admin.id, reason: 'Second' }),
      (err) => err instanceof BillingError && /already been reversed/i.test(err.message)
    );
    assert.equal((await reload(invoice)).amountPaidMinor, 0, 'a double reversal would credit the patient twice');
  });

  test('a reversal cannot itself be reversed', async () => {
    const invoice = await issuedWith([{ serviceItemId: consultation.id }]);
    const payment = await recordPayment({
      invoiceId: invoice.id, method: 'cash', amountMinor: KES(2000), receivedById: admin.id,
    });
    const reversal = await reversePayment(payment.id, { userId: admin.id, reason: 'Undo' });

    await assert.rejects(
      () => reversePayment(reversal.id, { userId: admin.id, reason: 'Undo the undo' }),
      BillingError
    );
  });

  test('a reversal needs a reason', async () => {
    const invoice = await issuedWith([{ serviceItemId: consultation.id }]);
    const payment = await recordPayment({
      invoiceId: invoice.id, method: 'cash', amountMinor: KES(2000), receivedById: admin.id,
    });
    await assert.rejects(
      () => reversePayment(payment.id, { userId: admin.id, reason: '   ' }),
      (err) => err instanceof BillingError && /reason is required/i.test(err.message)
    );
  });

  test('reversing an M-Pesa payment does not collide with its own code', async () => {
    const invoice = await issuedWith([{ serviceItemId: consultation.id }]);
    const payment = await recordPayment({
      invoiceId: invoice.id, method: 'mpesa', amountMinor: KES(2000),
      reference: `${TAG}CODE3`, receivedById: admin.id,
    });
    const reversal = await reversePayment(payment.id, { userId: admin.id, reason: 'Refunded at the desk' });
    assert.equal(reversal.uniqueReference, null);
  });

  test('a refund cannot exceed what was taken', async () => {
    const invoice = await issuedWith([{ serviceItemId: consultation.id }]);
    await recordPayment({ invoiceId: invoice.id, method: 'cash', amountMinor: KES(500), receivedById: admin.id });

    await assert.rejects(
      () => recordPayment({
        invoiceId: invoice.id, type: 'refund', method: 'cash',
        amountMinor: KES(900), reason: 'Overcharged', receivedById: admin.id,
      }),
      (err) => err instanceof BillingError && /more than has been paid/i.test(err.message)
    );
  });
});

describe('voiding', () => {
  test('a void invoice releases the visit for a corrected bill', async () => {
    const queue = await db.Queue.create({
      PatientId: patient.id, status: 'Pending Billing', priority: 'Normal',
    });

    const first = await issuedWith([{ serviceItemId: consultation.id }], { QueueId: queue.id });
    // A second live bill for the same visit is impossible.
    await assert.rejects(
      () => draftWith([{ serviceItemId: labTest.id }], { QueueId: queue.id }),
      (err) => err instanceof BillingError && err.statusCode === 409
    );

    await voidInvoice(first.id, { userId: admin.id, reason: 'Billed the wrong visit' });

    const voided = await reload(first);
    assert.equal(voided.status, 'void');
    assert.equal(voided.activeForQueueId, null);
    assert.equal(voided.voidReason, 'Billed the wrong visit');

    // Now a replacement can be raised.
    const replacement = await draftWith([{ serviceItemId: labTest.id }], { QueueId: queue.id });
    assert.equal(replacement.status, 'draft');

    await db.InvoiceLine.destroy({ where: { invoiceId: replacement.id } });
    await db.Invoice.destroy({ where: { id: replacement.id } });
    await queue.destroy();
  });

  test('an invoice with money against it cannot be voided', async () => {
    const invoice = await issuedWith([{ serviceItemId: consultation.id }]);
    await recordPayment({ invoiceId: invoice.id, method: 'cash', amountMinor: KES(500), receivedById: admin.id });

    await assert.rejects(
      () => voidInvoice(invoice.id, { userId: admin.id, reason: 'Mistake' }),
      (err) => err instanceof BillingError && /reverse or refund them first/i.test(err.message)
    );
    assert.equal((await reload(invoice)).status, 'partially_paid');
  });

  test('once the payment is reversed, voiding is allowed', async () => {
    const invoice = await issuedWith([{ serviceItemId: consultation.id }]);
    const payment = await recordPayment({
      invoiceId: invoice.id, method: 'cash', amountMinor: KES(500), receivedById: admin.id,
    });
    await reversePayment(payment.id, { userId: admin.id, reason: 'Voiding the bill' });
    await voidInvoice(invoice.id, { userId: admin.id, reason: 'Duplicate bill' });

    assert.equal((await reload(invoice)).status, 'void');
  });

  test('voiding needs a reason', async () => {
    const invoice = await issuedWith([{ serviceItemId: consultation.id }]);
    await assert.rejects(
      () => voidInvoice(invoice.id, { userId: admin.id, reason: '' }),
      (err) => err instanceof BillingError && /reason is required/i.test(err.message)
    );
  });

  test('a void invoice takes no further payment', async () => {
    const invoice = await issuedWith([{ serviceItemId: consultation.id }]);
    await voidInvoice(invoice.id, { userId: admin.id, reason: 'Cancelled visit' });
    await assert.rejects(
      () => recordPayment({ invoiceId: invoice.id, method: 'cash', amountMinor: KES(100), receivedById: admin.id }),
      (err) => err instanceof BillingError && /void/i.test(err.message)
    );
  });
});

describe('the stored totals are only a cache', () => {
  test('rebuilding changes nothing when the ledger is consistent', async () => {
    const invoice = await issuedWith([
      { serviceItemId: consultation.id },
      { serviceItemId: vatable.id },
    ]);
    await recordPayment({ invoiceId: invoice.id, method: 'cash', amountMinor: KES(1000), receivedById: admin.id });

    const before = (await reload(invoice)).toJSON();
    await rebuildInvoiceTotals();
    const after = (await reload(invoice)).toJSON();

    ['subtotalMinor', 'vatTotalMinor', 'totalMinor', 'amountPaidMinor', 'balanceMinor', 'status']
      .forEach((field) => assert.equal(after[field], before[field], `${field} drifted on rebuild`));
  });

  test('a total corrupted outside the engine is repaired from the lines', async () => {
    const invoice = await issuedWith([{ serviceItemId: consultation.id }]);

    // Simulate something writing a total directly — the exact thing the engine
    // exists to prevent, and the reason this escape hatch exists.
    await db.Invoice.update(
      { totalMinor: KES(999999), balanceMinor: KES(999999) },
      { where: { id: invoice.id } }
    );

    const result = await rebuildInvoiceTotals();
    assert.ok(result.changed >= 1);

    const repaired = await reload(invoice);
    assert.equal(repaired.totalMinor, KES(2000));
    assert.equal(repaired.balanceMinor, KES(2000));
  });
});
