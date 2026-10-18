const { defineModel, DataTypes } = require('../utils/defineModel');

// One user enrolled on a scanner — its user number and the name typed on the
// scanner — and, once HR confirms it, the member of staff it belongs to.
// The relay sends numbers and names only; fingerprints never leave the
// scanner.
//
// Staff are enrolled with the number part of their HMS staff ID (EMP005 → 5,
// Emu 17 Oct 2026), so the HMS can propose the match; HR confirms it with one
// click. Punches count only for a linked user.
//
// Association-injected: scannerId, UserId, linkedById (models/index.js).
// The (scannerId, userNo) unique index lives in the migration.
const HrScannerUser = defineModel('HrScannerUser', {
  userNo: {
    type: DataTypes.STRING(24),
    allowNull: false,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  // unlinked — waiting for HR; linked — punches count for UserId;
  // ignored — a former member of staff or a test account, never counted.
  status: {
    type: DataTypes.ENUM('unlinked', 'linked', 'ignored'),
    allowNull: false,
    defaultValue: 'unlinked',
  },
  linkedAt:    { type: DataTypes.DATE, allowNull: true, defaultValue: null },
  lastPunchAt: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
  // false once the relay's user list no longer contains this number.
  onScanner:   { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
});

module.exports = HrScannerUser;
