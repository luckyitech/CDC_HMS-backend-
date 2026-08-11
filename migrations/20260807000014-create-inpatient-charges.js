'use strict';

// HMIS V3 Phase 5 — InpatientCharges (billing accrual). Guarded.

const TABLE = 'InpatientCharges';

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
      id:          { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      AdmissionId: { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Admissions', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      PatientId:   { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Patients', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      chargeDate:  { type: Sequelize.DATEONLY, allowNull: false },
      category:    { type: Sequelize.ENUM('BedDay', 'Drug', 'Procedure', 'Lab', 'Radiology', 'Consumable', 'Other'), allowNull: false, defaultValue: 'Other' },
      description: { type: Sequelize.STRING,  allowNull: false },
      quantity:    { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      unitAmount:  { type: Sequelize.FLOAT,   allowNull: false, defaultValue: 0 },
      amount:      { type: Sequelize.FLOAT,   allowNull: false, defaultValue: 0 },
      sourceType:  { type: Sequelize.STRING,  allowNull: true },
      sourceId:    { type: Sequelize.INTEGER, allowNull: true },
      addedById:   { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      status:      { type: Sequelize.ENUM('active', 'voided'), allowNull: false, defaultValue: 'active' },
      createdAt:   { type: Sequelize.DATE, allowNull: false },
      updatedAt:   { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface)) await queryInterface.dropTable(TABLE);
  },
};
