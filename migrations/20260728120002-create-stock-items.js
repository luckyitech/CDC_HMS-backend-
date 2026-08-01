'use strict';

// Stock module — one row per product the clinic stocks (not per box, not per
// batch). Medications link to the prescribing vocabulary via catalogItemId so
// there is one source of truth for what a drug is called. Guarded; down().

const TABLE = 'StockItems';

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
      name: { type: Sequelize.STRING, allowNull: false, unique: true },
      // 'medication' | 'consumable' | 'fluid' | 'dressing' | 'sharps' |
      // 'diagnostic' | 'other' — STRING not ENUM so the clinic can add
      // categories without a migration.
      category: { type: Sequelize.STRING, allowNull: false },
      // Set for medications — links stock to the CatalogItem vocabulary.
      catalogItemId: {
        type: Sequelize.INTEGER, allowNull: true,
        references: { model: 'CatalogItems', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      // The unit stock is counted in: 'vial', 'piece', 'bottle', 'box', 'pack'.
      unit: { type: Sequelize.STRING, allowNull: false },
      // Units per supplier pack — intake convenience ("received 3 boxes of 100").
      packSize: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      // Manufacturer barcode: scanning the retail box at intake selects the item.
      gtin: { type: Sequelize.STRING, allowNull: true, defaultValue: null },
      // Insulin, GLP-1 agents — restricts holding to fridge locations.
      requiresColdChain: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      // Visual warning on dispense (insulin, KCl, …).
      isHighAlert: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      // Clinic-wide threshold driving the reorder report.
      reorderLevel: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      reorderQuantity: { type: Sequelize.INTEGER, allowNull: true, defaultValue: null },
      // 'active' | 'retired' — soft delete, never destroy().
      status: { type: Sequelize.STRING, allowNull: false, defaultValue: 'active' },
      addedById: {
        type: Sequelize.INTEGER, allowNull: true,
        references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      lastUpdatedById: {
        type: Sequelize.INTEGER, allowNull: true,
        references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface)) {
      await queryInterface.dropTable(TABLE);
    }
  },
};
