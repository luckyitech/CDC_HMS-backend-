const { defineModel, DataTypes } = require('../utils/defineModel');
const R = require('../utils/histologyRules');

// A histology or cytology request and, later, its typed result (Dermatology
// Phase 3, migration 20260928000023; decisions D11, H1–H7). General — not a
// dermatology table: the specimen may come from a skin finding
// (DermFindingId), a thyroid nodule (lobe / nodule label / TI-RADS), a lymph
// node or any other site.
//
// PatientId is the canonical patient when requested; reads go across the
// merge family. LabTestId is the Pending lab request raised with it, so the
// lab and billing see it as any other (H3). The result is typed by the doctor
// (H4); the report PDF is an ordinary MedicalDocument (reportDocumentId).
// Nothing is deleted: a request is cancelled with a reason, a result is
// corrected with a reason, and both are kept in HistologyEdits (H5).
const HistologyRequest = defineModel('HistologyRequest', {
  // PatientId — Patient.hasMany(HistologyRequest)
  specimenNumber:   { type: DataTypes.STRING(20), allowNull: false },
  kind:             { type: DataTypes.ENUM(...R.KINDS), allowNull: false },
  siteType:         { type: DataTypes.ENUM(...R.SITE_TYPES), allowNull: false },
  DermFindingId:    { type: DataTypes.INTEGER, allowNull: true },
  thyroidLobe:      { type: DataTypes.ENUM(...R.LOBES), allowNull: true },
  noduleLabel:      { type: DataTypes.STRING(80), allowNull: true },
  tirads:           { type: DataTypes.ENUM(...R.TIRADS), allowNull: true },
  siteText:         { type: DataTypes.STRING(200), allowNull: true },
  specimenType:     { type: DataTypes.ENUM(...R.SPECIMEN_TYPES), allowNull: false },
  pieces:           { type: DataTypes.INTEGER, allowNull: true },
  fixative:         { type: DataTypes.ENUM(...R.FIXATIVES), allowNull: true },
  clinicalDetails:  { type: DataTypes.TEXT, allowNull: false },
  sendTo:           { type: DataTypes.STRING(150), allowNull: true },
  visitDate:        { type: DataTypes.DATEONLY, allowNull: false },
  LabTestId:        { type: DataTypes.INTEGER, allowNull: true },
  requestedById:    { type: DataTypes.INTEGER, allowNull: true },
  status:           { type: DataTypes.ENUM(...R.STATUSES), allowNull: false, defaultValue: 'awaiting' },
  // Result (H4)
  resultDiagnosis:  { type: DataTypes.TEXT, allowNull: true },
  margins:          { type: DataTypes.ENUM(...R.MARGINS), allowNull: true },
  marginMm:         { type: DataTypes.DECIMAL(5, 1), allowNull: true },
  bethesda:         { type: DataTypes.ENUM(...R.BETHESDA), allowNull: true },
  cytologyCategory: { type: DataTypes.ENUM(...R.CYTO_CATEGORIES), allowNull: true },
  resultComment:    { type: DataTypes.TEXT, allowNull: true },
  reportDate:       { type: DataTypes.DATEONLY, allowNull: true },
  reportDocumentId: { type: DataTypes.INTEGER, allowNull: true },
  resultById:       { type: DataTypes.INTEGER, allowNull: true },
  resultAt:         { type: DataTypes.DATE, allowNull: true },
  // Cancelled (H5)
  cancelReason:     { type: DataTypes.STRING(500), allowNull: true },
  cancelledById:    { type: DataTypes.INTEGER, allowNull: true },
  cancelledAt:      { type: DataTypes.DATE, allowNull: true },
}, {
  indexes: [
    { unique: true, fields: ['specimenNumber'], name: 'unique_histology_specimen' },
    { fields: ['PatientId', 'visitDate'], name: 'idx_histology_patient' },
    { fields: ['DermFindingId'], name: 'idx_histology_finding' },
    { fields: ['status', 'visitDate'], name: 'idx_histology_status' },
  ],
});

module.exports = HistologyRequest;
