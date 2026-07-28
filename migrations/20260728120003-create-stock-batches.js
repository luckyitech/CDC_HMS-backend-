'use strict';

// Stock module — a delivery of one item, with its expiry. The unit of
// FEFO and of recall; every physical quantity belongs to a batch. The
// labelCode (STK-000123) is the internal barcode printed at intake.
// Guarded; working down().

const TABLE = 'StockBatches';

const tableExists = async (queryInterface) => {
  const tables = await queryInterface.showAllTables();
  return tables
    .map((t) => (typeof t === 'string' ? t : t.tableName).toLowerCase())
    .includes(TABLE.toLowerCase());
};

module.exports = {
  async up(queryInterface, Sequelize) {
    if (await tableExists(queryInterface)) return;

    await queryInterface.createTable(TABLE, {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      stockItemId: {
        type: Sequelize.INTEGER, allowNull: false,
        references: { model: 'StockItems', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT',
      },
      // Manufacturer lot number as printed on the box.
      batchNo: { type: Sequelize.STRING, allowNull: true, defaultValue: null },
      // Required by the controller for medications/dated supplies; nullable in
      // the schema for genuinely undated items.
      expiryDate: { type: Sequelize.DATEONLY, allowNull: true, defaultValue: null },
      supplierId: {
        type: Sequelize.INTEGER, allowNull: true,
        references: { model: 'Suppliers', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      // Total units in this delivery.
      qtyReceived: { type: Sequelize.INTEGER, allowNull: false },
      receivedAt: { type: Sequelize.DATE, allowNull: false },
      receivedById: {
        type: Sequelize.INTEGER, allowNull: true,
        references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      // Internal barcode on the printed shelf label, e.g. 'STK-000123'.
      // The STK- prefix is already reserved in barcodeController's NAMESPACES.
      labelCode: { type: Sequelize.STRING, allowNull: true, unique: true },
      // 'active' | 'depleted' | 'expired' | 'recalled' — STRING, not ENUM.
      status: { type: Sequelize.STRING, allowNull: false, defaultValue: 'active' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    // FEFO scans: batches for an item ordered by expiry.
    await queryInterface.addIndex(TABLE, ['stockItemId', 'expiryDate'], {
      name: 'idx_stock_batches_item_expiry',
    });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface)) {
      await queryInterface.dropTable(TABLE);
    }
  },
};
