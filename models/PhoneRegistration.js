const { defineModel, DataTypes } = require('../utils/defineModel');

// A one-time code HR issues to register a member of staff's check-in phone
// (17 Oct 2026, Emu: only HR with "Register phones" can register one). The
// phone enters it on the tap page; only the SHA-256 is kept. Works once, for
// 10 minutes; a newer code for the same person ends this one.
// Migration 20260928000039.
//
// Association-injected: UserId (whose phone), issuedById, deviceId.
const PhoneRegistration = defineModel('PhoneRegistration', {
  codeHash:  { type: DataTypes.STRING(64), allowNull: false, unique: true },
  expiresAt: { type: DataTypes.DATE, allowNull: false },
  usedAt:    { type: DataTypes.DATE, allowNull: true, defaultValue: null },
});

module.exports = PhoneRegistration;
