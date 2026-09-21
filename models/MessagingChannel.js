const { defineModel, DataTypes } = require('../utils/defineModel');

// ---------------------------------------------------------------------------
// MessagingChannel — one clinic messaging endpoint. Today a WhatsApp number
// (its Meta phone_number_id); later a Facebook page or Instagram account. The
// data model is channel-generic so Messenger/Instagram can be added without a
// reshape (B18). The webhook routes an inbound message to a channel by its
// externalId (the phone_number_id in the payload metadata), so externalId is
// UNIQUE and indexed.
//
// A number's credentials are NOT here — those are in Settings (utils/commsConfig,
// encrypted). This row is the routable identity + display + live quality/health.
// ---------------------------------------------------------------------------

const MessagingChannel = defineModel('MessagingChannel', {
  channel: {
    type: DataTypes.ENUM('whatsapp', 'messenger', 'instagram'),
    allowNull: false,
    defaultValue: 'whatsapp',
  },
  externalId: {                        // phone_number_id (WhatsApp) / page id
    type: DataTypes.STRING,
    allowNull: false,
  },
  displayPhone: { type: DataTypes.STRING, allowNull: true },   // "+254 7XX XXX XXX"
  label:        { type: DataTypes.STRING, allowNull: true },   // "Main line", "Appointments"
  wabaId:       { type: DataTypes.STRING, allowNull: true },
  isActive:     { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  qualityRating:  { type: DataTypes.STRING, allowNull: true }, // GREEN / YELLOW / RED (Meta)
  lastInboundAt:  { type: DataTypes.DATE, allowNull: true },
  lastOutboundAt: { type: DataTypes.DATE, allowNull: true },
}, {
  indexes: [
    { unique: true, fields: ['externalId'], name: 'unique_messaging_channel_external' },
    { fields: ['channel'], name: 'messaging_channel_channel' },
  ],
});

module.exports = MessagingChannel;
