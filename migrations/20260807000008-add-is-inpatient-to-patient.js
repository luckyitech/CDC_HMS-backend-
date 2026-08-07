'use strict';

// HMIS V3 Phase 1 — denormalised isInpatient flag on Patients (fast board/list
// filtering; the active Admission row remains the source of truth). Guarded.

const TABLE = 'Patients';
const COLUMN = 'isInpatient';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable(TABLE);
    if (!table[COLUMN]) {
      await queryInterface.addColumn(TABLE, COLUMN, {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable(TABLE);
    if (table[COLUMN]) await queryInterface.removeColumn(TABLE, COLUMN);
  },
};
