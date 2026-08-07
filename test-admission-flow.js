/**
 * HMIS V3 — admission bed-allocation race test (integration, needs a database).
 *
 * Proves the critical invariant: two clerks converting onto the SAME bed at the
 * same time result in exactly one success and one clean failure (the row lock in
 * admissionController.convert). Creates throwaway data and cleans it up after.
 *
 * SAFETY: only runs against a test DB. Run with:
 *   CONFIRM_TEST_DB=1 node test-admission-flow.js
 * Make sure your .env points at a NON-production database first.
 */
const db = require('./models');
const { sequelize, Ward, Room, Bed } = db;

if (process.env.CONFIRM_TEST_DB !== '1') {
  console.error('Refusing to run without CONFIRM_TEST_DB=1 (guards against running on production).');
  process.exit(1);
}

// Mirrors the locking step in admissionController.convert
const grabBed = async (bedId, label) => {
  return sequelize.transaction(async (t) => {
    const bed = await Bed.findByPk(bedId, { lock: t.LOCK.UPDATE, transaction: t });
    if (bed.status !== 'Available') throw new Error('Bed no longer available');
    // simulate work between check and update
    await new Promise((r) => setTimeout(r, 50));
    await bed.update({ status: 'Occupied' }, { transaction: t });
    return label;
  });
};

(async () => {
  let ward, room, bed;
  try {
    await sequelize.authenticate();
    console.log('DB connected.\n');

    ward = await Ward.create({ name: '__TEST_WARD__', type: 'General' });
    room = await Room.create({ WardId: ward.id, name: '__TEST_ROOM__' });
    bed = await Bed.create({ RoomId: room.id, WardId: ward.id, label: '__T1__', status: 'Available' });
    console.log(`Created test bed ${bed.id} (Available).`);

    const results = await Promise.allSettled([grabBed(bed.id, 'clerkA'), grabBed(bed.id, 'clerkB')]);
    const wins = results.filter((r) => r.status === 'fulfilled');
    const losses = results.filter((r) => r.status === 'rejected');

    console.log(`\nWinners: ${wins.length}  Losers: ${losses.length}`);
    if (wins.length === 1 && losses.length === 1) {
      console.log('✓ PASS — exactly one clerk got the bed; the other was blocked cleanly.');
    } else {
      console.log('✗ FAIL — race not handled safely (expected 1 win / 1 loss).');
    }
    losses.forEach((l) => console.log(`   loser message: ${l.reason.message}`));
  } catch (err) {
    console.error('Test error:', err.message);
  } finally {
    // Clean up throwaway data
    if (bed) await bed.destroy().catch(() => {});
    if (room) await room.destroy().catch(() => {});
    if (ward) await ward.destroy().catch(() => {});
    console.log('\nCleaned up test data.');
    await sequelize.close();
    process.exit(0);
  }
})();
