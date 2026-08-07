'use strict';

// HMIS V3 Phase 1 — BedAssignments (bed-movement history). Guarded; working down().

const TABLE = 'BedAssignments';

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
      id:           { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      AdmissionId:  { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Admissions', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      BedId:        { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Beds', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      WardId:       { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Wards', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      fromDateTime: { type: Sequelize.DATE, allowNull: false },
      toDateTime:   { type: Sequelize.DATE, allowNull: true },
      reason:       { type: Sequelize.TEXT, allowNull: true },
      movedById:    { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      createdAt:    { type: Sequelize.DATE, allowNull: false },
      updatedAt:    { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface)) await queryInterface.dropTable(TABLE);
  },
};
