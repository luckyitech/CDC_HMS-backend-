'use strict';

// HMIS V3 Phase 3 — MedicationAdministrations (the MAR signature rows). Guarded.

const TABLE = 'MedicationAdministrations';

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
      id:                          { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      InpatientMedicationOrderId:  { type: Sequelize.INTEGER, allowNull: true, references: { model: 'InpatientMedicationOrders', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      AdmissionId:                 { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Admissions', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      PatientId:                   { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Patients', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      scheduledDate:   { type: Sequelize.DATEONLY, allowNull: false },
      roundLabel:      { type: Sequelize.STRING, allowNull: true },
      scheduledTime:   { type: Sequelize.DATE, allowNull: true },
      status:          { type: Sequelize.ENUM('Given', 'Held', 'Refused', 'Omitted', 'NotAvailable', 'Due'), allowNull: false, defaultValue: 'Due' },
      administeredAt:   { type: Sequelize.DATE, allowNull: true },
      administeredById: { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      witnessedById:    { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      reasonIfNotGiven: { type: Sequelize.STRING, allowNull: true },
      notes:            { type: Sequelize.TEXT, allowNull: true },
      createdAt:        { type: Sequelize.DATE, allowNull: false },
      updatedAt:        { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface)) await queryInterface.dropTable(TABLE);
  },
};
