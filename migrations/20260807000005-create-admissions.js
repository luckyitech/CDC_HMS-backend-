'use strict';

// HMIS V3 Phase 1 — Admissions (the inpatient spine). Guarded; working down().

const TABLE = 'Admissions';

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
      id:                { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      PatientId:         { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Patients', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      WardId:            { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Wards', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      RoomId:            { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Rooms', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      BedId:             { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Beds', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      admittingDoctorId: { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      attendingDoctorId: { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      admissionDateTime:    { type: Sequelize.DATE, allowNull: false },
      admissionReason:      { type: Sequelize.TEXT, allowNull: true },
      provisionalDiagnosis: { type: Sequelize.TEXT, allowNull: true },
      admissionType:   { type: Sequelize.ENUM('Emergency', 'Elective', 'Transfer', 'Observation'), allowNull: false, defaultValue: 'Elective' },
      admissionSource: { type: Sequelize.ENUM('OPD', 'Referral', 'Walk-in', 'Transfer-in'), allowNull: false, defaultValue: 'OPD' },
      status:          { type: Sequelize.ENUM('Admitted', 'OnLeave', 'Transferred', 'Discharged', 'Deceased', 'Absconded'), allowNull: false, defaultValue: 'Admitted' },
      dischargeDateTime: { type: Sequelize.DATE, allowNull: true },
      dischargeType:     { type: Sequelize.ENUM('Routine', 'AgainstAdvice', 'Referred', 'Deceased', 'Absconded'), allowNull: true },
      lengthOfStayHours: { type: Sequelize.INTEGER, allowNull: true },
      fromQueueId:    { type: Sequelize.INTEGER, allowNull: true },
      admittedById:   { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      dischargedById: { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      opdBillingMode: { type: Sequelize.ENUM('clear', 'merge'), allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface)) await queryInterface.dropTable(TABLE);
  },
};
