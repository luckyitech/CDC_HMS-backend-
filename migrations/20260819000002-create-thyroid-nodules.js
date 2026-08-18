'use strict';

/**
 * ThyroidNodules — one row per nodule on a report. Unlimited nodules, added
 * one at a time. PatientId is denormalised for merge-aware longitudinal queries.
 * Computed ACR TI-RADS and the confirmed BTA U are stored on the row; the
 * echogenic foci are additive booleans (ACR sums them) so "none + macro" cannot
 * be entered. Soft-delete via `status`.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.map((t) => t.toLowerCase()).includes('thyroidnodules')) return;

    const S = Sequelize;
    await queryInterface.createTable('ThyroidNodules', {
      id:                 { type: S.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      ThyroidUltrasoundId:{ type: S.INTEGER, allowNull: false, references: { model: 'ThyroidUltrasounds', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      PatientId:          { type: S.INTEGER, allowNull: false, references: { model: 'Patients', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      noduleNumber:       { type: S.INTEGER, allowNull: false, defaultValue: 1 },
      status:             { type: S.ENUM('active', 'deleted'), allowNull: false, defaultValue: 'active' },

      // ----- location -----
      lobe:  { type: S.ENUM('right', 'left', 'isthmus'), defaultValue: null },
      pole:  { type: S.ENUM('upper', 'mid', 'lower'), defaultValue: null },
      capsularRelationship:      { type: S.ENUM('none_documented', 'abutting_capsule', 'abnormal_capsule', 'other'), defaultValue: null },
      capsularRelationshipOther: { type: S.STRING, defaultValue: null },

      // ----- size -----
      dimensionsUnavailable: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      length: { type: S.DECIMAL(4, 2), defaultValue: null },
      height: { type: S.DECIMAL(4, 2), defaultValue: null },
      width:  { type: S.DECIMAL(4, 2), defaultValue: null },
      volume: { type: S.DECIMAL(6, 2), defaultValue: null },

      // ----- descriptors -----
      composition:  { type: S.ENUM('cystic', 'spongiform', 'predominantly_cystic', 'mixed_cystic_solid', 'predominantly_solid', 'solid', 'other', 'not_assessed'), defaultValue: null },
      compositionOther: { type: S.STRING, defaultValue: null },
      echogenicity: { type: S.ENUM('anechoic', 'isoechoic', 'hyperechoic', 'hypoechoic', 'very_hypoechoic', 'heterogeneous', 'not_assessed'), defaultValue: null },
      shape:        { type: S.ENUM('wider_than_tall', 'taller_than_wide', 'not_assessed'), defaultValue: null },
      margins:      { type: S.ENUM('smooth', 'ill_defined', 'lobulated', 'irregular', 'extrathyroidal_extension', 'not_assessed'), defaultValue: null },
      vascularity:  { type: S.ENUM('minimal', 'peripheral', 'internal', 'predominantly_peripheral_with_internal', 'diffuse_internal_and_peripheral', 'marked', 'not_assessed'), defaultValue: null },

      // ----- echogenic foci (ACR additive booleans) -----
      fociStatus:            { type: S.ENUM('none', 'present', 'not_assessed'), defaultValue: null },
      fociPunctate:          { type: S.BOOLEAN, defaultValue: false },
      fociMacrocalcification:{ type: S.BOOLEAN, defaultValue: false },
      fociRim:               { type: S.BOOLEAN, defaultValue: false },
      fociInterruptedRim:    { type: S.BOOLEAN, defaultValue: false },
      fociCometTail:         { type: S.BOOLEAN, defaultValue: false },
      fociOther:             { type: S.BOOLEAN, defaultValue: false },
      fociOtherText:         { type: S.STRING, defaultValue: null },
      calcificationLocation: { type: S.ENUM('central', 'peripheral', 'capsular', 'diffuse', 'na'), defaultValue: null },

      // ----- additional features (display only) -----
      additionalFeatures:     { type: S.JSON, defaultValue: null },
      additionalFeaturesOther:{ type: S.STRING, defaultValue: null },

      // ----- computed ACR TI-RADS (stored) -----
      tiradsPoints:       { type: S.INTEGER, defaultValue: null },
      tiradsCategory:     { type: S.ENUM('TR1', 'TR2', 'TR3', 'TR4', 'TR5'), defaultValue: null },
      tiradsInsufficient: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      tiradsBreakdown:    { type: S.JSON, defaultValue: null },
      meetsFnaThreshold:      { type: S.BOOLEAN, defaultValue: false },
      meetsFollowUpThreshold: { type: S.BOOLEAN, defaultValue: false },

      // ----- BTA U (engine suggests, clinician confirms) -----
      btaSuggested: { type: S.ENUM('U1', 'U2', 'U3', 'U4', 'U5'), defaultValue: null },
      btaCategory:  { type: S.ENUM('U1', 'U2', 'U3', 'U4', 'U5'), defaultValue: null },
      btaRationale: { type: S.TEXT, defaultValue: null },

      // ----- ablation planning -----
      ablationPlanning:      { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      cysticLength: { type: S.DECIMAL(4, 2), defaultValue: null },
      cysticHeight: { type: S.DECIMAL(4, 2), defaultValue: null },
      cysticWidth:  { type: S.DECIMAL(4, 2), defaultValue: null },
      cysticVolume: { type: S.DECIMAL(6, 2), defaultValue: null },
      cysticPercentEstimate: { type: S.DECIMAL(5, 1), defaultValue: null },
      viableSolidOnDoppler:  { type: S.ENUM('yes', 'no', 'not_assessed'), defaultValue: null },

      // ----- clinical (section D) -----
      previousCytology:       { type: S.ENUM('none', 'bethesda_1', 'bethesda_2', 'bethesda_3', 'bethesda_4', 'bethesda_5', 'bethesda_6', 'other', 'unknown'), defaultValue: null },
      previousCytologyDetail: { type: S.STRING, defaultValue: null },
      previousBiopsy:         { type: S.TEXT, defaultValue: null },
      previousAblation:       { type: S.TEXT, defaultValue: null },
      clinicalComment:        { type: S.TEXT, defaultValue: null },
      managementImplications: { type: S.TEXT, defaultValue: null },

      // ----- follicular toggle -----
      follicularIndicated: { type: S.ENUM('not_indicated', 'indicated'), allowNull: false, defaultValue: 'not_indicated' },

      createdAt: { type: S.DATE, allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP') },
      updatedAt: { type: S.DATE, allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP') },
    });

    await queryInterface.addIndex('ThyroidNodules', ['ThyroidUltrasoundId', 'status'], { name: 'idx_thyroid_nodule_report_status' });
    await queryInterface.addIndex('ThyroidNodules', ['PatientId'], { name: 'idx_thyroid_nodule_patient' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('ThyroidNodules');
  },
};
