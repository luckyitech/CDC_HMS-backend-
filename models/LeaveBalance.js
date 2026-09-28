const { defineModel, DataTypes } = require('../utils/defineModel');

// Entitlement per staff member, per year, per leave type.
//
// B27 (migration 20260928000001): this is now the PER-PERSON OVERRIDE row. The
// clinic's allowance comes from the year's LeavePolicy; a row here changes it
// for one person (D1), with a reason. entitled / carriedOver NULL = use the
// policy. weekOverride = that person's own week values (D3), e.g. a
// part-timer who works Mon–Wed. DECIMAL arrives as a string — Number() it.
//
// `taken` is NOT stored here — it is summed from approved StaffLeave rows on
// read. Storing it would mean two places could disagree, and the leave rows are
// the record of what actually happened; a cached total is only ever a summary
// of them.
//
// UserId is added by the association in index.js.
const LeaveBalance = defineModel('LeaveBalance', {
  year: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  leaveType: {
    type: DataTypes.STRING(40),   // a LeaveTypes.key
    allowNull: false,
  },
  entitled: {
    type: DataTypes.DECIMAL(6, 2),
    allowNull: true,
    defaultValue: null,
  },
  carriedOver: {
    type: DataTypes.DECIMAL(6, 2),
    allowNull: true,
    defaultValue: null,
  },
  reason: {
    type: DataTypes.TEXT,         // why this person differs from the policy
    defaultValue: null,
  },
  weekOverride: {
    type: DataTypes.JSON,         // { "0": 0, "1": 1, … "6": 0 } or null
    defaultValue: null,
  },

  // --- Accountability ---
  createdBy: { type: DataTypes.INTEGER, defaultValue: null },
  updatedBy: { type: DataTypes.INTEGER, defaultValue: null },
});

// The unique (UserId, year, leaveType) index is created by the migration, NOT
// declared here — one entitlement row per person per type per year, or a
// duplicate would silently double someone's allowance.
//
// It cannot live in an `indexes` option because UserId is injected by
// User.hasMany(LeaveBalance) in index.js rather than declared above, and
// sequelize.sync() would try to index a column it does not yet know about.
// MySQL rejects that with "Key column 'UserId' doesn't exist in table", which
// crashes the app on boot.

module.exports = LeaveBalance;
