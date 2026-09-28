const { defineModel, DataTypes } = require('../utils/defineModel');

// De-duplication log for expiry reminders (B27, migration 20260928000005;
// decision D12): one row per (document or licence, threshold, expiry date), so
// each 60 / 30 / 7 / 0-day reminder goes out once — and again if the expiry
// date is renewed. Written by the phase-5 daily job.
const ExpiryReminder = defineModel('ExpiryReminder', {
  kind:       { type: DataTypes.ENUM('document', 'licence'), allowNull: false },
  refId:      { type: DataTypes.INTEGER, allowNull: false },
  threshold:  { type: DataTypes.INTEGER, allowNull: false },
  expiryDate: { type: DataTypes.DATEONLY, allowNull: false },
  sentAt:     { type: DataTypes.DATE, allowNull: false },
});

module.exports = ExpiryReminder;
