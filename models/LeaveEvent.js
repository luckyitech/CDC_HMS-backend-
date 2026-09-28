const { defineModel, DataTypes } = require('../utils/defineModel');

// One entry on a leave request's timeline and message thread (B27, migration
// 20260928000003). Never deleted. `data` holds structured detail (e.g. the old
// and new charge split) — read it through parseJsonColumn.
//
// Association-injected: leaveId (→ StaffLeaves), actorId (→ Users).
const EVENT_TYPES = ['submitted', 'approved', 'declined', 'info_requested', 'info_replied', 'charge_changed',
  'withdrawn', 'cancel_requested', 'cancelled', 'recorded', 'notified'];

const LeaveEvent = defineModel('LeaveEvent', {
  type: { type: DataTypes.ENUM(...EVENT_TYPES), allowNull: false },
  note: { type: DataTypes.TEXT, allowNull: true },
  data: { type: DataTypes.JSON, allowNull: true },
});

LeaveEvent.EVENT_TYPES = EVENT_TYPES;

module.exports = LeaveEvent;
