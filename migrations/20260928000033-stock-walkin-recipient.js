'use strict';

// Stock — walk-in (external) dispensing (13 Oct 2026, Emu): "should be able to
// allow dispensing to even a walk in who comes in for just supplies".
//
//   StockMovements.recipientName   NEW — who a walk-in dispense went to (not a
//   StockMovements.recipientPhone  NEW   registered patient; PatientId stays
//                                         empty). Readable in SQL, so walk-in
//                                         dispensing is reportable and a recall
//                                         can still reach the person.
//
// `down`: REFUSES once any walk-in dispense is recorded (restore the backup).

const TAG = '[20260928000033]';

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;
    const table = await findTable(qi, 'StockMovements');
    if (!table) throw new Error(`${TAG} StockMovements missing`);
    const cols = await qi.describeTable(table);
    if (!cols.recipientName) {
      await qi.addColumn(table, 'recipientName', { type: Sequelize.STRING(120), allowNull: true });
      console.log(`${TAG} StockMovements.recipientName added`);
    }
    if (!cols.recipientPhone) {
      await qi.addColumn(table, 'recipientPhone', { type: Sequelize.STRING(40), allowNull: true });
      console.log(`${TAG} StockMovements.recipientPhone added`);
    }
  },

  async down(queryInterface) {
    const qi = queryInterface;
    const table = await findTable(qi, 'StockMovements');
    if (!table) return;
    const cols = await qi.describeTable(table);
    if (cols.recipientName) {
      const [rows] = await qi.sequelize.query(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE recipientName IS NOT NULL`);
      const n = Number(rows[0].n ?? rows[0].N ?? 0);
      if (n > 0) throw new Error(`${TAG} down refused: ${n} walk-in dispense(s) recorded. Restore the database backup instead.`);
      await qi.removeColumn(table, 'recipientName');
    }
    if (cols.recipientPhone) await qi.removeColumn(table, 'recipientPhone');
    console.log(`${TAG} reverted (nothing used it)`);
  },
};
