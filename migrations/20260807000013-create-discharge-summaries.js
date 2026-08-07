'use strict';

// HMIS V3 Phase 4 — DischargeSummaries (one per admission). Guarded.

const TABLE = 'DischargeSummaries';

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
      finalDiagnoses:       { type: Sequelize.TEXT, allowNull: true },
      proceduresDone:       { type: Sequelize.TEXT, allowNull: true },
      hospitalCourse:       { type: Sequelize.TEXT, allowNull: true },
      dischargeMeds:        { type: Sequelize.JSON, allowNull: true },
      followUpPlan:         { type: Sequelize.TEXT, allowNull: true },
      conditionAtDischarge: { type: Sequelize.ENUM('Recovered', 'Improved', 'Unchanged', 'Referred', 'Deceased'), allowNull: true },
      dischargeType:        { type: Sequelize.ENUM('Routine', 'AgainstAdvice', 'Referred', 'Deceased', 'Absconded'), allowNull: true },
      generatedBy:  { type: Sequelize.ENUM('auto', 'ai', 'manual'), allowNull: true },
      signedById:   { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      signedAt:     { type: Sequelize.DATE, allowNull: true },
      status:       { type: Sequelize.ENUM('draft', 'signed'), allowNull: false, defaultValue: 'draft' },
      createdAt:    { type: Sequelize.DATE, allowNull: false },
      updatedAt:    { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface)) await queryInterface.dropTable(TABLE);
  },
};
