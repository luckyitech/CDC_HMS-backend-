const { defineModel, DataTypes } = require('../utils/defineModel');

// ---------------------------------------------------------------------------
// ConversationMessage — one message in a thread. Three directions:
//   'in'       received from the far end (a patient/lab)
//   'out'      sent by the clinic to the far end (text / media / template)
//   'internal' a staff↔doctor note inside the thread, NEVER sent to the patient
//              (escalations and private annotations)
//
// externalMessageId is the Meta message id (UNIQUE → idempotent webhook
// re-delivery). Internal notes get a synthetic 'int-<uuid>' so the column stays
// unique and non-null. patientId is a SNAPSHOT of the conversation's link at the
// time the row was written, so a later re-link never rewrites history and the
// patient's Communications tab reads by patientId directly.
//
// Media is stored under private/comms/ and served ONLY through the authenticated
// /messages/:id/media route (A5 — never a static mount). Meta delivery status +
// pricing (billable/pricingCategory) arrive later as status webhooks and update
// the row in place. queryStatus/resolution* apply to inbound messages: every
// patient message is a query, completed individually with a resolution note.
// FK columns declared here; belongsTo wired in models/index.js.
// ---------------------------------------------------------------------------

const ConversationMessage = defineModel('ConversationMessage', {
  conversationId: { type: DataTypes.INTEGER, allowNull: false },
  channel:        { type: DataTypes.ENUM('whatsapp', 'messenger', 'instagram'), allowNull: false, defaultValue: 'whatsapp' },
  patientId:      { type: DataTypes.INTEGER, allowNull: true },   // snapshot at write time

  direction: { type: DataTypes.ENUM('in', 'out', 'internal'), allowNull: false },

  externalMessageId: { type: DataTypes.STRING, allowNull: false },  // wa message id, or int-<uuid>
  type: { type: DataTypes.STRING, allowNull: true },                // text / image / document / template / …
  body:    { type: DataTypes.TEXT, allowNull: true },
  caption: { type: DataTypes.TEXT, allowNull: true },

  // Media (inbound download / outbound upload), stored under private/comms/.
  mediaId:        { type: DataTypes.STRING, allowNull: true },      // Meta media id (inbound)
  mediaMime:      { type: DataTypes.STRING, allowNull: true },
  mediaFileName:  { type: DataTypes.STRING, allowNull: true },
  mediaPath:      { type: DataTypes.STRING, allowNull: true },      // private/comms/<conv>/<hex>.<ext>
  mediaSize:      { type: DataTypes.INTEGER, allowNull: true },
  mediaEncrypted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

  replyToExternalId: { type: DataTypes.STRING, allowNull: true },

  templateName:   { type: DataTypes.STRING, allowNull: true },
  templateParams: { type: DataTypes.JSON, allowNull: true },

  status: {
    type: DataTypes.ENUM('received', 'queued', 'sent', 'delivered', 'read', 'failed'),
    allowNull: false,
    defaultValue: 'received',
  },
  statusAt:     { type: DataTypes.DATE, allowNull: true },
  errorCode:    { type: DataTypes.STRING, allowNull: true },
  errorMessage: { type: DataTypes.STRING, allowNull: true },

  // Billing (from the status webhook's pricing block).
  billable:        { type: DataTypes.BOOLEAN, allowNull: true },
  pricingCategory: { type: DataTypes.STRING, allowNull: true },

  sentById:          { type: DataTypes.INTEGER, allowNull: true },   // FK Users (outbound/internal author)
  externalTimestamp: { type: DataTypes.DATE, allowNull: true },      // Meta message timestamp

  // Cross-links created by filing / booking from the thread.
  medicalDocumentId: { type: DataTypes.INTEGER, allowNull: true },
  appointmentId:     { type: DataTypes.INTEGER, allowNull: true },

  // Query lifecycle (inbound only): every patient message is a query.
  queryStatus: { type: DataTypes.ENUM('open', 'completed'), allowNull: true },
  resolutionKind: {
    type: DataTypes.ENUM('answered', 'appointment_booked', 'document_filed', 'referred', 'no_action'),
    allowNull: true,
  },
  resolutionNote: { type: DataTypes.TEXT, allowNull: true },
  resolvedById:   { type: DataTypes.INTEGER, allowNull: true },
  resolvedAt:     { type: DataTypes.DATE, allowNull: true },
  reopenedById:   { type: DataTypes.INTEGER, allowNull: true },
  reopenedAt:     { type: DataTypes.DATE, allowNull: true },
}, {
  indexes: [
    { unique: true, fields: ['externalMessageId'], name: 'unique_conv_message_external' },
    { fields: ['conversationId', 'createdAt'], name: 'conv_message_conversation' },
    { fields: ['patientId', 'createdAt'], name: 'conv_message_patient' },
    { fields: ['status'], name: 'conv_message_status' },
    { fields: ['direction', 'createdAt'], name: 'conv_message_direction' },
    { fields: ['queryStatus'], name: 'conv_message_query' },
    { fields: ['sentById'], name: 'conv_message_sent_by' },
  ],
});

module.exports = ConversationMessage;
