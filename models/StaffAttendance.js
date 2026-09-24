const { defineModel, DataTypes } = require('../utils/defineModel');

// One row per staff attendance session — a check-in, and (usually) its
// check-out — or per REFUSED tap attempt. HR Suite (B21), Time & Attendance.
//
// This is the STAFF register. The patient Attendance Register (B19) is a
// read-only report over Queue and shares nothing with this table.
//
// Association-injected columns (see models/index.js), not declared here:
//   UserId          the member of staff (User.hasMany)
//   checkInTagId    which entrance tag was tapped to check in   (SET NULL)
//   checkOutTagId   which tag was tapped to check out           (SET NULL)
//   deviceId        the remembered phone that sent the tap      (SET NULL)
//   amendedById     HR user who last amended the row
//   createdById     who created it — self on a tap, HR on a manual entry
//
// Late/early are computed AT THE TAP and stored (expected*, *Minutes,
// *Punctuality): a later change to someone's working hours never restates a
// past month, and the monthly star counts are one indexed query.
//
// Never destroy(): a session is voided by status. Refused attempts are rows
// too (status 'refused'), so HR can see who tried what.
const StaffAttendance = defineModel('StaffAttendance', {
  // The clinic's calendar day the session belongs to (utils/clinicTime).
  clinicDate: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  checkInAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  checkOutAt: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
  },

  // How each end of the session was recorded. 'code' is reserved for a typed
  // reception fallback code (not built in phase 1 — every phone has NFC).
  checkInMethod: {
    type: DataTypes.ENUM('nfc', 'code', 'manual'),
    allowNull: false,
  },
  checkOutMethod: {
    type: DataTypes.ENUM('nfc', 'code', 'manual'),
    allowNull: true,
    defaultValue: null,
  },

  // verified — tag signature and counter checked out.
  // flagged  — valid tag, but something HR should look at (reserved for a
  //            configurable network/location rule; phase 1 never sets it).
  // refused  — the tap failed verification; the row is kept for HR.
  // manual   — entered or amended by HR.
  checkInVerification: {
    type: DataTypes.ENUM('verified', 'flagged', 'refused', 'manual'),
    allowNull: false,
  },
  checkOutVerification: {
    type: DataTypes.ENUM('verified', 'flagged', 'refused', 'manual'),
    allowNull: true,
    defaultValue: null,
  },

  // Logged, never enforced (decision 2): the clinic's public IP is dynamic.
  checkInIp:  { type: DataTypes.STRING(45), allowNull: true, defaultValue: null },
  checkOutIp: { type: DataTypes.STRING(45), allowNull: true, defaultValue: null },
  checkInLat:  { type: DataTypes.DECIMAL(9, 6), allowNull: true, defaultValue: null },
  checkInLng:  { type: DataTypes.DECIMAL(9, 6), allowNull: true, defaultValue: null },
  checkOutLat: { type: DataTypes.DECIMAL(9, 6), allowNull: true, defaultValue: null },
  checkOutLng: { type: DataTypes.DECIMAL(9, 6), allowNull: true, defaultValue: null },

  // Snapshot of the person's working hours for that day, resolved at check-in.
  // NULL when they had no expected hours (a day off, or no hours set) — then
  // no punctuality is judged and no star is earned.
  expectedInAt:  { type: DataTypes.DATE, allowNull: true, defaultValue: null },
  expectedOutAt: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
  lateMinutes:     { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },
  earlyOutMinutes: { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },

  // in:  early → gold, on_time → green, late → red.
  // out: late (past working hours) → gold, on_time → green, early → red.
  // none: no expected hours that day, or not yet checked out.
  checkInPunctuality: {
    type: DataTypes.ENUM('early', 'on_time', 'late', 'none'),
    allowNull: false,
    defaultValue: 'none',
  },
  checkOutPunctuality: {
    type: DataTypes.ENUM('early', 'on_time', 'late', 'none'),
    allowNull: false,
    defaultValue: 'none',
  },

  // open            checked in, not yet out
  // closed          checked out (by tap, or completed by HR)
  // missed_checkout open past clinic midnight, closed by the sweep — HR amends
  // refused         a tap that failed verification (never a real session)
  // voided          HR struck the row out; kept for the audit trail
  status: {
    type: DataTypes.ENUM('open', 'closed', 'missed_checkout', 'refused', 'voided'),
    allowNull: false,
    defaultValue: 'open',
  },

  amendedAt:   { type: DataTypes.DATE, allowNull: true, defaultValue: null },
  amendReason: { type: DataTypes.TEXT, allowNull: true, defaultValue: null },

  // Display-only detail: { ua, ctr, reason, geoAccuracy, sweptAt }. Read
  // through utils/jsonColumn.js parseJsonColumn — MariaDB returns a string.
  diagnostics: {
    type: DataTypes.JSON,
    allowNull: true,
    defaultValue: null,
  },
});

// The (UserId, clinicDate), (clinicDate, status) and (UserId, status) indexes
// are created by the migration, NOT declared here — UserId is injected by the
// association and sync() would try to index a column it does not yet know
// about (see models/StaffLeave.js for the incident).

module.exports = StaffAttendance;
