'use strict';

// HMIS V3 Phase 0 — Wards config table. Guarded; working down().

const TABLE = 'Wards';

const tableExists = async (qi) => {
  const tables = await qi.showAllTables();
  return tables
    .map((t) => (typeof t === 'string' ? t : t.tableName).toLowerCase())
    .includes(TABLE.toLowerCase());
};

module.exports = {
  async up(queryInterface, Sequelize) {
    if (await tableExists(queryInterface)) return;
    await queryInterface.createTable(TABLE, {
      id:        { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      name:      { type: Sequelize.STRING,  allowNull: false },
      code:      { type: Sequelize.STRING,  allowNull: true },
      type:      { type: Sequelize.ENUM('General', 'HDU', 'Private', 'Isolation', 'Maternity'), allowNull: false, defaultValue: 'General' },
      isActive:  { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface)) await queryInterface.dropTable(TABLE);
  },
};
