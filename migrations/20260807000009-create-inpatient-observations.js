'use strict';

// HMIS V3 Phase 2 — InpatientObservations (nursing obs + frozen NEWS2). Guarded.

const TABLE = 'InpatientObservations';

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
      respRate:     { type: Sequelize.INTEGER, allowNull: true },
      spo2:         { type: Sequelize.INTEGER, allowNull: true },
      onOxygen:     { type: Sequelize.BOOLEAN, allowNull: true },
      systolicBP:   { type: Sequelize.INTEGER, allowNull: true },
      diastolicBP:  { type: Sequelize.INTEGER, allowNull: true },
      heartRate:    { type: Sequelize.INTEGER, allowNull: true },
      temperature:  { type: Sequelize.FLOAT,   allowNull: true },
      consciousness:{ type: Sequelize.ENUM('A', 'C', 'V', 'P', 'U'), allowNull: true },
      rbs:          { type: Sequelize.FLOAT,   allowNull: true },
      painScore:    { type: Sequelize.INTEGER, allowNull: true },
      newsScore:     { type: Sequelize.INTEGER, allowNull: true },
      newsBreakdown: { type: Sequelize.JSON,    allowNull: true },
      escalation:    { type: Sequelize.ENUM('None', 'Low', 'Medium', 'High'), allowNull: true },
      notes:        { type: Sequelize.TEXT, allowNull: true },
      status:       { type: Sequelize.ENUM('active', 'amended', 'voided'), allowNull: false, defaultValue: 'active' },
      amendedById:  { type: Sequelize.INTEGER, allowNull: true },
      amendedAt:    { type: Sequelize.DATE, allowNull: true },
      createdAt:    { type: Sequelize.DATE, allowNull: false },
      updatedAt:    { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface)) await queryInterface.dropTable(TABLE);
  },
};
