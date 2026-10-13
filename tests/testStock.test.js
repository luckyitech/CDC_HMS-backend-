const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

const db = require('../models');
const { applyMovement } = require('../utils/stockLedger');
const { addCharges, addAttempt, removeCharge, listCharges } = require('../utils/visitCharges');
const { takeForAttempt, TEST_ITEMS } = require('../utils/testStock');
const { clinicDatePlusDays } = require('../utils/clinicTime');

// =====================================================================
// Tests use stock, and repeat attempts on the charge sheet (13 Oct 2026, Emu).
// The test finds its strip BY NAME; the room is the triage room with a par for
// it, or the room matched to the doctor. Real database, like
// tests/stockLineEdit.test.js: every fixture is tagged and removed in after().
// =====================================================================

if (process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to run stock tests against production.');
}

const TAG = '__TEST_TEST_STOCK__';
const TEST = 'Ketones';
let admin; let nurse; let doctor; let triage; let drRoom; let strip; let createdStrip = false;
let patient; let visit; const batches = []; let otherPars = [];

const held = async (room) => (await db.StockLevel.sum('quantity', {
  where: { locationId: room.id, stockBatchId: { [Op.in]: batches.length ? batches : [0] } },
})) || 0;
const line = async () => (await listCharges(visit)).lines.find((l) => l.name === TEST);
const receiveInto = async (room, qty) => {
  const b = await db.StockBatch.create({
    stockItemId: strip.id, qtyReceived: qty, receivedAt: new Date(), status: 'active', expiryDate: clinicDatePlusDays(365), receivedById: admin.id,
  });
  batches.push(b.id);
  await db.sequelize.transaction((t) => applyMovement({ type: 'intake', stockBatchId: b.id, quantity: qty, toLocationId: room.id, performedById: admin.id }, t));
};

before(async () => {
  admin = await db.User.findOne({ where: { role: 'admin' } });
  assert.ok(admin, 'these tests need an admin user');
  nurse = { id: admin.id, role: 'nurse', name: 'Test nurse' };
  const dr = await db.User.create({ password: 'x', role: 'doctor', firstName: TAG, lastName: 'Doctor', email: 'test-stock-doctor@cdc.test', isActive: true }, { hooks: false });
  doctor = { id: dr.id, role: 'doctor', name: `${TAG} Doctor` };
  [strip, createdStrip] = await db.StockItem.findOrCreate({
    where: { name: TEST_ITEMS[TEST] }, defaults: { category: 'diagnostic', unit: 'piece', status: 'active' },
  });
  // Other triage rooms' pars for this strip would be used first — set them
  // aside for the run and put them back exactly in after().
  otherPars = await db.StockParLevel.findAll({ where: { stockItemId: strip.id }, raw: true });
  await db.StockParLevel.destroy({ where: { stockItemId: strip.id } });
  triage = await db.StockLocation.create({ name: `${TAG} Triage`, kind: 'triage', isColdChain: false, isDispensing: true, status: 'active' });
  drRoom = await db.StockLocation.create({ name: `${TAG} Dr room`, kind: 'doctor_room', isColdChain: false, isDispensing: true, status: 'active' });
  await receiveInto(triage, 3);
  await receiveInto(drRoom, 2);
  patient = await db.Patient.create({ uhid: 'TST-STOCK-1', firstName: TAG, lastName: 'Patient' });
  visit = await db.Queue.create({ PatientId: patient.id, status: 'In Triage' });
});

after(async () => {
  const ids = { [Op.in]: batches.length ? batches : [0] };
  await db.StockMovement.destroy({ where: { stockBatchId: ids } });
  await db.StockLevel.destroy({ where: { stockBatchId: ids } });
  await db.StockBatch.destroy({ where: { id: ids } });
  await db.StockParLevel.destroy({ where: { locationId: { [Op.in]: [triage.id, drRoom.id] } } });
  await db.StockLocation.destroy({ where: { id: { [Op.in]: [triage.id, drRoom.id] } } });
  if (otherPars.length) await db.StockParLevel.bulkCreate(otherPars);
  if (createdStrip) await db.StockItem.destroy({ where: { id: strip.id } });
  await db.QueueCharge.destroy({ where: { QueueId: visit.id } });
  await db.Queue.destroy({ where: { id: visit.id } });
  await db.Patient.destroy({ where: { id: patient.id } });
  await db.User.destroy({ where: { id: doctor.id } });
  await db.sequelize.close();
});

