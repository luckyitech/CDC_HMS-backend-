'use strict';

// Adds per-foot free-text interpretation to NeuropathyStudies (Right + Left),
// mirroring the vendor report's Right/Left Interpretation fields. Guarded and
// reversible. `impression` is kept for back-compat but is no longer written by
// the exam UI (superseded by the two interpretation fields).

const TABLE = 'NeuropathyStudies';

const resolveTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.find((t) => String(t).toLowerCase() === name.toLowerCase());
};
const hasColumn = async (qi, table, col) => {
  const d = await qi.describeTable(table);
  return Object.keys(d).some((c) => c.toLowerCase() === col.toLowerCase());
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await resolveTable(queryInterface, TABLE);
    if (!table) return;
    for (const col of ['rightInterpretation', 'leftInterpretation']) {
      if (!(await hasColumn(queryInterface, table, col))) {
        await queryInterface.addColumn(table, col, { type: Sequelize.TEXT, allowNull: true, defaultValue: null });
      }
    }
  },
  async down(queryInterface) {
    const table = await resolveTable(queryInterface, TABLE);
    if (!table) return;
    for (const col of ['leftInterpretation', 'rightInterpretation']) {
      if (await hasColumn(queryInterface, table, col)) {
        await queryInterface.removeColumn(table, col);
      }
    }
  },
};
