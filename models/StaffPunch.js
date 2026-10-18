const { defineModel, DataTypes } = require('../utils/defineModel');

// Every punch, kept as it arrived (HR Suite, 17 Oct 2026): an NFC tap, a
// fingerprint or card punch from the scanner relay, or a time HR entered by
// hand. A person's day — one StaffAttendance row — is rebuilt from their
// applied punches (utils/punchDay.js): first is the check-in, then out, in,
// out… Never destroyed.
//
// outcome:
//   pending        received from the relay, not yet processed
//   applied        belongs to UserId's clinicDate and feeds that day
//   unlinked       the scanner user is not linked to anyone yet — applied
//                  the moment HR links them
//   before_golive  earlier than the scanner's go-live — kept, never counted
//   implausible    dated in the future — the scanner's clock; HR checks it
//   ignored        the scanner user is marked ignored (former staff)
//   voided         HR voided the session it belonged to — never counted again
//                  (restored to applied if HR un-voids it)
// direction: 'in' / 'out' when it counts in its day, null when not (a second
// brush within the debounce, or not applied).
//
// Association-injected: UserId, attendanceId, scannerId, tagId, deviceId,
// createdById (models/index.js). The (scannerId, scannerUserNo, at) unique
// index — what makes a re-sent punch harmless — lives in the migration.
const StaffPunch = defineModel('StaffPunch', {
  at: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  clinicDate: {
    type: DataTypes.DATEONLY,
    allowNull: true,
    defaultValue: null,
  },
  source: {
    type: DataTypes.ENUM('nfc', 'fingerprint', 'card', 'manual'),
    allowNull: false,
  },
  outcome: {
    type: DataTypes.ENUM('pending', 'applied', 'unlinked', 'before_golive', 'implausible', 'ignored', 'voided'),
    allowNull: false,
    defaultValue: 'pending',
  },
  direction: {
    type: DataTypes.ENUM('in', 'out'),
    allowNull: true,
    defaultValue: null,
  },
  // Scanner punches: the user number on the scanner and its verify code.
  scannerUserNo: { type: DataTypes.STRING(24), allowNull: true, defaultValue: null },
  verifyCode:    { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },
  // NFC punches: where the tap came from (logged, never enforced).
  ip:  { type: DataTypes.STRING(45), allowNull: true, defaultValue: null },
  lat: { type: DataTypes.DECIMAL(9, 6), allowNull: true, defaultValue: null },
  lng: { type: DataTypes.DECIMAL(9, 6), allowNull: true, defaultValue: null },
  diagnostics: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
});

module.exports = StaffPunch;
