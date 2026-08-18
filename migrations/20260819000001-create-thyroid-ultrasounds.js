'use strict';

/**
 * ThyroidUltrasounds — one row per thyroid ultrasound examination / report.
 *
 * Structured reporting tool authored in the Radiology workspace. A draft is
 * editable by its author and autosaves; signing freezes `reportSnapshot` and
 * locks the report. Everything the clinic could count is a column; JSON is used
 * only for display-only descriptor sets and the frozen snapshot.
 *
 * Either a reporting tech or a doctor may author and sign (attribution is a
 * userId from the JWT, role-agnostic). Soft-delete only, via `status`.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.map((t) => t.toLowerCase()).includes('thyroidultrasounds')) return;

    const S = Sequelize;
    await queryInterface.createTable('ThyroidUltrasounds', {
      id:            { type: S.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      reportNumber:  { type: S.STRING, allowNull: false },   // TUS-YYYY-NNNNN
      PatientId:     { type: S.INTEGER, allowNull: false, references: { model: 'Patients', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      reportedById:  { type: S.INTEGER, allowNull: true, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' }, // author from JWT
      studyType:     { type: S.ENUM('full', 'focused'), allowNull: false, defaultValue: 'full' },
      examDate:      { type: S.DATEONLY, allowNull: true },
      referringClinician: { type: S.STRING, defaultValue: 'Self-referral' },

      // ----- status / signing -----
      status:            { type: S.ENUM('draft', 'signed', 'deleted'), allowNull: false, defaultValue: 'draft' },
      signedAt:          { type: S.DATE, defaultValue: null },
      signedById:        { type: S.INTEGER, allowNull: true, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      signedName:        { type: S.STRING, defaultValue: null },
      signedDesignation: { type: S.STRING, defaultValue: null },
      signedLicence:     { type: S.STRING, defaultValue: null },
      firstSignedAt:     { type: S.DATE, defaultValue: null },
      reopenedAt:        { type: S.DATE, defaultValue: null },
      reopenedById:      { type: S.INTEGER, allowNull: true, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      deletedAt:         { type: S.DATE, defaultValue: null },
      deletedBy:         { type: S.INTEGER, allowNull: true, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      deleteReason:      { type: S.TEXT, defaultValue: null },

      // ----- indication -----
      indications:    { type: S.JSON, defaultValue: null },   // array of catalogue codes
      indicationOther: { type: S.TEXT, defaultValue: null },

      // ----- clinical data (hand-typed; labs are free-form per P4) -----
      tsh:     { type: S.DECIMAL(8, 2), defaultValue: null },
      ft4:     { type: S.DECIMAL(8, 2), defaultValue: null },
      ft3:     { type: S.DECIMAL(8, 2), defaultValue: null },
      antiTpo: { type: S.DECIMAL(8, 2), defaultValue: null },
      previousCytology:        { type: S.TEXT, defaultValue: null },
      previousUltrasound:      { type: S.TEXT, defaultValue: null },
      previousAblation:        { type: S.TEXT, defaultValue: null },
      currentThyroidMedication:{ type: S.TEXT, defaultValue: null },

      // ----- global findings -----
      glandSize:      { type: S.ENUM('normal', 'enlarged', 'small', 'not_assessed'), defaultValue: null },
      echotexture:    { type: S.ENUM('homogeneous', 'heterogeneous', 'diffusely_hypoechoic', 'other'), defaultValue: null },
      echotextureOther:  { type: S.STRING, defaultValue: null },
      echogenicity:   { type: S.ENUM('isoechoic', 'hypoechoic', 'hyperechoic', 'other'), defaultValue: null },
      echogenicityOther: { type: S.STRING, defaultValue: null },
      pseudonodular:  { type: S.BOOLEAN, defaultValue: null },
      vascularity:    { type: S.ENUM('normal', 'mildly_increased', 'increased', 'markedly_increased', 'reduced', 'not_assessed'), defaultValue: null },
      doppler:        { type: S.ENUM('normal', 'peripheral', 'internal', 'diffuse_internal_and_peripheral', 'other'), defaultValue: null },
      dopplerOther:   { type: S.STRING, defaultValue: null },
      retrosternalExtension: { type: S.ENUM('none', 'mild', 'moderate', 'marked'), defaultValue: null },
      subclavicularExtension:{ type: S.ENUM('none', 'present'), defaultValue: null },
      trachealDeviation:     { type: S.ENUM('none', 'present'), defaultValue: null },
      carotidDisplacement:   { type: S.ENUM('none', 'present'), defaultValue: null },
      isthmusAppearance:     { type: S.ENUM('normal', 'thickened', 'atrophic', 'not_assessable'), defaultValue: null },
      otherDiffuseAbnormalities: { type: S.TEXT, defaultValue: null },

      // ----- measurements (cm / mL) -----
      rightLength: { type: S.DECIMAL(5, 2), defaultValue: null },
      rightHeight: { type: S.DECIMAL(5, 2), defaultValue: null },
      rightWidth:  { type: S.DECIMAL(5, 2), defaultValue: null },
      rightVolume: { type: S.DECIMAL(6, 2), defaultValue: null },
      rightVolumeSource: { type: S.ENUM('calculated', 'entered'), defaultValue: 'calculated' },
      leftLength:  { type: S.DECIMAL(5, 2), defaultValue: null },
      leftHeight:  { type: S.DECIMAL(5, 2), defaultValue: null },
      leftWidth:   { type: S.DECIMAL(5, 2), defaultValue: null },
      leftVolume:  { type: S.DECIMAL(6, 2), defaultValue: null },
      leftVolumeSource:  { type: S.ENUM('calculated', 'entered'), defaultValue: 'calculated' },
      isthmusThickness:  { type: S.DECIMAL(5, 2), defaultValue: null },
      totalVolume:       { type: S.DECIMAL(6, 2), defaultValue: null },

      // ----- nodules / nodes -----
      noNodules:           { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      lymphNodeAssessment: { type: S.ENUM('normal', 'suspicious', 'not_assessed'), defaultValue: null },
      lymphNodes:          { type: S.JSON, defaultValue: null },   // display-only array

      // ----- technique / output -----
      technique:         { type: S.TEXT, defaultValue: null },
      equipment:         { type: S.STRING, defaultValue: null },
      conclusion:        { type: S.JSON, defaultValue: null },   // array of strings, frozen at sign
      plan:              { type: S.JSON, defaultValue: null },   // array of catalogue codes
      planOther:         { type: S.TEXT, defaultValue: null },
      findingsNarrative: { type: S.TEXT, defaultValue: null },
      reportSnapshot:    { type: S.JSON, defaultValue: null },   // full render model at signing

      // ----- engine version stamps -----
      tiradsVersion:     { type: S.STRING, defaultValue: null },
      btaVersion:        { type: S.STRING, defaultValue: null },
      follicularVersion: { type: S.STRING, defaultValue: null },
      narrativeVersion:  { type: S.STRING, defaultValue: null },

      // ----- ablation safety acknowledgement -----
      ablationWarningAcknowledgedAt:   { type: S.DATE, defaultValue: null },
      ablationWarningAcknowledgedById: { type: S.INTEGER, allowNull: true, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },

      createdAt: { type: S.DATE, allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP') },
      updatedAt: { type: S.DATE, allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP') },
    });

    await queryInterface.addIndex('ThyroidUltrasounds', ['reportNumber'], { unique: true, name: 'unique_thyroid_us_report_number' });
    await queryInterface.addIndex('ThyroidUltrasounds', ['PatientId', 'status'], { name: 'idx_thyroid_us_patient_status' });
    await queryInterface.addIndex('ThyroidUltrasounds', ['reportedById', 'createdAt'], { name: 'idx_thyroid_us_reporter_created' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('ThyroidUltrasounds');
  },
};
