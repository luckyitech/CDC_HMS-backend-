const { defineModel, DataTypes } = require('../utils/defineModel');

// ---------------------------------------------------------------------------
// ConversationReminder — a follow-up a user sets on a thread, for themselves or
// a colleague ("remind me to check this Thursday"). Surfaced in the Reminders
// tab and the badge; there is NO background scheduler in Phase 1 (a reminder is
// due when remindAt has passed and status is 'pending'). patientId is a snapshot
// so the reminder still reads if the link later changes.
// ---------------------------------------------------------------------------

const ConversationReminder = defineModel('ConversationReminder', {
  conversationId: { type: DataTypes.INTEGER, allowNull: false },
  patientId:      { type: DataTypes.INTEGER, allowNull: true },   // snapshot
  setById:        { type: DataTypes.INTEGER, allowNull: true },
  forUserId:      { type: DataTypes.INTEGER, allowNull: true },
  remindAt:       { type: DataTypes.DATE, allowNull: false },
  note:           { type: DataTypes.STRING, allowNull: true },
  status:         { type: DataTypes.ENUM('pending', 'done', 'snoozed', 'cancelled'), allowNull: false, defaultValue: 'pending' },
  snoozedUntil:   { type: DataTypes.DATE, allowNull: true },
  doneById:       { type: DataTypes.INTEGER, allowNull: true },
  doneAt:         { type: DataTypes.DATE, allowNull: true },
}, {
  indexes: [
    { fields: ['forUserId', 'status', 'remindAt'], name: 'reminder_for_status_time' },
    { fields: ['conversationId'], name: 'reminder_conversation' },
  ],
});

module.exports = ConversationReminder;
