const { defineModel, DataTypes } = require('../utils/defineModel');

// One row per sign-in attempt by a member of staff — successful or failed —
// kept forever (Emu, 16 Oct 2026: "the system never forgets").
// Written by services/signinLog.js; read by the Sign-ins page, the Activity
// Log and the staff file. Where/how columns added by migration 20260928000038.
const UserLoginLog = defineModel('UserLoginLog', {
  // NULL on a failed attempt that names no account (emailTried holds what was typed).
  userId: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  // Every role whose logins are recorded. Nurse and admin were missing, so
  // their logins had nowhere to go and the Activity view stayed empty for them.
  // Keep this in step with TRACKED_ROLES in services/activityLogService.js —
  // a role in that set but not this enum is silently dropped, because the
  // insert is fire-and-forget.
  role: {
    type: DataTypes.ENUM('doctor', 'staff', 'lab', 'nurse', 'admin'),
    allowNull: true,
  },
  // The address as trusted through IIS (utils/ip.js clientIp) — never the
  // left-most X-Forwarded-For entry, which the browser can choose.
  ipAddress: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  loginAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
  // How the session was opened: 'password' (the login form) or 'device' (a
  // remembered phone exchanging its token at the entrance tag — HR Suite,
  // B21). NULL on rows written before the column existed, which read as
  // 'password'. Added by migration 20260923000007.
  method: {
    type: DataTypes.STRING(16),
    allowNull: true,
    defaultValue: null,
  },

  // --- Sign-in tracking (16 Oct 2026) ---
  outcome:      { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'success' },   // 'success' | 'failed'
  failReason:   { type: DataTypes.STRING(32), allowNull: true },    // 'unknown_account' | 'inactive' | 'wrong_password'
  emailTried:   { type: DataTypes.STRING(255), allowNull: true },   // failed attempts only
  userAgent:    { type: DataTypes.STRING(512), allowNull: true },
  deviceLabel:  { type: DataTypes.STRING(64), allowNull: true },    // utils/deviceLabel — "Mac · Chrome"
  network:      { type: DataTypes.STRING(16), allowNull: true },    // 'clinic' | 'outside' | 'unknown'
  networkLabel: { type: DataTypes.STRING(60), allowNull: true },    // the clinic network's own label
  countryCode:  { type: DataTypes.STRING(2), allowNull: true },
  country:      { type: DataTypes.STRING(80), allowNull: true },
  region:       { type: DataTypes.STRING(100), allowNull: true },
  city:         { type: DataTypes.STRING(100), allowNull: true },
  isp:          { type: DataTypes.STRING(150), allowNull: true },
  // The browser's own answer when the clinic asks (Settings → Sign-in security):
  // 'given' (with coordinates) | 'declined' | 'unavailable'. NULL = not asked.
  gpsStatus:    { type: DataTypes.STRING(16), allowNull: true },
  gpsLat:       { type: DataTypes.DECIMAL(9, 6), allowNull: true },
  gpsLng:       { type: DataTypes.DECIMAL(9, 6), allowNull: true },
  gpsAccuracy:  { type: DataTypes.INTEGER, allowNull: true },      // metres
  gpsAt:        { type: DataTypes.DATE, allowNull: true },
  flagged:      { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  flagReasons:  { type: DataTypes.STRING(255), allowNull: true },  // utils/signinFlags reason keys, comma-separated
  alertedAt:    { type: DataTypes.DATE, allowNull: true },
});

module.exports = UserLoginLog;
