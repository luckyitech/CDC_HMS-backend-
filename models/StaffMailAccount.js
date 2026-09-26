const { defineModel, DataTypes } = require('../utils/defineModel');

// ---------------------------------------------------------------------------
// StaffMailAccount — one staff member's connection to their OWN clinic
// mailbox (Staff Email, B26). Migration 20260926000001.
//
// Holds the credential and status only. The HMS stores NO mail: every folder,
// message and attachment is read live from the provider over IMAP (the
// live-proxy decision). The password is AES-encrypted with utils/crypto.js and
// is never returned to the browser — services/mailAccounts.js redacts it.
//
// Nobody reads another person's mailbox through the HMS (decision D1): every
// /api/mail route acts on req.user.id's row only.
// ---------------------------------------------------------------------------

const StaffMailAccount = defineModel('StaffMailAccount', {
  userId:            { type: DataTypes.INTEGER, allowNull: false, unique: true },
  emailAddress:      { type: DataTypes.STRING, allowNull: false },
  passwordEncrypted: { type: DataTypes.TEXT, allowNull: true },
  // 'oauth' is reserved for providers that refuse password IMAP (Microsoft 365,
  // Google) — resale path, not built yet. See the plan §4b.
  authType:          { type: DataTypes.ENUM('password', 'oauth'), allowNull: false, defaultValue: 'password' },
  provider:          { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'onecom' },
  displayName:       { type: DataTypes.STRING, allowNull: true },
  signatureHtml:     { type: DataTypes.TEXT, allowNull: true },
  status: {
    type: DataTypes.ENUM('connected', 'needs_password', 'error', 'disconnected'),
    allowNull: false,
    defaultValue: 'connected',
  },
  lastError:           { type: DataTypes.TEXT, allowNull: true },
  // Consecutive login refusals. At 2 the account flips to needs_password and
  // the HMS stops trying — repeated bad logins can lock a one.com mailbox.
  failedAuthCount:     { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  lastConnectedAt:     { type: DataTypes.DATE, allowNull: true },
  remoteImagesDefault: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  // JSON array (as TEXT) of sender addresses whose remote images always load.
  trustedImageSenders: { type: DataTypes.TEXT, allowNull: true },
});

module.exports = StaffMailAccount;
