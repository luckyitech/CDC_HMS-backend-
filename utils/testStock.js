const db = require('../models');
const { applyMovement, suggestFefoBatch, LedgerError } = require('./stockLedger');

const { sequelize, StockMovement, StockItem, StockLocation, StockParLevel, User } = db;

// =====================================================================
// Tests use stock (13 Oct 2026, Emu). Each ATTEMPT of a test on the charge
// sheet (one QueueCharge row) takes ONE strip / cartridge out of the room the
// test was done in, earliest-expiring batch first, as a 'use' movement
// against the patient and visit. A repeat after an error reading, or a
// confirmatory repeat, is another attempt and takes another one.
//
// No per-test set-up (Emu: the strips are moved to the rooms daily with
// Transfer / Room Balance, so the pars already say where they are):
//   • the ITEM matches by name — TEST_ITEMS below, added by default by
//     migration 20260928000034 and locked against renaming;
//   • the ROOM — at triage: a triage room with a par for that item; entered
//     by a doctor: the room matched to that doctor in Room Balance → edit pars.
//
// Never blocks the clinical work: if the room can't be told or holds none, the
// attempt stays on the bill with stockStatus 'not_taken' and the reason, and
// shows in Stocks → Analytics → Today.
// =====================================================================

/** Charge-sheet test → the stock item it uses (one per attempt). */
const TEST_ITEMS = {
  HbA1c: 'HbA1c test cartridge',
  'Random Blood Sugar': 'Blood glucose test strip',
  Ketones: 'Ketone test strip',
};
/** The charge-sheet names that are tests — keep in step with visitCharges.VITAL_CHARGES. */
const TEST_NAMES = Object.keys(TEST_ITEMS);
const TEST_ITEM_NAMES = Object.values(TEST_ITEMS);
const isTest = (name) => TEST_NAMES.includes(name);
const isTestItemName = (name) => TEST_ITEM_NAMES.includes(name);

/** The doctor whose room a consultation-stage test comes from. */
const doctorFor = async (row, queue) => {
  if (row.addedByRole === 'doctor' && row.addedById) return row.addedById;
  if (queue.assignedDoctorId) return queue.assignedDoctorId;
  return null;
};

/** Candidate rooms for this attempt, or a reason there are none. */
const roomsFor = async (row, queue, item) => {
  if (row.stage === 'consultation' || row.addedByRole === 'doctor') {
    const doctorId = await doctorFor(row, queue);
    if (!doctorId) return { why: 'No doctor on this visit to take the strip from their room.' };
    const rooms = await StockLocation.findAll({ where: { assignedDoctorId: doctorId, status: 'active' } });
    if (!rooms.length) {
      const doc = await User.findByPk(doctorId, { attributes: ['firstName', 'lastName'] });
      const who = doc ? `Dr ${doc.firstName} ${doc.lastName}` : 'the doctor';
      return { why: `No room is matched to ${who} (Room Balance → edit pars).` };
    }
    return { rooms };
  }
  const pars = await StockParLevel.findAll({
    where: { stockItemId: item.id },
    include: [{ model: StockLocation, as: 'location', where: { kind: 'triage', status: 'active' } }],
  });
  if (!pars.length) return { why: `No triage room has a par level for ${item.name} (Room Balance → edit pars).` };
  return { rooms: pars.map((p) => p.location) };
};

/**
 * Take one attempt's strip / cartridge. Own transaction — call it AFTER the
 * charge row is committed. Updates and returns the row's stock status; never throws.
 */
const takeForAttempt = async (row, queue, userId) => {
  try {
    const item = await StockItem.findOne({ where: { name: TEST_ITEMS[row.name] || '', status: 'active' } });
    if (!item) throw new LedgerError(`There is no active "${TEST_ITEMS[row.name]}" item in Stocks → Items.`);
    const { rooms, why } = await roomsFor(row, queue, item);
    if (!rooms) throw new LedgerError(why);

    await sequelize.transaction(async (t) => {
      // Earliest-expiring batch across the candidate rooms.
      const picks = (await Promise.all(rooms.map(async (r) => {
        const p = await suggestFefoBatch(item.id, r.id, t);
        return p && p.available >= 1 ? { ...p, room: r } : null;
      }))).filter(Boolean)
        .sort((a, b) => ((a.batch.expiryDate || '9999-12-31') < (b.batch.expiryDate || '9999-12-31') ? -1 : 1));
      if (!picks.length) throw new LedgerError(`No ${item.name} in ${rooms.map((r) => r.name).join(' / ')}.`);
      const pick = picks[0];
      await applyMovement({
        type: 'use',
        stockBatchId: pick.batch.id,
        quantity: 1,
        fromLocationId: pick.room.id,
        performedById: userId,
        PatientId: queue.PatientId || null,
        QueueId: queue.id,
        reason: `${row.name} test`,
        queueChargeId: row.id,
      }, t);
    });
    await row.update({ stockStatus: 'taken', stockNote: null });
  } catch (err) {
    const note = err instanceof LedgerError ? err.message : 'Could not take the strip from stock.';
    if (!(err instanceof LedgerError)) console.error('testStock.takeForAttempt error:', err);
    await row.update({ stockStatus: 'not_taken', stockNote: note.slice(0, 255) }).catch(() => {});
  }
  return row;
};

/** A test attempt taken off the bill as NOT DONE: put its supplies back where they came from. */
const returnForAttempt = async (row, queue, userId, why) => {
  if (row.stockStatus !== 'taken') return row;
  const uses = await StockMovement.findAll({ where: { queueChargeId: row.id, type: 'use' } });
  await sequelize.transaction(async (t) => {
    for (const m of uses) {
      await applyMovement({
        type: 'use_cancelled',
        stockBatchId: m.stockBatchId,
        quantity: m.quantity,
        toLocationId: m.fromLocationId,
        performedById: userId,
        PatientId: m.PatientId,
        QueueId: m.QueueId,
        reason: `${row.name} not done${why ? `: ${why}` : ''}`,
        queueChargeId: row.id,
      }, t);
    }
  });
  await row.update({ stockStatus: 'returned' });
  return row;
};

module.exports = { TEST_NAMES, TEST_ITEMS, isTest, isTestItemName, takeForAttempt, returnForAttempt };
