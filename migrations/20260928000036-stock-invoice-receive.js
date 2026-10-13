'use strict';

// Stock — receiving a delivery from its invoice (13 Oct 2026, Emu): the
// invoice is photographed or scanned, the HMS reads the lines, staff confirm
// every line and save them together.
//
//   StockSupplierAliases  NEW — how a supplier writes a product on its
//                         invoices ("GLUCOFIX STRP 50S") → the clinic's item.
//                         One row per supplier + wording; saved from every
//                         confirmed line, so the next delivery matches by
//                         itself. A corrected match replaces the old row.
//   StockBatches          + receiveMethod   'manual' | 'invoice' — how the line
//                                           was entered (reports and audit).
//                         + sourceText      the wording read from the invoice
//                         + sourceCorrections what staff changed before saving
//                                           (field names, comma-separated), so an
//                                           audit can see what the reader got
//                                           wrong — e.g. "batchNo,expiryDate".
//
// Rows received before this migration are 'manual' (they were).
//
// `down`: removes the columns; REFUSES to drop the alias table once anything
// has been learned (restore the backup instead).

const TAG = '[20260928000036]';

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;
    const batches = await findTable(qi, 'StockBatches');
    const items = await findTable(qi, 'StockItems');
    const suppliers = await findTable(qi, 'Suppliers');
    const users = await findTable(qi, 'Users');
    if (!batches || !items || !suppliers || !users) throw new Error(`${TAG} a required table is missing`);

    const cols = await qi.describeTable(batches);
    if (!cols.receiveMethod) {
      await qi.addColumn(batches, 'receiveMethod', { type: Sequelize.STRING(12), allowNull: false, defaultValue: 'manual' });
      console.log(`${TAG} StockBatches.receiveMethod added`);
    }
    if (!cols.sourceText) {
      await qi.addColumn(batches, 'sourceText', { type: Sequelize.STRING(160), allowNull: true, defaultValue: null });
      console.log(`${TAG} StockBatches.sourceText added`);
    }
    if (!cols.sourceCorrections) {
      await qi.addColumn(batches, 'sourceCorrections', { type: Sequelize.STRING(120), allowNull: true, defaultValue: null });
      console.log(`${TAG} StockBatches.sourceCorrections added`);
    }

    if (!await findTable(qi, 'StockSupplierAliases')) {
      await qi.createTable('StockSupplierAliases', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        supplierId: {
          type: Sequelize.INTEGER, allowNull: true,   // null = a delivery with no supplier chosen
          references: { model: suppliers, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        // The wording normalised (upper-case, punctuation out, spaces collapsed) — the lookup key.
        aliasKey: { type: Sequelize.STRING(160), allowNull: false },
        // The wording as it was read, for display.
        aliasText: { type: Sequelize.STRING(160), allowNull: false },
        stockItemId: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: items, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        createdById: {
          type: Sequelize.INTEGER, allowNull: true,
          references: { model: users, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
        },
        useCount: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
        lastUsedAt: { type: Sequelize.DATE, allowNull: false },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      await qi.addIndex('StockSupplierAliases', ['supplierId', 'aliasKey'], { name: 'idx_stock_supplier_aliases_lookup', unique: true });
      await qi.addIndex('StockSupplierAliases', ['stockItemId'], { name: 'idx_stock_supplier_aliases_item' });
      console.log(`${TAG} StockSupplierAliases created`);
    }
  },

  async down(queryInterface) {
    const qi = queryInterface;
    const aliases = await findTable(qi, 'StockSupplierAliases');
    if (aliases) {
      const [rows] = await qi.sequelize.query(`SELECT COUNT(*) AS n FROM \`${aliases}\``);
      const n = Number(rows[0].n ?? rows[0].N ?? 0);
      if (n > 0) throw new Error(`${TAG} down refused: ${n} supplier wording(s) learned. Restore the database backup instead.`);
      await qi.dropTable(aliases);
    }
    const batches = await findTable(qi, 'StockBatches');
    if (batches) {
      const cols = await qi.describeTable(batches);
      for (const c of ['sourceCorrections', 'sourceText', 'receiveMethod']) {
        if (cols[c]) await qi.removeColumn(batches, c);
      }
    }
    console.log(`${TAG} reverted`);
  },
};
