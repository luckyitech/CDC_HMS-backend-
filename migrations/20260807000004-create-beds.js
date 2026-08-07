'use strict';

// HMIS V3 Phase 0 — Beds config table (belongs to Room + Ward denormalised).
// onDelete RESTRICT on Room/Ward so a bed with history can't be silently lost.

const TABLE = 'Beds';

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
      RoomId:    { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Rooms', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      WardId:    { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Wards', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      label:     { type: Sequelize.STRING,  allowNull: false },
      status:    { type: Sequelize.ENUM('Available', 'Occupied', 'Cleaning', 'Blocked', 'Reserved'), allowNull: false, defaultValue: 'Available' },
      isActive:  { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface)) await queryInterface.dropTable(TABLE);
  },
};
