const { defineModel, DataTypes } = require('../utils/defineModel');

// ---------------------------------------------------------------------------
// MessageTemplate — a cached copy of an approved Meta message template, so the
// composer can offer templates (with their placeholders) when the 24 h free-form
// window is closed, without a round-trip to Meta each time. Refreshed by the
// templates/sync endpoint and by template-status webhooks. Meta identifies a
// template by (name, language), which is the unique key here too.
// ---------------------------------------------------------------------------

const MessageTemplate = defineModel('MessageTemplate', {
  channelKey: { type: DataTypes.STRING, allowNull: false, defaultValue: 'whatsapp' },
  name:       { type: DataTypes.STRING, allowNull: false },
  language:   { type: DataTypes.STRING, allowNull: false, defaultValue: 'en' },
  category:   { type: DataTypes.STRING, allowNull: true },   // UTILITY / MARKETING / AUTHENTICATION
  status:     { type: DataTypes.STRING, allowNull: true },   // APPROVED / PENDING / REJECTED
  components: { type: DataTypes.JSON, allowNull: true },      // Meta component array (body/header/…)
  metaId:     { type: DataTypes.STRING, allowNull: true },
  syncedAt:   { type: DataTypes.DATE, allowNull: true },
}, {
  indexes: [
    { unique: true, fields: ['name', 'language'], name: 'unique_message_template_name_lang' },
  ],
});

module.exports = MessageTemplate;
