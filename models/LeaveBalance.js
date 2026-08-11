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
}, {
  indexes: [
    // One entitlement row per person per type per year. Without this a second
    // row would silently double someone's allowance.
    {
      unique: true,
      fields: ['UserId', 'year', 'leaveType'],
      name: 'unique_leave_balance_user_year_type',
    },
  ],
});

module.exports = LeaveBalance;
