'use strict';

// Converts StockMovements.reason from VARCHAR(255) to TEXT.
//
// The create migration originally used STRING; free-text override reasons and
// the concatenated stocktake string ("Stocktake: <note> (expected 12, counted
// 10)") can exceed 255 chars, and MySQL 8 strict mode ERRORS on overflow
// (1406 Data too long) rather than truncating — a 500 the first time a user
// types a long reason. This aligns the column with every other reason/note
// column in the codebase (all TEXT).
//
// Idempotent: the create migration now also declares TEXT, so on a fresh
// database this runs against a column that is already TEXT and simply
// re-applies the same type. Guarded so it no-ops if the table is absent.

const TABLE = 'StockMovements';
const COLUMN = 'reason';

const tableExists = async (queryInterface) => {
  const tables = await queryInterface.showAllTables();
  return tables
    .map((t) => (typeof t === 'string' ? t : t.tableName).toLowerCase())
    .includes(TABLE.toLowerCase());
};

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface))) return;
    const desc = await queryInterface.describeTable(TABLE);
    if (!desc[COLUMN]) return;
    if (String(desc[COLUMN].type).toUpperCase().includes('TEXT')) return; // already TEXT

    await queryInterface.changeColumn(TABLE, COLUMN, {
      type: Sequelize.TEXT,
      allowNull: true,
      defaultValue: null,
    });
  },

  async down(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface))) return;
    const desc = await queryInterface.describeTable(TABLE);
    if (!desc[COLUMN]) return;

    // Reverting to STRING risks truncating existing long reasons — only do it
    // when the column would fit. Best-effort down for a clean rollback.
    await queryInterface.changeColumn(TABLE, COLUMN, {
      type: Sequelize.STRING,
      allowNull: true,
      defaultValue: null,
    });
  },
};
