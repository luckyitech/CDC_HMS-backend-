'use strict';

// HR Suite (B21) — UserLoginLogs.method: 'password' (login form) or 'device'
// (a remembered phone exchanging its token at the entrance tag). NULL on old
// rows reads as 'password'. sync() never adds a column to an existing table,
// so this must actually run (A4). Guarded, reversible.

const TABLE = 'UserLoginLogs';

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
    if (!(await hasColumn(queryInterface, table, 'method'))) {
      await queryInterface.addColumn(table, 'method', {
        type: Sequelize.STRING(16),
        allowNull: true,
        defaultValue: null,
      });
    }
  },

  async down(queryInterface) {
    const table = await resolveTable(queryInterface, TABLE);
    if (!table) return;
    if (await hasColumn(queryInterface, table, 'method')) {
      await queryInterface.removeColumn(table, 'method');
    }
  },
};
