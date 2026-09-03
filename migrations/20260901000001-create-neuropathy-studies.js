'use strict';

// Neuropathy Studio — NeuropathyStudies + NeuropathyReadings. Guarded, reversible.
//
// Adds the in-portal Vibrotherm Dx assessment (biothesiometry / thermal /
// monofilament). Studies are soft-deleted via `status`; readings are
// normalised one-row-per-site so every analyte is SQL-reportable.

const STUDIES  = 'NeuropathyStudies';
const READINGS = 'NeuropathyReadings';

const GRADES     = ['Normal', 'Mild', 'Moderate', 'Severe'];
const FEET       = ['R', 'L'];
const SITES      = ['greatToe', 'mth1', 'mth3', 'mth5', 'midfoot', 'heel'];
const MODALITIES = ['VPT', 'HOT', 'COLD', 'MONO'];

const tableExists = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables
    .map((t) => (typeof t === 'string' ? t : t.tableName).toLowerCase())
    .includes(name.toLowerCase());
};

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface, STUDIES))) {
      await queryInterface.createTable(STUDIES, {
        id:            { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        PatientId:     { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Patients', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT' },
        performedById: { type: Sequelize.INTEGER, allowNull: true,  references: { model: 'Users',    key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
        cancelledById: { type: Sequelize.INTEGER, allowNull: true,  references: { model: 'Users',    key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },

        studyDate:     { type: Sequelize.DATEONLY, allowNull: false },
        protocol:      { type: Sequelize.ENUM('plantar'), allowNull: false, defaultValue: 'plantar' },
        status:        { type: Sequelize.ENUM('Draft', 'Completed', 'Cancelled'), allowNull: false, defaultValue: 'Draft' },
        referral:      { type: Sequelize.STRING, allowNull: true },

        rightVptAvg:    { type: Sequelize.DECIMAL(5, 1), allowNull: true },
        rightVptGrade:  { type: Sequelize.ENUM(...GRADES), allowNull: true },
        leftVptAvg:     { type: Sequelize.DECIMAL(5, 1), allowNull: true },
        leftVptGrade:   { type: Sequelize.ENUM(...GRADES), allowNull: true },
        rightHotAvg:    { type: Sequelize.DECIMAL(5, 1), allowNull: true },
        rightHotGrade:  { type: Sequelize.ENUM(...GRADES), allowNull: true },
        leftHotAvg:     { type: Sequelize.DECIMAL(5, 1), allowNull: true },
        leftHotGrade:   { type: Sequelize.ENUM(...GRADES), allowNull: true },
        rightColdAvg:   { type: Sequelize.DECIMAL(5, 1), allowNull: true },
        rightColdGrade: { type: Sequelize.ENUM(...GRADES), allowNull: true },
        leftColdAvg:    { type: Sequelize.DECIMAL(5, 1), allowNull: true },
        leftColdGrade:  { type: Sequelize.ENUM(...GRADES), allowNull: true },
        rightMonoTested:    { type: Sequelize.INTEGER, allowNull: true },
        rightMonoInsensate: { type: Sequelize.INTEGER, allowNull: true },
        leftMonoTested:     { type: Sequelize.INTEGER, allowNull: true },
        leftMonoInsensate:  { type: Sequelize.INTEGER, allowNull: true },

        remarks:       { type: Sequelize.TEXT, allowNull: true },
        impression:    { type: Sequelize.TEXT, allowNull: true },
        completedAt:   { type: Sequelize.DATE, allowNull: true },
        cancelledAt:   { type: Sequelize.DATE, allowNull: true },
        cancelReason:  { type: Sequelize.STRING, allowNull: true },

        createdAt:     { type: Sequelize.DATE, allowNull: false },
        updatedAt:     { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex(STUDIES, ['PatientId'],  { name: 'neuropathy_studies_patient_id' });
      await queryInterface.addIndex(STUDIES, ['studyDate'],  { name: 'neuropathy_studies_study_date' });
      await queryInterface.addIndex(STUDIES, ['status'],     { name: 'neuropathy_studies_status' });
    }

    if (!(await tableExists(queryInterface, READINGS))) {
      await queryInterface.createTable(READINGS, {
        id:                { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        NeuropathyStudyId: { type: Sequelize.INTEGER, allowNull: false, references: { model: STUDIES, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        foot:              { type: Sequelize.ENUM(...FEET), allowNull: false },
        site:              { type: Sequelize.ENUM(...SITES), allowNull: false },
        modality:          { type: Sequelize.ENUM(...MODALITIES), allowNull: false },
        value:             { type: Sequelize.DECIMAL(5, 1), allowNull: true },
        omitted:           { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        createdAt:         { type: Sequelize.DATE, allowNull: false },
        updatedAt:         { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex(READINGS, ['NeuropathyStudyId', 'foot', 'site', 'modality'], { unique: true, name: 'unique_neuropathy_reading' });
    }
  },

  async down(queryInterface) {
    // Children first — READINGS cascades from STUDIES but drop explicitly for clarity.
    if (await tableExists(queryInterface, READINGS)) await queryInterface.dropTable(READINGS);
    if (await tableExists(queryInterface, STUDIES))  await queryInterface.dropTable(STUDIES);
  },
};
