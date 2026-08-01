'use strict';

// Stock module — current quantity per batch per location. A materialized
// convenience updated in the same transaction as each movement insert; the
// ledger stays authoritative and an admin rebuild action can recompute this
// table from it at any time. Guarded; working down().

const TABLE = 'StockLevels';

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
      stockBatchId: {
        type: Sequelize.INTEGER, allowNull: false,
        references: { model: 'StockBatches', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
      },
      locationId: {
        type: Sequelize.INTEGER, allowNull: false,
        references: { model: 'StockLocations', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT',
      },
      quantity: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex(TABLE, ['stockBatchId', 'locationId'], {
      name: 'unique_stock_level_batch_location',
      unique: true,
    });
    await queryInterface.addIndex(TABLE, ['locationId'], {
      name: 'idx_stock_levels_location',
    });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface)) {
      await queryInterface.dropTable(TABLE);
    }
  },
};
