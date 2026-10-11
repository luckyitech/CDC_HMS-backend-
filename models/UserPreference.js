const { defineModel, DataTypes } = require('../utils/defineModel');

// One user's own setting for how the HMS looks to them (migration
// 20260928000021). First key: 'consultation.tools' — which Today's
// Consultation tools they show, in what order, and which open by themselves
// (utils/consultationTools). Only the user themselves reads or writes their
// rows (UserId from the JWT). `value` is JSON TEXT, parsed in the controller —
// display preferences, never reported on.
const UserPreference = defineModel('UserPreference', {
  key:   { type: DataTypes.STRING(80), allowNull: false },
  value: { type: DataTypes.TEXT, allowNull: false },
}, {
  indexes: [{ name: 'uq_user_preference', unique: true, fields: ['UserId', 'key'] }],
});

module.exports = UserPreference;
