'use strict';

// HMIS V4 — Ultrasound Studio: demographics + study grouping straight from the
// DICOM header (PatientName, PatientBirthDate, StudyInstanceUID). Guarded.

const TABLE = 'UltrasoundImages';

const columnExists = async (qi, col) => {
  const [cols] = await qi.sequelize.query(`SHOW COLUMNS FROM ${TABLE} LIKE '${col}'`);
  return cols.length > 0;
};

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await columnExists(queryInterface, 'patientName'))) {
      await queryInterface.addColumn(TABLE, 'patientName', {
        type: Sequelize.STRING, allowNull: true,
      });
    }
    if (!(await columnExists(queryInterface, 'patientBirthDate'))) {
      await queryInterface.addColumn(TABLE, 'patientBirthDate', {
        type: Sequelize.DATEONLY, allowNull: true,
      });
    }
    if (!(await columnExists(queryInterface, 'studyInstanceUid'))) {
      await queryInterface.addColumn(TABLE, 'studyInstanceUid', {
        type: Sequelize.STRING, allowNull: true,
      });
      await queryInterface.addIndex(TABLE, ['studyInstanceUid'], { name: 'ultrasound_images_study_uid' });
    }
  },

  async down(queryInterface) {
    if (await columnExists(queryInterface, 'studyInstanceUid')) {
      await queryInterface.removeIndex(TABLE, 'ultrasound_images_study_uid').catch(() => {});
      await queryInterface.removeColumn(TABLE, 'studyInstanceUid');
    }
    if (await columnExists(queryInterface, 'patientBirthDate')) {
      await queryInterface.removeColumn(TABLE, 'patientBirthDate');
    }
    if (await columnExists(queryInterface, 'patientName')) {
      await queryInterface.removeColumn(TABLE, 'patientName');
    }
  },
};
