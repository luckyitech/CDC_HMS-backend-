const { defineModel, DataTypes } = require('../utils/defineModel');

// A clinical skin photo, attached to ONE finding — or, since …027, to body
// areas only (DermFindingId null, an "area photo"; PatientId = the canonical
// patient, set on every photo) (Dermatology Phase 2,
// migration 20260928000022). The file is in private/derm-photos/ under a
// random name (fileName), stored as a JPEG with its metadata stripped
// (utils/dermPhotoStorage). `marker` is the doctor's ellipse (JSON TEXT, 0…1
// picture coordinates) showing which mark is the finding — never a size.
// The areas it shows are DermPhotoRegions (…026; none = overview).
// `sensitive` is set at upload — from the photo's own areas when it has any,
// otherwise from any of the finding's regions (groin, buttocks):
// the screen blurs it until opened. Every opening is a DermPhotoView row.
// Never hard-deleted: entered_in_error hides it and keeps the file.
const DermPhoto = defineModel('DermPhoto', {
  DermObservationId: { type: DataTypes.INTEGER, allowNull: true },
  // Set when the photo came from a phone (DermCaptureSessions, …027).
  captureSessionId: { type: DataTypes.INTEGER, allowNull: true },
  visitDate:    { type: DataTypes.DATEONLY, allowNull: false },
  photoType:    { type: DataTypes.ENUM('overview', 'close_up', 'dermoscopy'), allowNull: false, defaultValue: 'close_up' },
  fileName:     { type: DataTypes.STRING(80), allowNull: false },
  sizeBytes:    { type: DataTypes.INTEGER, allowNull: true },
  width:        { type: DataTypes.INTEGER, allowNull: true },
  height:       { type: DataTypes.INTEGER, allowNull: true },
  marker:       { type: DataTypes.STRING(200), allowNull: true },
  sensitive:    { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  uploadedById: { type: DataTypes.INTEGER, allowNull: true },
  status:       { type: DataTypes.ENUM('active', 'entered_in_error'), allowNull: false, defaultValue: 'active' },
  errorReason:  { type: DataTypes.STRING(500), allowNull: true },
  errorById:    { type: DataTypes.INTEGER, allowNull: true },
  errorAt:      { type: DataTypes.DATE, allowNull: true },
}, {
  indexes: [{ name: 'idx_derm_photo_finding', fields: ['DermFindingId', 'visitDate'] }],
});

module.exports = DermPhoto;
