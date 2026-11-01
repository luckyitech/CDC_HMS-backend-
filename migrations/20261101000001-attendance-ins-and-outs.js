'use strict';

// Attendance — every walk-in and walk-out counts (1 Nov 2026, Emu): the
// fingerprint scanner can't tell an in from an out, so a day's punches
// alternate in, out, in, out… and the time out between them comes off the
// hours. Replaces the 19 Oct "first punch in, last punch out" model.
//
//   StaffAttendances + inCount        INTEGER   counted "in" punches that day
//                    + outCount       INTEGER   counted "out" punches
//                    + awayMinutes    INTEGER   time out between an out and the next in
//                    + workedMinutes  INTEGER   time inside: the sum of every in → out pair
//
// All four are NULL on sessions from before (their hours stay check-in to
// check-out). Only adds columns; down() removes them.

const TAG = '[20261101000001]';

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};

const COLUMNS = ['inCount', 'outCount', 'awayMinutes', 'workedMinutes'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;
    const sessions = await findTable(qi, 'StaffAttendances');
    if (!sessions) throw new Error(`${TAG} StaffAttendances missing`);
    const cols = await qi.describeTable(sessions);
    for (const name of COLUMNS) {
      if (!cols[name]) {
        await qi.addColumn(sessions, name, { type: Sequelize.INTEGER, allowNull: true, defaultValue: null });
        console.log(`${TAG} StaffAttendances.${name} added`);
      }
    }
  },

  async down(queryInterface) {
    const qi = queryInterface;
    const sessions = await findTable(qi, 'StaffAttendances');
    if (!sessions) return;
    const cols = await qi.describeTable(sessions);
    for (const name of COLUMNS) {
      if (cols[name]) await qi.removeColumn(sessions, name);
    }
    console.log(`${TAG} reverted`);
  },
};
