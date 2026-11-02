const { defineModel, DataTypes } = require('../utils/defineModel');

// A registered check-in phone (B21, decision 6; HR-registered since 17 Oct 2026).
//
// The tap page cannot rely on the HMS session — it is per-tab sessionStorage,
// and a URL opened from an NFC tag lands in a fresh tab, logged out. So the
// phone holds a long random token, and every tap exchanges it for a short
// CHECK-IN-ONLY pass (POST /api/auth/device-session, scope 'tap') — never a
// full session: the HMS itself still needs a password sign-in.
//
// Since 17 Oct 2026 only HR holding hr.devices.register can register a phone:
// HR issues a one-time code (PhoneRegistration) that the phone enters on the
// tap page. One phone per person — registering a new one revokes the old.
// Phones remembered by staff themselves before then have no registeredById.
//
// Only the SHA-256 of the token is stored, so a copy of this table cannot be
// replayed. expiresAt rolls forward `deviceDays` on every use. Revoked from the
// HR dashboard ("My phones"), the staff file, or automatically when the
// account is deactivated/archived.
//
// Association-injected: UserId (User.hasMany), revokedById, registeredById.
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
