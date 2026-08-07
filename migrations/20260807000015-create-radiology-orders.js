'use strict';

// HMIS V3 Phase 5 — RadiologyOrders (imaging order → report). Guarded.

const TABLE = 'RadiologyOrders';

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
      id:              { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      AdmissionId:     { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Admissions', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      PatientId:       { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Patients', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      modality:        { type: Sequelize.ENUM('XRay', 'CT', 'MRI', 'Ultrasound', 'Mammogram', 'Other'), allowNull: false, defaultValue: 'XRay' },
      region:          { type: Sequelize.STRING, allowNull: false },
      clinicalDetails: { type: Sequelize.TEXT, allowNull: true },
      priority:        { type: Sequelize.ENUM('Routine', 'Urgent'), allowNull: false, defaultValue: 'Routine' },
      orderedById:     { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      status:          { type: Sequelize.ENUM('Ordered', 'InProgress', 'Reported', 'Cancelled'), allowNull: false, defaultValue: 'Ordered' },
      reportText:      { type: Sequelize.TEXT, allowNull: true },
      reportedById:    { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      reportedAt:      { type: Sequelize.DATE, allowNull: true },
      documentId:      { type: Sequelize.INTEGER, allowNull: true },
      createdAt:       { type: Sequelize.DATE, allowNull: false },
      updatedAt:       { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface)) await queryInterface.dropTable(TABLE);
  },
};
