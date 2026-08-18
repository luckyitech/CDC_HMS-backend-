const { defineModel, DataTypes } = require('../utils/defineModel');

// One row per thyroid ultrasound examination/report. Authored in the Radiology
// workspace by a reporting tech or doctor; signing freezes reportSnapshot.
// Association FKs (PatientId, reportedById, signedById, …) come from models/index.js.
const ThyroidUltrasound = defineModel('ThyroidUltrasound', {
  reportNumber: { type: DataTypes.STRING, allowNull: false },
  studyType:    { type: DataTypes.ENUM('full', 'focused'), allowNull: false, defaultValue: 'full' },
  examDate:     { type: DataTypes.DATEONLY, defaultValue: null },
  referringClinician: { type: DataTypes.STRING, defaultValue: 'Self-referral' },

  status:            { type: DataTypes.ENUM('draft', 'signed', 'deleted'), allowNull: false, defaultValue: 'draft' },
  signedAt:          { type: DataTypes.DATE, defaultValue: null },
  signedName:        { type: DataTypes.STRING, defaultValue: null },
  signedDesignation: { type: DataTypes.STRING, defaultValue: null },
  signedLicence:     { type: DataTypes.STRING, defaultValue: null },
  firstSignedAt:     { type: DataTypes.DATE, defaultValue: null },
  reopenedAt:        { type: DataTypes.DATE, defaultValue: null },
  deletedAt:         { type: DataTypes.DATE, defaultValue: null },
  deleteReason:      { type: DataTypes.TEXT, defaultValue: null },

  indications:     { type: DataTypes.JSON, defaultValue: null },
  indicationOther: { type: DataTypes.TEXT, defaultValue: null },

  tsh:     { type: DataTypes.DECIMAL(8, 2), defaultValue: null },
  ft4:     { type: DataTypes.DECIMAL(8, 2), defaultValue: null },
  ft3:     { type: DataTypes.DECIMAL(8, 2), defaultValue: null },
  antiTpo: { type: DataTypes.DECIMAL(8, 2), defaultValue: null },
  previousCytology:         { type: DataTypes.TEXT, defaultValue: null },
  previousUltrasound:       { type: DataTypes.TEXT, defaultValue: null },
  previousAblation:         { type: DataTypes.TEXT, defaultValue: null },
  currentThyroidMedication: { type: DataTypes.TEXT, defaultValue: null },

  glandSize:        { type: DataTypes.ENUM('normal', 'enlarged', 'small', 'not_assessed'), defaultValue: null },
  echotexture:      { type: DataTypes.ENUM('homogeneous', 'heterogeneous', 'diffusely_hypoechoic', 'other'), defaultValue: null },
  echotextureOther: { type: DataTypes.STRING, defaultValue: null },
  echogenicity:     { type: DataTypes.ENUM('isoechoic', 'hypoechoic', 'hyperechoic', 'other'), defaultValue: null },
  echogenicityOther:{ type: DataTypes.STRING, defaultValue: null },
  pseudonodular:    { type: DataTypes.BOOLEAN, defaultValue: null },
  vascularity:      { type: DataTypes.ENUM('normal', 'mildly_increased', 'increased', 'markedly_increased', 'reduced', 'not_assessed'), defaultValue: null },
  doppler:          { type: DataTypes.ENUM('normal', 'peripheral', 'internal', 'diffuse_internal_and_peripheral', 'other'), defaultValue: null },
  dopplerOther:     { type: DataTypes.STRING, defaultValue: null },
  retrosternalExtension: { type: DataTypes.ENUM('none', 'mild', 'moderate', 'marked'), defaultValue: null },
  subclavicularExtension:{ type: DataTypes.ENUM('none', 'present'), defaultValue: null },
  trachealDeviation:     { type: DataTypes.ENUM('none', 'present'), defaultValue: null },
  carotidDisplacement:   { type: DataTypes.ENUM('none', 'present'), defaultValue: null },
  isthmusAppearance:     { type: DataTypes.ENUM('normal', 'thickened', 'atrophic', 'not_assessable'), defaultValue: null },
  otherDiffuseAbnormalities: { type: DataTypes.TEXT, defaultValue: null },

  rightLength: { type: DataTypes.DECIMAL(5, 2), defaultValue: null },
  rightHeight: { type: DataTypes.DECIMAL(5, 2), defaultValue: null },
  rightWidth:  { type: DataTypes.DECIMAL(5, 2), defaultValue: null },
  rightVolume: { type: DataTypes.DECIMAL(6, 2), defaultValue: null },
  rightVolumeSource: { type: DataTypes.ENUM('calculated', 'entered'), defaultValue: 'calculated' },
  leftLength:  { type: DataTypes.DECIMAL(5, 2), defaultValue: null },
  leftHeight:  { type: DataTypes.DECIMAL(5, 2), defaultValue: null },
  leftWidth:   { type: DataTypes.DECIMAL(5, 2), defaultValue: null },
  leftVolume:  { type: DataTypes.DECIMAL(6, 2), defaultValue: null },
  leftVolumeSource: { type: DataTypes.ENUM('calculated', 'entered'), defaultValue: 'calculated' },
  isthmusThickness: { type: DataTypes.DECIMAL(5, 2), defaultValue: null },
  totalVolume:      { type: DataTypes.DECIMAL(6, 2), defaultValue: null },

  noNodules:           { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  lymphNodeAssessment: { type: DataTypes.ENUM('normal', 'suspicious', 'not_assessed'), defaultValue: null },
  lymphNodes:          { type: DataTypes.JSON, defaultValue: null },

  technique:         { type: DataTypes.TEXT, defaultValue: null },
  equipment:         { type: DataTypes.STRING, defaultValue: null },
  conclusion:        { type: DataTypes.JSON, defaultValue: null },
  plan:              { type: DataTypes.JSON, defaultValue: null },
  planOther:         { type: DataTypes.TEXT, defaultValue: null },
  findingsNarrative: { type: DataTypes.TEXT, defaultValue: null },
  reportSnapshot:    { type: DataTypes.JSON, defaultValue: null },

  tiradsVersion:     { type: DataTypes.STRING, defaultValue: null },
  btaVersion:        { type: DataTypes.STRING, defaultValue: null },
  follicularVersion: { type: DataTypes.STRING, defaultValue: null },
  narrativeVersion:  { type: DataTypes.STRING, defaultValue: null },

  ablationWarningAcknowledgedAt: { type: DataTypes.DATE, defaultValue: null },
});

module.exports = ThyroidUltrasound;
