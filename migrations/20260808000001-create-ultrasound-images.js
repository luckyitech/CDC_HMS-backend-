'use strict';

// HMIS V4 — UltrasoundImages (auto-ingested HS70A images via DICOM bridge). Guarded.

const TABLE = 'UltrasoundImages';

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
      id:               { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      PatientId:        { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Patients', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      dicomPatientId:   { type: Sequelize.STRING, allowNull: false },
      sopInstanceUid:   { type: Sequelize.STRING, allowNull: false, unique: true },
      studyDate:        { type: Sequelize.DATEONLY, allowNull: true },
      studyDescription: { type: Sequelize.STRING, allowNull: true },
      isMultiframe:     { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      fileName:         { type: Sequelize.STRING, allowNull: false },
      filePath:         { type: Sequelize.STRING, allowNull: false },
      fileUrl:          { type: Sequelize.STRING, allowNull: true },
      status:           { type: Sequelize.ENUM('Unassigned', 'Matched', 'Archived'), allowNull: false, defaultValue: 'Unassigned' },
      isArchived:       { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      archivedBy:       { type: Sequelize.STRING, allowNull: true },
      archivedAt:       { type: Sequelize.DATE, allowNull: true },
      archiveReason:    { type: Sequelize.TEXT, allowNull: true },
      receivedAt:       { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      createdAt:        { type: Sequelize.DATE, allowNull: false },
      updatedAt:        { type: Sequelize.DATE, allowNull: false },
    });
    // sopInstanceUid unique index is created by `unique: true` above.
    await queryInterface.addIndex(TABLE, ['PatientId'], { name: 'ultrasound_images_patient_id' });
    await queryInterface.addIndex(TABLE, ['dicomPatientId'], { name: 'ultrasound_images_dicom_patient_id' });
    await queryInterface.addIndex(TABLE, ['status'], { name: 'ultrasound_images_status' });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface)) await queryInterface.dropTable(TABLE);
  },
};
