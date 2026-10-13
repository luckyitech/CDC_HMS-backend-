'use strict';

// Stock — corrections to a received delivery line (13 Oct 2026, Emu):
//
//   StockBatchEdits  NEW — one row per edit of a received line (StockBatch):
//                    who, when, the required reason, and what changed
//                    (`changes`: [{ field, from, to }] — for display; the
//                    quantity change itself is also a 'receipt_correction'
//                    ledger movement, so stock levels never depend on JSON).
//
// `down`: REFUSES once any edit exists (audit evidence — restore the backup
// instead).

const TAG = '[20260928000032]';

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;
    const batches = await findTable(qi, 'StockBatches');
    if (!batches) throw new Error(`${TAG} StockBatches missing`);
    const users = await findTable(qi, 'Users') || 'Users';

    if (!await findTable(qi, 'StockBatchEdits')) {
      await qi.createTable('StockBatchEdits', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        stockBatchId: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: batches, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        editedById: {
          type: Sequelize.INTEGER, allowNull: true,
          references: { model: users, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
        },
        reason: { type: Sequelize.TEXT, allowNull: false },
        changes: { type: Sequelize.JSON, allowNull: false },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      await qi.addIndex('StockBatchEdits', ['stockBatchId'], { name: 'idx_stock_batch_edits_batch' });
      console.log(`${TAG} StockBatchEdits created`);
    }
  },

  async down(queryInterface) {
    const qi = queryInterface;
    const t = await findTable(qi, 'StockBatchEdits');
    if (!t) return;
    const [rows] = await qi.sequelize.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
    const n = Number(rows[0].n ?? rows[0].N ?? 0);
    if (n > 0) throw new Error(`${TAG} down refused: ${n} delivery edit(s) recorded. Restore the database backup instead.`);
    await qi.dropTable(t);
    console.log(`${TAG} reverted (nothing used it)`);
  },
};
