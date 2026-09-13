'use strict';

// Glucose Management Centre — Phase 2: the patient diary.
//
//   PatientDiaryEvents   one row per diary entry (meal / activity / insulin /
//                        oral med / symptom / note), logged by the patient in
//                        the portal or by a clinician on their behalf. The
//                        server time-matches meal entries to nearby meter
//                        readings (utils/glucoseMatching.js) and writes a
//                        pre-/post-meal tag onto the reading — the only route
//                        to meal context, since the Accu-Chek Instant sends
//                        none. Soft-delete via `status` (A5).
//
// Guarded and reversible, in the same style as the Phase 1 GMC migration.

const TABLE = 'PatientDiaryEvents';

const tableExists = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables
    .map((t) => (typeof t === 'string' ? t : t.tableName).toLowerCase())
    .includes(name.toLowerCase());
};

module.exports = {
  async up(queryInterface, Sequelize) {
    if (await tableExists(queryInterface, TABLE)) return;
    await queryInterface.createTable(TABLE, {
      id:            { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      PatientId:     {
        type: Sequelize.INTEGER, allowNull: false,
        references: { model: 'Patients', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT',
      },
      eventType:     { type: Sequelize.ENUM('meal', 'activity', 'insulin', 'oral_med', 'symptom', 'note'), allowNull: false },
      // Phone wall-clock time — a naive DATETIME on the same axis as
      // GlucoseMeterReadings.measuredAt; never converted.
      occurredAt:    { type: Sequelize.DATE, allowNull: false },
      label:         { type: Sequelize.STRING(120), allowNull: true },
      detail:        { type: Sequelize.JSON, allowNull: true },     // display context only (carbs, minutes, units, drug, severity)
      enteredById:   {
        type: Sequelize.INTEGER, allowNull: true,
        references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      enteredByRole: { type: Sequelize.ENUM('patient', 'clinic', 'bridge'), allowNull: false, defaultValue: 'patient' },
      status:        { type: Sequelize.ENUM('Active', 'Deleted'), allowNull: false, defaultValue: 'Active' },
      deletedAt:     { type: Sequelize.DATE, allowNull: true },
      createdAt:     { type: Sequelize.DATE, allowNull: false },
      updatedAt:     { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex(TABLE, ['PatientId', 'occurredAt'], { name: 'patient_diary_events_patient_time' });
    await queryInterface.addIndex(TABLE, ['PatientId', 'status'], { name: 'patient_diary_events_patient_status' });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface, TABLE)) await queryInterface.dropTable(TABLE);
  },
};
