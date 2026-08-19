'use strict';

/**
 * ThyroidNoduleFollicularAssessments — 1:1 with a nodule, present only when the
 * Follicular Neoplasm Sonographic Assessment layer is indicated. Computed
 * `sonographicConcern` (LOW/INTERMEDIATE/HIGH/INCOMPLETE) and the driving
 * features are stored. The word "carcinoma" is never a stored conclusion.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.map((t) => t.toLowerCase()).includes('thyroidnodulefollicularassessments')) return;

    const S = Sequelize;
    await queryInterface.createTable('ThyroidNoduleFollicularAssessments', {
      id:              { type: S.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      ThyroidNoduleId: { type: S.INTEGER, allowNull: false, unique: true, references: { model: 'ThyroidNodules', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },

      echotexture:      { type: S.ENUM('homogeneous', 'mildly_heterogeneous', 'markedly_heterogeneous', 'nodule_in_nodule', 'other'), defaultValue: null },
      halo:             { type: S.ENUM('absent', 'thin_complete', 'thick_complete', 'thick_irregular', 'interrupted', 'nodular_irregular'), defaultValue: null },
      capsularInterface:{ type: S.ENUM('smooth_intact', 'focally_irregular', 'focally_interrupted', 'indeterminate', 'suspicious_extracapsular_extension'), defaultValue: null },
      capsule:          { type: S.ENUM('intact', 'irregular', 'interrupted', 'not_visualised'), defaultValue: null },

      // focal capsular abnormality
      focalCapsularAbnormality: { type: S.ENUM('none', 'present'), defaultValue: null },
      focalPole:      { type: S.ENUM('upper', 'mid', 'lower'), defaultValue: null },
      focalAspect:    { type: S.ENUM('anterior', 'posterior'), defaultValue: null },
      focalSide:      { type: S.ENUM('medial', 'lateral'), defaultValue: null },
      focalLengthMm:  { type: S.DECIMAL(5, 1), defaultValue: null },

      // satellite
      satelliteNodule:        { type: S.ENUM('absent', 'present'), defaultValue: null },
      satelliteCount:         { type: S.INTEGER, defaultValue: null },
      satelliteLocation:      { type: S.STRING, defaultValue: null },
      satelliteSize:          { type: S.STRING, defaultValue: null },
      satelliteRelationship:  { type: S.STRING, defaultValue: null },
      satelliteSeparateCapsule:{ type: S.ENUM('yes', 'no', 'unknown'), defaultValue: null },

      // tubercle-in-nodule
      tubercleInNodule:     { type: S.ENUM('absent', 'present'), defaultValue: null },
      tubercleSize:         { type: S.STRING, defaultValue: null },
      tubercleEchogenicity: { type: S.STRING, defaultValue: null },
      tubercleVascularity:  { type: S.STRING, defaultValue: null },
      tubercleRelationship: { type: S.STRING, defaultValue: null },

      // vascular architecture
      vascularDistribution: { type: S.ENUM('predominantly_peripheral', 'predominantly_internal', 'mixed', 'diffuse'), defaultValue: null },
      vascularPattern:      { type: S.ENUM('organised', 'disorganised', 'indeterminate'), defaultValue: null },
      capsularVascularity:  { type: S.ENUM('normal_circumferential', 'focally_increased', 'abnormal_vessels_crossing_capsule', 'not_assessed'), defaultValue: null },

      // invasion
      invasiveFeatures: { type: S.JSON, defaultValue: null },   // array of codes
      invasiveOther:    { type: S.STRING, defaultValue: null },

      // computed output
      sonographicConcern: { type: S.ENUM('low', 'intermediate', 'high', 'incomplete'), defaultValue: null },
      concernFeatures:    { type: S.JSON, defaultValue: null },
      clinicianComment:   { type: S.TEXT, defaultValue: null },

      createdAt: { type: S.DATE, allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP') },
      updatedAt: { type: S.DATE, allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP') },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('ThyroidNoduleFollicularAssessments');
  },
};
