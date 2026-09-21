const { defineModel, DataTypes } = require('../utils/defineModel');

// ---------------------------------------------------------------------------
// Conversation — one thread between the clinic and one external party on one
// channel (a WhatsApp wa_id on a clinic number). Channel-generic (B18).
//
// contactType decides who the far end is: a patient (the default), or a lab /
// organisation (contactOrgId). A patient thread carries the CANONICAL patientId
// once linked — merge-aware (A4): linking always resolves to the canonical
// record. Linking is 'auto' only on a single unique phone match; otherwise a
// human links it ('manual'), and any near-misses are kept in suggestedPatientIds
// for display. windowExpiresAt is the Meta 24 h free-form window (set from the
// last INBOUND message); after it, only templates may be sent.
//
// Counters (unreadCount, openQueryCount) are denormalised so the list and the
// sidebar badge never scan the messages table. FK columns are declared here as
// plain camelCase INTEGER columns and wired with belongsTo in models/index.js.
// ---------------------------------------------------------------------------

const Conversation = defineModel('Conversation', {
  channelId:      { type: DataTypes.INTEGER, allowNull: false },
  externalUserId: { type: DataTypes.STRING, allowNull: false },   // wa_id (2547XXXXXXXX)
  profileName:    { type: DataTypes.STRING, allowNull: true },    // WhatsApp profile name

  contactType: {
    type: DataTypes.ENUM('patient', 'lab', 'organisation'),
    allowNull: false,
    defaultValue: 'patient',
  },
  contactOrgId: { type: DataTypes.INTEGER, allowNull: true },     // FK ExternalOrganisations

  // Patient link (canonical). linkMethod records how it was made.
  patientId:  { type: DataTypes.INTEGER, allowNull: true },
  linkMethod: { type: DataTypes.ENUM('auto', 'manual'), allowNull: true },
  linkedById: { type: DataTypes.INTEGER, allowNull: true },
  linkedAt:   { type: DataTypes.DATE, allowNull: true },
  // Near-miss candidates when a unique auto-link was not possible (display only).
  suggestedPatientIds: { type: DataTypes.JSON, allowNull: true },

  assignedToId: { type: DataTypes.INTEGER, allowNull: true },

  status: {
    type: DataTypes.ENUM('open', 'closed', 'archived'),
    allowNull: false,
    defaultValue: 'open',
  },
  topic:       { type: DataTypes.STRING, allowNull: true },
  topicSource: { type: DataTypes.ENUM('auto', 'manual'), allowNull: true },

  pinnedAt:   { type: DataTypes.DATE, allowNull: true },
  pinnedById: { type: DataTypes.INTEGER, allowNull: true },

  lastInboundAt:   { type: DataTypes.DATE, allowNull: true },
  lastOutboundAt:  { type: DataTypes.DATE, allowNull: true },
  windowExpiresAt: { type: DataTypes.DATE, allowNull: true },   // 24 h free-form window

  unreadCount:    { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  openQueryCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

  lastMessageAt:      { type: DataTypes.DATE, allowNull: true },
  lastMessagePreview: { type: DataTypes.STRING(160), allowNull: true },
}, {
  indexes: [
    { unique: true, fields: ['channelId', 'externalUserId'], name: 'unique_conversation_channel_user' },
    { fields: ['patientId'], name: 'conversation_patient' },
    { fields: ['status', 'lastMessageAt'], name: 'conversation_status_last' },
    { fields: ['assignedToId'], name: 'conversation_assigned' },
    { fields: ['contactType'], name: 'conversation_contact_type' },
    { fields: ['pinnedAt'], name: 'conversation_pinned' },
  ],
});

module.exports = Conversation;