test('no triage room has a par for the strip: billed, marked not taken', async () => {
  await addCharges(visit, { charges: [TEST] }, nurse, { source: 'vital', stage: 'triage' });
  const l = await line();
  assert.equal(l.quantity, 1);
  assert.equal(l.attempts[0].stockStatus, 'not_taken');
  assert.match(l.attempts[0].stockNote, /No triage room has a par/);
  assert.equal(await held(triage), 3);
});

test('with a par in the triage room, a repeat takes another strip from it', async () => {
  await db.StockParLevel.create({ stockItemId: strip.id, locationId: triage.id, minQty: 1, maxQty: 5 });
  await addAttempt(visit, TEST, nurse, { stage: 'triage' });
  const l = await line();
  assert.equal(l.quantity, 2);
  assert.equal(l.attempts[1].stockStatus, 'taken');
  assert.equal(await held(triage), 2);
  assert.equal(await held(drRoom), 2);
});

test('removing an attempt that was NOT done puts the strip back', async () => {
  await addAttempt(visit, TEST, nurse, { stage: 'triage' });
  assert.equal(await held(triage), 1);
  await removeCharge(visit, { kind: 'charge', name: TEST, done: false, reason: 'added twice' }, nurse);
  assert.equal((await line()).quantity, 2);
  assert.equal(await held(triage), 2);
  const back = await db.StockMovement.findAll({ where: { stockBatchId: { [Op.in]: batches }, type: 'use_cancelled' } });
  assert.equal(back.length, 1);
  assert.equal(back[0].PatientId, patient.id);
  assert.equal(back[0].toLocationId, triage.id);
});

test('removing an attempt that WAS done only takes it off the bill', async () => {
  await removeCharge(visit, { kind: 'charge', name: TEST, done: true, reason: 'not charged' }, nurse);
  assert.equal((await line()).quantity, 1);
  assert.equal(await held(triage), 2);
});

test('a doctor with no room matched: billed, marked not taken', async () => {
  await addAttempt(visit, TEST, doctor, { stage: 'consultation' });
  const last = (await line()).attempts.at(-1);
  assert.equal(last.stockStatus, 'not_taken');
  assert.match(last.stockNote, /No room is matched to Dr/);
});

test('once the room is matched to the doctor, Take now takes it from the doctor\'s room', async () => {
  await drRoom.update({ assignedDoctorId: doctor.id });
  const row = await db.QueueCharge.findOne({ where: { QueueId: visit.id, stockStatus: 'not_taken', addedByRole: 'doctor' } });
  await takeForAttempt(row, visit, admin.id);
  assert.equal(row.stockStatus, 'taken');
  assert.equal(await held(drRoom), 1);
  assert.equal(await held(triage), 2);
});

test('the room has none left: billed, marked not taken', async () => {
  await addAttempt(visit, TEST, doctor, { stage: 'consultation' });
  await addAttempt(visit, TEST, doctor, { stage: 'consultation' });
  const last = (await line()).attempts.at(-1);
  assert.equal(last.stockStatus, 'not_taken');
  assert.match(last.stockNote, /No Ketone test strip in/);
  assert.equal(await held(drRoom), 0);
});

test('only tests can be repeated', async () => {
  assert.equal(await addAttempt(visit, 'Consultation Fee', nurse, {}), null);
});

test('the name leaves the bill only when its last attempt is removed', async () => {
  const n = (await line()).quantity;
  for (let i = 0; i < n; i++) await removeCharge(visit, { kind: 'charge', name: TEST, done: true }, nurse);
  await visit.reload();
  assert.ok(!JSON.stringify(visit.selectedCharges || []).includes(TEST));
});
