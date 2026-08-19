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
    // Guarded so this migration is safe to re-run, and safe on a database
    // built by sequelize.sync() — which is what server.js does on boot, so it
    // is the normal state of every dev machine here. Without this the migration
    // throws on an existing column and sequelize-cli stops, taking every later
    // migration with it.
    const addIfMissing = async (tableName, column, spec) => {
      // Resolve the real casing first. Some migrations name tables in lower
      // case, which MySQL on Windows accepts (lower_case_table_names=1) and a
      // case-sensitive host does not — so the guard has to be the tolerant part
      // rather than a second thing that only works on one platform.
      const actual = (await queryInterface.showAllTables())
        .map((t) => String(typeof t === 'string' ? t : t.tableName))
        .find((t) => t.toLowerCase() === String(tableName).toLowerCase());
      if (!actual) return;
      const desc = await queryInterface.describeTable(actual);
      if (desc[column]) return;
      await queryInterface.addColumn(actual, column, spec);
    };
    const addIndexIfMissing = async (...args) => {
      try {
        await queryInterface.addIndex(...args);
      } catch (err) {
        // Duplicate index names / duplicate key names are the re-run case.
        if (!/duplicate|exists/i.test(err.message || '')) throw err;
      }
    };

    if (!(await columnExists(queryInterface, 'patientName'))) {
      await addIfMissing(TABLE, 'patientName', {
        type: Sequelize.STRING, allowNull: true,
      });
    }
    if (!(await columnExists(queryInterface, 'patientBirthDate'))) {
      await addIfMissing(TABLE, 'patientBirthDate', {
        type: Sequelize.DATEONLY, allowNull: true,
      });
    }
    if (!(await columnExists(queryInterface, 'studyInstanceUid'))) {
      await addIfMissing(TABLE, 'studyInstanceUid', {
        type: Sequelize.STRING, allowNull: true,
      });
      await addIndexIfMissing(TABLE, ['studyInstanceUid'], { name: 'ultrasound_images_study_uid' });
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
