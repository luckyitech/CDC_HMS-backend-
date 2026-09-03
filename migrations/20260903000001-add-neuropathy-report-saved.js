'use strict';

// Adds the "report saved once" guard to NeuropathyStudies: reportSavedAt marks
// when the graded report PDF was first filed to the patient's Medical Documents,
// and reportDocumentId links that document. Once set, the report is view/print
// only — the exam UI disables a second Save. Guarded and reversible.

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
    if (!(await hasColumn(queryInterface, table, 'reportSavedAt'))) {
      await queryInterface.addColumn(table, 'reportSavedAt', { type: Sequelize.DATE, allowNull: true, defaultValue: null });
    }
    if (!(await hasColumn(queryInterface, table, 'reportDocumentId'))) {
      await queryInterface.addColumn(table, 'reportDocumentId', { type: Sequelize.INTEGER, allowNull: true, defaultValue: null });
    }
  },
  async down(queryInterface) {
    const table = await resolveTable(queryInterface, TABLE);
    if (!table) return;
    for (const col of ['reportDocumentId', 'reportSavedAt']) {
      if (await hasColumn(queryInterface, table, col)) {
        await queryInterface.removeColumn(table, col);
      }
    }
  },
};
