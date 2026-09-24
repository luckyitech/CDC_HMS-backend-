const { defineModel, DataTypes } = require('../utils/defineModel');

// A remembered personal phone (B21, decision 6).
//
// The tap page cannot rely on the HMS session — it is per-tab sessionStorage,
// and a URL opened from an NFC tag lands in a fresh tab, logged out. So a
// member of staff signs in ONCE on their own phone and ticks "remember this
// phone"; the phone then holds a long random token, and every later tap
// exchanges it for a normal JWT (POST /api/auth/device-session) with no login.
//
// Only the SHA-256 of the token is stored, so a copy of this table cannot be
// replayed. expiresAt rolls forward 90 days on every use; a phone unused for
// 90 days has to sign in again. Revoked from the HR dashboard ("My phones"),
// the staff file, or automatically when the account is deactivated/archived.
//
// Association-injected: UserId (User.hasMany), revokedById.
const UserDevice = defineModel('UserDevice', {
  tokenHash: {
    type: DataTypes.STRING(64),   // hex SHA-256
    allowNull: false,
    unique: true,
  },
  // Parsed from the User-Agent at sign-in, e.g. "iPhone · Safari".
  label: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  lastSeenAt: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
  },
  lastIp: {
    type: DataTypes.STRING(45),
    allowNull: true,
    defaultValue: null,
  },
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  revokedAt: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
  },
});

module.exports = UserDevice;
