'use strict';

// Stock module — physical locations stock can sit in (Main Store, Dr Room 1,
// Fridge, …). User-addable; kind drives the room-balance screen. Guarded per
// repo convention; working down().

const TABLE = 'StockLocations';

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
      // 'store' | 'doctor_room' | 'procedure_room' | 'triage' | 'fridge' |
      // 'office' — plain STRING, not ENUM, so new kinds need no migration
      // (the Queue-status ENUM migrations taught us that lesson).
      kind: { type: Sequelize.STRING, allowNull: false },
      // Only cold-chain locations may hold requiresColdChain items.
      isColdChain: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      // Can stock leave the building from here (vs store-only).
      isDispensing: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      // Soft delete — never destroy() rows other records reference.
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
