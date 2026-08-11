'use strict';

// HMIS V3 — per-ward bed-day rate (used by per-midnight accrual). Guarded.

const TABLE = 'Wards';
const COLUMN = 'ratePerDay';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable(TABLE);
    if (!table[COLUMN]) {
      await queryInterface.addColumn(TABLE, COLUMN, {
        type: Sequelize.FLOAT,
        allowNull: false,
        defaultValue: 0,
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable(TABLE);
    if (table[COLUMN]) await queryInterface.removeColumn(TABLE, COLUMN);
  },
};
