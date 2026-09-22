const { defineModel, DataTypes } = require('../utils/defineModel');

// Generic key-value store for system-wide settings
// (e.g. which suggestion source each clinical catalog uses).
const Setting = defineModel('Setting', {
  key: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  // TEXT, not STRING: this store also holds encrypted credentials (Meta App
  // Secret, WhatsApp System User token, Facebook Page token) whose encrypted
  // form is ~2× the plaintext — a long-lived token overflows VARCHAR(255).
  // Widened by migration 20260922000003.
  value: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
});

module.exports = Setting;
