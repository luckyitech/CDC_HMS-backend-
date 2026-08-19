const { defineModel, DataTypes } = require('../utils/defineModel');

// One row per nodule. PatientId denormalised for merge-aware longitudinal reads.
// FKs (ThyroidUltrasoundId, PatientId) come from models/index.js.
const ThyroidNodule = defineModel('ThyroidNodule', {
  noduleNumber: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  status:       { type: DataTypes.ENUM('active', 'deleted'), allowNull: false, defaultValue: 'active' },

  lobe: { type: DataTypes.ENUM('right', 'left', 'isthmus'), defaultValue: null },
  pole: { type: DataTypes.ENUM('upper', 'mid', 'lower'), defaultValue: null },
  capsularRelationship:      { type: DataTypes.ENUM('none_documented', 'abutting_capsule', 'abnormal_capsule', 'other'), defaultValue: null },
  capsularRelationshipOther: { type: DataTypes.STRING, defaultValue: null },

  dimensionsUnavailable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  length: { type: DataTypes.DECIMAL(4, 2), defaultValue: null },
  height: { type: DataTypes.DECIMAL(4, 2), defaultValue: null },
  width:  { type: DataTypes.DECIMAL(4, 2), defaultValue: null },
  volume: { type: DataTypes.DECIMAL(6, 2), defaultValue: null },

  composition:      { type: DataTypes.ENUM('cystic', 'spongiform', 'predominantly_cystic', 'mixed_cystic_solid', 'predominantly_solid', 'solid', 'other', 'not_assessed'), defaultValue: null },
  compositionOther: { type: DataTypes.STRING, defaultValue: null },
  echogenicity:     { type: DataTypes.ENUM('anechoic', 'isoechoic', 'hyperechoic', 'hypoechoic', 'very_hypoechoic', 'heterogeneous', 'not_assessed'), defaultValue: null },
  shape:            { type: DataTypes.ENUM('wider_than_tall', 'taller_than_wide', 'not_assessed'), defaultValue: null },
  margins:          { type: DataTypes.ENUM('smooth', 'ill_defined', 'lobulated', 'irregular', 'extrathyroidal_extension', 'not_assessed'), defaultValue: null },
  vascularity:      { type: DataTypes.ENUM('minimal', 'peripheral', 'internal', 'predominantly_peripheral_with_internal', 'diffuse_internal_and_peripheral', 'marked', 'not_assessed'), defaultValue: null },

  fociStatus:             { type: DataTypes.ENUM('none', 'present', 'not_assessed'), defaultValue: null },
  fociPunctate:           { type: DataTypes.BOOLEAN, defaultValue: false },
  fociMacrocalcification: { type: DataTypes.BOOLEAN, defaultValue: false },
  fociRim:                { type: DataTypes.BOOLEAN, defaultValue: false },
  fociInterruptedRim:     { type: DataTypes.BOOLEAN, defaultValue: false },
  fociCometTail:          { type: DataTypes.BOOLEAN, defaultValue: false },
  fociOther:              { type: DataTypes.BOOLEAN, defaultValue: false },
  fociOtherText:          { type: DataTypes.STRING, defaultValue: null },
  calcificationLocation:  { type: DataTypes.ENUM('central', 'peripheral', 'capsular', 'diffuse', 'na'), defaultValue: null },

  additionalFeatures:      { type: DataTypes.JSON, defaultValue: null },
  additionalFeaturesOther: { type: DataTypes.STRING, defaultValue: null },

  tiradsPoints:       { type: DataTypes.INTEGER, defaultValue: null },
  tiradsCategory:     { type: DataTypes.ENUM('TR1', 'TR2', 'TR3', 'TR4', 'TR5'), defaultValue: null },
  tiradsInsufficient: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  tiradsFinal:        { type: DataTypes.ENUM('TR1', 'TR2', 'TR3', 'TR4', 'TR5'), defaultValue: null },   // reporter's confirmed/overridden TR
  tiradsBreakdown:    { type: DataTypes.JSON, defaultValue: null },
  meetsFnaThreshold:      { type: DataTypes.BOOLEAN, defaultValue: false },
  meetsFollowUpThreshold: { type: DataTypes.BOOLEAN, defaultValue: false },

  btaSuggested: { type: DataTypes.ENUM('U1', 'U2', 'U3', 'U4', 'U5'), defaultValue: null },
  btaCategory:  { type: DataTypes.ENUM('U1', 'U2', 'U3', 'U4', 'U5'), defaultValue: null },
  btaRationale: { type: DataTypes.TEXT, defaultValue: null },
  btaFeatures:  { type: DataTypes.JSON, defaultValue: null },   // [{ code, text }] ticked BTA descriptors

  ablationPlanning: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  cysticLength: { type: DataTypes.DECIMAL(4, 2), defaultValue: null },
  cysticHeight: { type: DataTypes.DECIMAL(4, 2), defaultValue: null },
  cysticWidth:  { type: DataTypes.DECIMAL(4, 2), defaultValue: null },
  cysticVolume: { type: DataTypes.DECIMAL(6, 2), defaultValue: null },
  cysticPercentEstimate: { type: DataTypes.DECIMAL(5, 1), defaultValue: null },
  viableSolidOnDoppler:  { type: DataTypes.ENUM('yes', 'no', 'not_assessed'), defaultValue: null },

  previousCytology:       { type: DataTypes.ENUM('none', 'bethesda_1', 'bethesda_2', 'bethesda_3', 'bethesda_4', 'bethesda_5', 'bethesda_6', 'other', 'unknown'), defaultValue: null },
  previousCytologyDetail: { type: DataTypes.STRING, defaultValue: null },
  previousBiopsy:         { type: DataTypes.TEXT, defaultValue: null },
  previousAblation:       { type: DataTypes.TEXT, defaultValue: null },
  clinicalComment:        { type: DataTypes.TEXT, defaultValue: null },
  managementImplications: { type: DataTypes.TEXT, defaultValue: null },

  follicularIndicated: { type: DataTypes.ENUM('not_indicated', 'indicated'), allowNull: false, defaultValue: 'not_indicated' },
});

module.exports = ThyroidNodule;
