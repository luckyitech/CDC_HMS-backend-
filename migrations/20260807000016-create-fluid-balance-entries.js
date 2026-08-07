'use strict';

// HMIS V3 Phase 5 — FluidBalanceEntries (intake/output). Guarded.

const TABLE = 'FluidBalanceEntries';

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
      PatientId:    { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Patients', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      recordedAt:   { type: Sequelize.DATE, allowNull: false },
      recordedById: { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      direction:    { type: Sequelize.ENUM('Intake', 'Output'), allowNull: false },
      type:         { type: Sequelize.STRING, allowNull: true },
      volumeMl:     { type: Sequelize.INTEGER, allowNull: false },
      notes:        { type: Sequelize.TEXT, allowNull: true },
      status:       { type: Sequelize.ENUM('active', 'voided'), allowNull: false, defaultValue: 'active' },
      createdAt:    { type: Sequelize.DATE, allowNull: false },
      updatedAt:    { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface)) await queryInterface.dropTable(TABLE);
  },
};
