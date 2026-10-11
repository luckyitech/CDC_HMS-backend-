const { defineModel, DataTypes } = require('../utils/defineModel');

// One phone hand-off for skin photos (migration 20260928000027, 8 Oct 2026).
// The QR carries a random token; only its SHA-256 is stored. The first phone to
// open it is bound to it (deviceKeyHash) — any other phone is refused. It lasts
// 10 minutes and can only ADD photos: to this patient, these areas, and the
// finding being recorded (DermFindingId, set once that finding is saved).
// doctorId = the signed-in doctor who opened it (from the JWT); phone photos
// are attributed to them.
const DermCaptureSession = defineModel('DermCaptureSession', {
  tokenHash:     { type: DataTypes.CHAR(64), allowNull: false },
  deviceKeyHash: { type: DataTypes.CHAR(64), allowNull: true },
  doctorId:      { type: DataTypes.INTEGER, allowNull: true },
  purpose:       { type: DataTypes.ENUM('finding', 'photos'), allowNull: false, defaultValue: 'photos' },
  regions:       { type: DataTypes.STRING(1000), allowNull: true },
  expiresAt:     { type: DataTypes.DATE, allowNull: false },
  openedAt:      { type: DataTypes.DATE, allowNull: true },
  closedAt:      { type: DataTypes.DATE, allowNull: true },
  photoCount:    { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
}, {
  indexes: [{ name: 'uq_derm_capture_token', unique: true, fields: ['tokenHash'] }],
});

module.exports = DermCaptureSession;
