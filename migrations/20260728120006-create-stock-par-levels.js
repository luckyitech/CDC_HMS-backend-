'use strict';

// Stock module — target range per item per room (min/max). Drives the Room
// Balance screen; only meaningful for non-store locations. Guarded; down().

const TABLE = 'StockParLevels';

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
        references: { model: 'StockItems', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
      },
      locationId: {
        type: Sequelize.INTEGER, allowNull: false,
        references: { model: 'StockLocations', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
      },
      minQty: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      maxQty: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      lastUpdatedById: {
        type: Sequelize.INTEGER, allowNull: true,
        references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex(TABLE, ['stockItemId', 'locationId'], {
      name: 'unique_stock_par_item_location',
      unique: true,
    });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface)) {
      await queryInterface.dropTable(TABLE);
    }
  },
};
