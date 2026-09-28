const { defineModel, DataTypes } = require('../utils/defineModel');

// Which balance a leave request's days come off (B27, migration
// 20260928000003; decision D7). A request may be split — 2 Sick + 3 Annual.
// The sum of a leave's ACTIVE charges equals StaffLeave.days. Balances are
// summed from these, never from StaffLeave.leaveType.
//
// A changed split marks the previous rows 'replaced' — never deleted — and a
// LeaveEvent 'charge_changed' records who and why.
//
// Association-injected: leaveId (→ StaffLeaves), setById (→ Users).
const LeaveCharge = defineModel('LeaveCharge', {
  leaveType: { type: DataTypes.STRING(40), allowNull: false },
  days:      { type: DataTypes.DECIMAL(6, 2), allowNull: false },
  status:    { type: DataTypes.ENUM('active', 'replaced'), allowNull: false, defaultValue: 'active' },
});

module.exports = LeaveCharge;
