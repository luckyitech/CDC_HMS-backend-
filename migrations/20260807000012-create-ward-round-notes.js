'use strict';

// HMIS V3 Phase 4 — WardRoundNotes (daily SOAP progress notes). Guarded.

const TABLE = 'WardRoundNotes';

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
      id:            { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      AdmissionId:   { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Admissions', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      PatientId:     { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Patients', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      doctorId:      { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      roundDateTime: { type: Sequelize.DATE, allowNull: false },
      subjective:    { type: Sequelize.TEXT, allowNull: true },
      objective:     { type: Sequelize.TEXT, allowNull: true },
      assessment:    { type: Sequelize.TEXT, allowNull: true },
      plan:          { type: Sequelize.TEXT, allowNull: true },
      reviewFlag:    { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      status:        { type: Sequelize.ENUM('active', 'amended', 'voided'), allowNull: false, defaultValue: 'active' },
      amendedById:   { type: Sequelize.INTEGER, allowNull: true },
      amendedAt:     { type: Sequelize.DATE, allowNull: true },
      createdAt:     { type: Sequelize.DATE, allowNull: false },
      updatedAt:     { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface)) await queryInterface.dropTable(TABLE);
  },
};
