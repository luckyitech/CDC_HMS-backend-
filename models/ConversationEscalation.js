const { defineModel, DataTypes } = require('../utils/defineModel');

// ---------------------------------------------------------------------------
// ConversationEscalation — a staff member raising a thread to a doctor. The
// escalation is an INTERNAL note (messageId points at the ConversationMessage
// of direction 'internal'); nothing is sent to the patient. firstDoctorReplyAt
// lets the Operations analytics measure how long an escalation waited. Resolved
// when the doctor (or staff) marks it done.
// ---------------------------------------------------------------------------

const ConversationEscalation = defineModel('ConversationEscalation', {
  conversationId: { type: DataTypes.INTEGER, allowNull: false },
  messageId:      { type: DataTypes.INTEGER, allowNull: true },   // the internal note
  escalatedById:  { type: DataTypes.INTEGER, allowNull: true },
  escalatedToId:  { type: DataTypes.INTEGER, allowNull: true },
  note:           { type: DataTypes.TEXT, allowNull: true },
  status:         { type: DataTypes.ENUM('open', 'resolved'), allowNull: false, defaultValue: 'open' },
  firstDoctorReplyAt: { type: DataTypes.DATE, allowNull: true },
  resolvedById:   { type: DataTypes.INTEGER, allowNull: true },
  resolvedAt:     { type: DataTypes.DATE, allowNull: true },
}, {
  indexes: [
    { fields: ['escalatedToId', 'status'], name: 'escalation_assignee_status' },
    { fields: ['conversationId'], name: 'escalation_conversation' },
  ],
});

module.exports = ConversationEscalation;
