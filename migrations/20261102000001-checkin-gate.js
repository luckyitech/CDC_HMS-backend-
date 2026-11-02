'use strict';

// The check-in gate (2 Nov 2026, Emu): staff sign in only after checking in at
// the scanner, unless "May sign in without checking in" is ticked on their
// Permissions tab (hr.checkin.exempt). This column is that tick's optional end
// date — NULL means "no end date"; it only matters while the grant is held.
//
//   Users + checkinExemptUntil  DATEONLY NULL   last clinic date the exception applies
//
// Only adds a column; down() removes it.

const TAG = '[20261102000001]';

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const users = await findTable(queryInterface, 'Users');
    if (!users) throw new Error(`${TAG} Users missing`);
    const cols = await queryInterface.describeTable(users);
    if (!cols.checkinExemptUntil) {
      await queryInterface.addColumn(users, 'checkinExemptUntil', { type: Sequelize.DATEONLY, allowNull: true, defaultValue: null });
      console.log(`${TAG} Users.checkinExemptUntil added`);
    }
  },

  async down(queryInterface) {
    const users = await findTable(queryInterface, 'Users');
    if (!users) return;
    const cols = await queryInterface.describeTable(users);
    if (cols.checkinExemptUntil) await queryInterface.removeColumn(users, 'checkinExemptUntil');
    console.log(`${TAG} reverted`);
  },
};
