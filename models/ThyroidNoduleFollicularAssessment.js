const { defineModel, DataTypes } = require('../utils/defineModel');

// 1:1 with a nodule. Present only when the follicular layer is indicated.
// FK (ThyroidNoduleId) comes from models/index.js.
const ThyroidNoduleFollicularAssessment = defineModel('ThyroidNoduleFollicularAssessment', {
  echotexture:       { type: DataTypes.ENUM('homogeneous', 'mildly_heterogeneous', 'markedly_heterogeneous', 'nodule_in_nodule', 'other'), defaultValue: null },
  halo:              { type: DataTypes.ENUM('absent', 'thin_complete', 'thick_complete', 'thick_irregular', 'interrupted', 'nodular_irregular'), defaultValue: null },
  capsularInterface: { type: DataTypes.ENUM('smooth_intact', 'focally_irregular', 'focally_interrupted', 'indeterminate', 'suspicious_extracapsular_extension'), defaultValue: null },
  capsule:           { type: DataTypes.ENUM('intact', 'irregular', 'interrupted', 'not_visualised'), defaultValue: null },

  focalCapsularAbnormality: { type: DataTypes.ENUM('none', 'present'), defaultValue: null },
  focalPole:     { type: DataTypes.ENUM('upper', 'mid', 'lower'), defaultValue: null },
  focalAspect:   { type: DataTypes.ENUM('anterior', 'posterior'), defaultValue: null },
  focalSide:     { type: DataTypes.ENUM('medial', 'lateral'), defaultValue: null },
  focalLengthMm: { type: DataTypes.DECIMAL(5, 1), defaultValue: null },

  satelliteNodule:         { type: DataTypes.ENUM('absent', 'present'), defaultValue: null },
  satelliteCount:          { type: DataTypes.INTEGER, defaultValue: null },
  satelliteLocation:       { type: DataTypes.STRING, defaultValue: null },
  satelliteSize:           { type: DataTypes.STRING, defaultValue: null },
  satelliteRelationship:   { type: DataTypes.STRING, defaultValue: null },
  satelliteSeparateCapsule:{ type: DataTypes.ENUM('yes', 'no', 'unknown'), defaultValue: null },

  tubercleInNodule:     { type: DataTypes.ENUM('absent', 'present'), defaultValue: null },
  tubercleSize:         { type: DataTypes.STRING, defaultValue: null },
  tubercleEchogenicity: { type: DataTypes.STRING, defaultValue: null },
  tubercleVascularity:  { type: DataTypes.STRING, defaultValue: null },
  tubercleRelationship: { type: DataTypes.STRING, defaultValue: null },

  vascularDistribution: { type: DataTypes.ENUM('predominantly_peripheral', 'predominantly_internal', 'mixed', 'diffuse'), defaultValue: null },
  vascularPattern:      { type: DataTypes.ENUM('organised', 'disorganised', 'indeterminate'), defaultValue: null },
  capsularVascularity:  { type: DataTypes.ENUM('normal_circumferential', 'focally_increased', 'abnormal_vessels_crossing_capsule', 'not_assessed'), defaultValue: null },

  invasiveFeatures: { type: DataTypes.JSON, defaultValue: null },
  invasiveOther:    { type: DataTypes.STRING, defaultValue: null },

  sonographicConcern: { type: DataTypes.ENUM('low', 'intermediate', 'high', 'incomplete'), defaultValue: null },
  concernFeatures:    { type: DataTypes.JSON, defaultValue: null },
  clinicianComment:   { type: DataTypes.TEXT, defaultValue: null },
});

module.exports = ThyroidNoduleFollicularAssessment;
