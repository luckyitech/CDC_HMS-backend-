const db = require('../models');
const { normEmail } = require('../utils/mailConfig');

const { StaffMailAccount, StaffMailEvent } = db;

// ---------------------------------------------------------------------------
// Staff Email (B26) — the credential store. Everything that reads or writes a
// StaffMailAccount row goes through here, so the password handling lives in
// ONE place:
//   - encrypted at rest with utils/crypto.js (CARELINK_ENCRYPTION_KEY)
//   - never returned by redact() — the browser only ever sees `hasPassword`
//   - never logged, never written to StaffMailEvents
// ---------------------------------------------------------------------------

const cryptoUtil = () => {
  if (!process.env.CARELINK_ENCRYPTION_KEY) {
    throw new Error('CARELINK_ENCRYPTION_KEY is not set — it is required to store mailbox passwords securely.');
  }
  return require('../utils/crypto');
};

// Two refusals in a row and the HMS stops trying (one.com can lock a mailbox
// after repeated failed logins). The user re-enters the password to reset it.
const AUTH_FAILURE_LIMIT = 2;

const parseSenders = (raw) => {
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
};

/** The row as the browser may see it — no secret, ever. */
const redact = (row) => (row ? {
  emailAddress: row.emailAddress,
  provider: row.provider,
  authType: row.authType,
  displayName: row.displayName || '',
  signatureHtml: row.signatureHtml || '',
  status: row.status,
  lastError: row.status === 'connected' ? null : (row.lastError || null),
  lastConnectedAt: row.lastConnectedAt,
  remoteImagesDefault: !!row.remoteImagesDefault,
  trustedImageSenders: parseSenders(row.trustedImageSenders),
  hasPassword: !!row.passwordEncrypted,
} : null);

const findForUser = (userId) => StaffMailAccount.findOne({ where: { userId } });

/** The decrypted password — only ever called by services/mailSession.js. */
const passwordFor = (row) => (row && row.passwordEncrypted ? cryptoUtil().decrypt(row.passwordEncrypted) : null);

/** Metadata-only audit row. Fire-and-forget: an audit hiccup never breaks mail. */
const logEvent = ({ userId, actorId = null, event, emailAddress = null, detail = null }, options = {}) =>
  StaffMailEvent.create({ userId, actorId, event, emailAddress, detail: detail ? String(detail).slice(0, 500) : null }, options)
    .catch((err) => console.error('StaffMailEvent.create error:', err.message));

/** Is this address already connected by SOMEONE ELSE (not disconnected)? */
const addressInUseByOther = async (emailAddress, userId) => {
  const other = await StaffMailAccount.findOne({ where: { emailAddress: normEmail(emailAddress) } });
  return !!(other && other.userId !== userId && other.status !== 'disconnected');
};

/** Create or replace the caller's connection after a successful test login. */
const saveConnection = async ({ userId, emailAddress, password, provider, displayName }) => {
  const values = {
    emailAddress: normEmail(emailAddress),
    passwordEncrypted: cryptoUtil().encrypt(password),
    authType: 'password',
    provider,
    status: 'connected',
    lastError: null,
    failedAuthCount: 0,
    lastConnectedAt: new Date(),
  };
  if (displayName !== undefined) values.displayName = displayName || null;
  const existing = await findForUser(userId);
  const row = existing ? await existing.update(values) : await StaffMailAccount.create({ userId, ...values });
  await logEvent({ userId, actorId: userId, event: 'connected', emailAddress: row.emailAddress });
  return row;
};

const updatePreferences = async (userId, prefs) => {
  const row = await findForUser(userId);
  if (!row) return null;
  const values = {};
  if (prefs.displayName !== undefined) values.displayName = String(prefs.displayName || '').slice(0, 120) || null;
  if (prefs.signatureHtml !== undefined) values.signatureHtml = String(prefs.signatureHtml || '').slice(0, 5000) || null;
  if (prefs.remoteImagesDefault !== undefined) values.remoteImagesDefault = !!prefs.remoteImagesDefault;
  if (prefs.trustedImageSenders !== undefined) {
    const list = [...new Set((Array.isArray(prefs.trustedImageSenders) ? prefs.trustedImageSenders : [])
      .map(normEmail).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)))].slice(0, 500);
    values.trustedImageSenders = JSON.stringify(list);
  }
  return row.update(values);
};

const markConnected = (row) => (row.failedAuthCount || row.status !== 'connected' || !row.lastConnectedAt
  || Date.now() - new Date(row.lastConnectedAt).getTime() > 60 * 60 * 1000
  ? row.update({ status: 'connected', failedAuthCount: 0, lastError: null, lastConnectedAt: new Date() })
  : row);

/** A login refusal. At the limit the account parks in needs_password. */
const recordAuthFailure = async (row, message) => {
  const count = (row.failedAuthCount || 0) + 1;
  const parked = count >= AUTH_FAILURE_LIMIT;
  await row.update({
    failedAuthCount: count,
    status: parked ? 'needs_password' : row.status,
    lastError: parked
      ? 'Your mailbox refused the saved password (it may have been changed). Enter it again to reconnect.'
      : String(message || 'Login refused').slice(0, 500),
  });
  await logEvent({ userId: row.userId, actorId: null, event: 'auth_failed', emailAddress: row.emailAddress, detail: parked ? 'parked: needs_password' : null });
  return parked;
};

const recordConnectionError = (row, message) =>
  row.update({ lastError: String(message || 'Connection failed').slice(0, 500) });

/**
 * Forget the credential. Used by the user's own Disconnect, an admin's
 * Disconnect, and the archive hook (D5). The row is kept (status
 * 'disconnected', password NULL) so the audit trail and the address survive.
 */
const wipe = async ({ userId, actorId, reason = 'disconnected' }, options = {}) => {
  const row = await StaffMailAccount.findOne({ where: { userId }, ...options });
  if (!row) return false;
  await row.update({ passwordEncrypted: null, status: 'disconnected', failedAuthCount: 0, lastError: null }, options);
  await logEvent({
    userId, actorId, event: reason === 'archived' ? 'wiped' : 'disconnected',
    emailAddress: row.emailAddress, detail: reason,
  }, options);
  // Drop any open IMAP connection — lazily required so a DB-only caller (the
  // archive transaction) doesn't pull in the IMAP layer at load time.
  try { require('./mailSession').closeClient(userId); } catch { /* nothing open */ }
  return true;
};

/** Admin view: who is connected. Status only — no mail, no secrets. */
const listForAdmin = async () => {
  const rows = await StaffMailAccount.findAll({
    include: [{ model: db.User, as: 'user', attributes: ['id', 'firstName', 'lastName', 'role', 'email', 'isActive'] }],
    order: [['emailAddress', 'ASC']],
  });
  return rows.map((r) => ({
    userId: r.userId,
    name: r.user ? `${r.user.firstName || ''} ${r.user.lastName || ''}`.trim() : null,
    role: r.user ? r.user.role : null,
    emailAddress: r.emailAddress,
    status: r.status,
    lastConnectedAt: r.lastConnectedAt,
  }));
};

module.exports = {
  AUTH_FAILURE_LIMIT,
  redact,
  findForUser,
  passwordFor,
  logEvent,
  addressInUseByOther,
  saveConnection,
  updatePreferences,
  markConnected,
  recordAuthFailure,
  recordConnectionError,
  wipe,
  listForAdmin,
};
