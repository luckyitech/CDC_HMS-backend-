const { defineModel, DataTypes } = require('../utils/defineModel');

// Entitlement per staff member, per year, per leave type.
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
    type: DataTypes.ENUM(
      'Annual', 'Sick', 'Maternity', 'Paternity', 'Compassionate', 'Study', 'Unpaid'
    ),
    allowNull: false,
  },
  entitled: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  carriedOver: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
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
