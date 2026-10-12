'use strict';

// Stock — supplier invoices / receipts with scanned documents (12 Oct 2026, Emu):
//
//   StockReceipts            NEW — one per supplier + invoice/receipt number
//                            (numberKey = the number normalised), its kind and
//                            who first entered it.
//   StockReceiptDocuments    NEW — the scanned pages (photo or PDF) of a receipt;
//                            soft removal only (status, removedById, removedAt).
//   StockBatches.stockReceiptId NEW — the receipt a delivery line came in on.
//                            Empty for every batch received before this.
//
// `down`: REFUSES once any receipt exists (audit evidence — restore the backup
// instead).

const TAG = '[20260928000030]';

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};
const count = async (qi, sql) => {
  const [rows] = await qi.sequelize.query(sql);
  return Number(rows[0].n ?? rows[0].N ?? 0);
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;
    const batches = await findTable(qi, 'StockBatches');
    if (!batches) throw new Error(`${TAG} StockBatches missing`);
    const suppliers = await findTable(qi, 'Suppliers') || 'Suppliers';
    const users = await findTable(qi, 'Users') || 'Users';

    if (!await findTable(qi, 'StockReceipts')) {
      await qi.createTable('StockReceipts', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        number: { type: Sequelize.STRING(80), allowNull: false },
        numberKey: { type: Sequelize.STRING(80), allowNull: false },
        kind: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'invoice' },
        supplierId: {
          type: Sequelize.INTEGER, allowNull: true,
          references: { model: suppliers, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
        },
        createdById: {
          type: Sequelize.INTEGER, allowNull: true,
          references: { model: users, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
        },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      await qi.addIndex('StockReceipts', ['numberKey'], { name: 'idx_stock_receipts_number' });
      await qi.addIndex('StockReceipts', ['supplierId'], { name: 'idx_stock_receipts_supplier' });
      console.log(`${TAG} StockReceipts created`);
    }

    if (!await findTable(qi, 'StockReceiptDocuments')) {
      await qi.createTable('StockReceiptDocuments', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        stockReceiptId: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: 'StockReceipts', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        filePath: { type: Sequelize.STRING, allowNull: false },
        fileName: { type: Sequelize.STRING, allowNull: false },
        mimeType: { type: Sequelize.STRING(100), allowNull: false },
        fileSize: { type: Sequelize.INTEGER, allowNull: false },
        status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'active' },
        uploadedById: {
          type: Sequelize.INTEGER, allowNull: true,
          references: { model: users, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
        },
        removedById: {
          type: Sequelize.INTEGER, allowNull: true,
          references: { model: users, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
        },
        removedAt: { type: Sequelize.DATE, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      await qi.addIndex('StockReceiptDocuments', ['stockReceiptId'], { name: 'idx_stock_receipt_docs_receipt' });
      console.log(`${TAG} StockReceiptDocuments created`);
    }

    const cols = await qi.describeTable(batches);
    if (!cols.stockReceiptId) {
      await qi.addColumn(batches, 'stockReceiptId', {
        type: Sequelize.INTEGER, allowNull: true,
        references: { model: 'StockReceipts', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      });
      await qi.addIndex(batches, ['stockReceiptId'], { name: 'idx_stock_batches_receipt' });
      console.log(`${TAG} StockBatches.stockReceiptId added`);
    }
  },

  async down(queryInterface) {
    const qi = queryInterface;
    const receipts = await findTable(qi, 'StockReceipts');
    if (receipts) {
      const n = await count(qi, `SELECT COUNT(*) AS n FROM \`${receipts}\``);
      if (n > 0) throw new Error(`${TAG} down refused: ${n} invoice/receipt record(s) exist. Restore the database backup instead.`);
    }
    const batches = await findTable(qi, 'StockBatches');
    if (batches) {
      const cols = await qi.describeTable(batches);
      if (cols.stockReceiptId) {
        // MySQL names the FK itself; drop whichever constraint uses the column.
        const [fks] = await qi.sequelize.query(
          `SELECT CONSTRAINT_NAME AS name FROM information_schema.KEY_COLUMN_USAGE
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${batches}' AND COLUMN_NAME = 'stockReceiptId' AND REFERENCED_TABLE_NAME IS NOT NULL`,
        );
        for (const fk of fks) await qi.sequelize.query(`ALTER TABLE \`${batches}\` DROP FOREIGN KEY \`${fk.name}\``);
        try { await qi.removeIndex(batches, 'idx_stock_batches_receipt'); } catch { /* already gone */ }
        await qi.removeColumn(batches, 'stockReceiptId');
      }
    }
    if (await findTable(qi, 'StockReceiptDocuments')) await qi.dropTable('StockReceiptDocuments');
    if (receipts) await qi.dropTable(receipts);
    console.log(`${TAG} reverted (nothing used it)`);
  },
};
