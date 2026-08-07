'use strict';

// HMIS V3 Phase 3 — InpatientMedicationOrders. Guarded; working down().

const TABLE = 'InpatientMedicationOrders';

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
      catalogItemId: { type: Sequelize.INTEGER, allowNull: true, references: { model: 'CatalogItems', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      drugName:      { type: Sequelize.STRING,  allowNull: false },
      dose:          { type: Sequelize.STRING,  allowNull: false },
      route:         { type: Sequelize.ENUM('PO', 'IV', 'IM', 'SC', 'PR', 'INH', 'TOP', 'Other'), allowNull: false, defaultValue: 'PO' },
      scheduleCode:  { type: Sequelize.STRING, allowNull: true },
      scheduleTimes: { type: Sequelize.JSON,   allowNull: true },
      frequencyLabel:{ type: Sequelize.STRING, allowNull: true },
      isPRN:         { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      prnIndication: { type: Sequelize.STRING,  allowNull: true },
      isStat:        { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      statTime:      { type: Sequelize.DATE,    allowNull: true },
      startDateTime: { type: Sequelize.DATE,    allowNull: false },
      stopDateTime:  { type: Sequelize.DATE,    allowNull: true },
      prescribedById:{ type: Sequelize.INTEGER, allowNull: true, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      status:        { type: Sequelize.ENUM('Active', 'Suspended', 'Stopped', 'Completed'), allowNull: false, defaultValue: 'Active' },
      stoppedById:   { type: Sequelize.INTEGER, allowNull: true },
      stopReason:    { type: Sequelize.STRING,  allowNull: true },
      createdAt:     { type: Sequelize.DATE, allowNull: false },
      updatedAt:     { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface)) await queryInterface.dropTable(TABLE);
  },
};
