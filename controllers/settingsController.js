const { success, error } = require('../utils/response');
const {
  ROTATING_ROLES,
  MINIMUM_PASSWORD_AGE_DAYS,
  INTERVALS,
  isValidInterval,
  getRotationConfig,
  setRotationConfig,
  expiredWhere,
  dueSoonWhere,
} = require('../utils/passwordRotation');
const { notifyStaffOfRotationPolicy } = require('../services/passwordRotationNotifier');
const { recordSettingChanges } = require('../services/settingChangeLog');
const db = require('../models');

const { User } = db;

// Shared shape for both the read and the write, so the admin page always gets
// the recomputed numbers back after changing something.
const buildRotationPayload = async () => {
  const { enabled, interval } = await getRotationConfig();

  const activeStaff = { role: ROTATING_ROLES, isActive: true };

  // Both predicates come from utils/passwordRotation so the counts shown here
  // can never disagree with what the login gate actually enforces.
  const [dueCount, dueSoonCount, totalStaff] = await Promise.all([
    User.count({ where: { ...activeStaff, ...expiredWhere(interval) } }),
    User.count({ where: { ...activeStaff, ...dueSoonWhere(interval) } }),
    User.count({ where: activeStaff }),
  ]);

  return {
    enabled,
    interval,
    intervalLabel: INTERVALS[interval].label,
    intervalOptions: Object.values(INTERVALS).map(({ value, label, description, duration }) => ({
      value, label, description, duration,
    })),
    affectedRoles: ROTATING_ROLES,
    minimumPasswordAgeDays: MINIMUM_PASSWORD_AGE_DAYS,
    dueCount,
    dueSoonCount,
    totalStaff,
  };
};

/**
 * GET /api/settings/password-rotation
 * Current state of scheduled staff password rotation, plus a count of who is
 * currently due — so the admin can see the blast radius before turning it on.
 * Authorization: admin
 */
const getPasswordRotation = async (req, res) => {
  try {
    return success(res, await buildRotationPayload());
  } catch (err) {
    console.error('getPasswordRotation error:', err.message);
    return error(res, 'Failed to load the password rotation setting', 500);
  }
};

/**
 * PUT /api/settings/password-rotation
 * Body may carry either or both of:
 *   enabled  — boolean
 *   interval — 'weekly' | 'fortnightly' | 'monthly'
 * Authorization: a real admin account (see routes/settings.js)
 */
const updatePasswordRotation = async (req, res) => {
  try {
    const { enabled, interval } = req.body;

    if (enabled === undefined && interval === undefined) {
      return error(res, "Provide 'enabled' and/or 'interval'", 400);
    }
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return error(res, "'enabled' must be true or false", 400);
    }
    if (interval !== undefined && !isValidInterval(interval)) {
      return error(
        res,
        `Invalid interval '${interval}'. Valid intervals: ${Object.keys(INTERVALS).join(', ')}`,
        400
      );
    }

    const before = await getRotationConfig();
    const wasEnabled = before.enabled;
    const config = await setRotationConfig({ enabled, interval });

    // Audit trail → Activity Log ('setting_changed'). Fire-and-forget.
    recordSettingChanges({
      user: req.user, area: 'Password policy', before, after: config,
      fields: {
        enabled:  { key: 'passwordRotationEnabled',  label: 'Scheduled password rotation' },
        interval: { key: 'passwordRotationInterval', label: 'Rotation interval' },
      },
    });

    // Announce the policy the moment it is switched on, so staff hear it from
    // their inbox rather than from being locked out mid-shift. Only on the
    // off -> on transition: re-saving an interval while it is already running
    // would otherwise mail the whole clinic every time the admin nudges a button.
    //
    // Not awaited. The admin's response must not wait on one SMTP round trip per
    // member of staff, and a mail outage must never stop the policy taking
    // effect — the login gate enforces it, not the email.
    if (!wasEnabled && config.enabled) {
      notifyStaffOfRotationPolicy(config.interval)
        .catch((err) => console.warn('[Settings] rotation notice failed:', err.message));
    }

    return success(res, await buildRotationPayload());
  } catch (err) {
    console.error('updatePasswordRotation error:', err.message);
    return error(res, 'Failed to update the password rotation setting', 500);
  }
};

// =====================================================================
// Lab Inbox — mailbox connection + import policy (System Settings → Lab Inbox)
// =====================================================================
const {
  getLabInboxConfig,
  setLabInboxConfig,
  AFTER_IMPORT,
} = require('../utils/labInboxConfig');

/**
 * GET /api/settings/lab-inbox
 * The connection + policy WITHOUT the password (only `hasPassword`), plus the
 * last poll result for the status line.
 * Authorization: admin / config.write
 */
const getLabInbox = async (req, res) => {
  try {
    return success(res, await getLabInboxConfig({ redact: true }));
  } catch (err) {
    console.error('getLabInbox error:', err.message);
    return error(res, 'Failed to load the Lab Inbox settings', 500);
  }
};

/**
 * PUT /api/settings/lab-inbox
 * Any subset of: host, port, secure, user, password, mailbox, enabled,
 * pollIntervalMin, afterImport, moveFolder, allowlist[].
 * A blank password leaves the stored one unchanged. Nothing ships pre-filled.
 * Authorization: a real admin account (credentials) — see routes/settings.js
 */
const updateLabInbox = async (req, res) => {
  try {
    const allowed = ['host', 'port', 'secure', 'user', 'password', 'mailbox', 'enabled',
      'pollIntervalMin', 'afterImport', 'moveFolder', 'allowlist'];
    const changes = {};
    for (const k of allowed) if (req.body[k] !== undefined) changes[k] = req.body[k];
    if (!Object.keys(changes).length) return error(res, 'Nothing to update.', 400);

    if (changes.afterImport !== undefined && !AFTER_IMPORT.includes(changes.afterImport)) {
      return error(res, `afterImport must be one of ${AFTER_IMPORT.join(', ')}`, 400);
    }
    if (changes.user !== undefined && changes.user && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(changes.user)) {
      return error(res, 'The mailbox must be a valid email address.', 400);
    }

    const before = await getLabInboxConfig({ redact: true });
    const cfg = await setLabInboxConfig(changes);

    // Audit trail → Activity Log ('setting_changed'). The password is logged
    // only as "(changed)" — never its value. Fire-and-forget.
    recordSettingChanges({
      user: req.user, area: 'Lab Inbox', before, after: cfg,
      secretsChanged: changes.password ? ['password'] : [],
      fields: {
        user:            { key: 'labInbox.user',            label: 'Mailbox address' },
        host:            { key: 'labInbox.host',            label: 'IMAP host' },
        port:            { key: 'labInbox.port',            label: 'IMAP port' },
        secure:          { key: 'labInbox.secure',          label: 'SSL/TLS' },
        password:        { key: 'labInbox.password',        label: 'Mailbox password' },
        mailbox:         { key: 'labInbox.mailbox',         label: 'Folder' },
        enabled:         { key: 'labInbox.enabled',         label: 'Auto-import' },
        pollIntervalMin: { key: 'labInbox.pollIntervalMin', label: 'Check interval (min)' },
        afterImport:     { key: 'labInbox.afterImport',     label: 'After importing' },
        moveFolder:      { key: 'labInbox.moveFolder',      label: 'Move-to folder' },
        allowlist:       { key: 'labInbox.allowlist',       label: 'Lab sender allowlist' },
      },
    });

    return success(res, cfg);
  } catch (err) {
    console.error('updateLabInbox error:', err.message);
    // Validation errors from the config layer are user-facing.
    const userFacing = /must be|not a valid|required|between/i.test(err.message || '');
    return error(res, userFacing ? err.message : 'Failed to update the Lab Inbox settings', userFacing ? 400 : 500);
  }
};

/**
 * POST /api/settings/lab-inbox/test
 * Tries the connection with the submitted (possibly unsaved) values; the
 * stored password is used when none is sent. Never persists anything.
 * Authorization: admin / config.write
 */
const testLabInbox = async (req, res) => {
  try {
    const { testConnection } = require('../services/labInboxPoller');
    const result = await testConnection(req.body || {});
    return success(res, result);
  } catch (err) {
    console.error('testLabInbox error:', err.message);
    return error(res, `Connection failed: ${err.message}`, 400);
  }
};

// =====================================================================
// Communications Inbox — WhatsApp (System Settings → WhatsApp)
// =====================================================================
const { getCommsConfig, setCommsConfig } = require('../utils/commsConfig');
const { getRateCard, setRateCard } = require('../utils/commsCosts');

/** GET /api/settings/comms — redacted config + rate card + configured numbers. */
const getComms = async (req, res) => {
  try {
    const cfg = await getCommsConfig({ redact: true });
    const [rateCard, channels] = await Promise.all([
      getRateCard(),
      db.MessagingChannel.findAll({ where: {}, order: [['id', 'ASC']], attributes: ['id', 'channel', 'externalId', 'displayPhone', 'label', 'wabaId', 'isActive', 'qualityRating', 'lastInboundAt', 'lastOutboundAt'] }),
    ]);
    return success(res, { ...cfg, rateCard, channels });
  } catch (err) {
    console.error('getComms error:', err.message);
    return error(res, 'Failed to load the WhatsApp settings', 500);
  }
};

/**
 * PUT /api/settings/comms — connection + behaviour. Credentials are held to a
 * real admin (routes/settings.js). A blank secret leaves the stored one.
 */
const updateComms = async (req, res) => {
  try {
    const allowed = ['wabaId', 'appId', 'appSecret', 'accessToken', 'verifyToken', 'graphVersion',
      'pageId', 'igId', 'pageAccessToken',
      'autoLink', 'markReadOnOpen', 'warnNoConsent', 'archiveUnlinkedDays', 'mediaMaxMb', 'monthlyBudgetKes'];
    const changes = {};
    for (const k of allowed) if (req.body[k] !== undefined) changes[k] = req.body[k];
    if (!Object.keys(changes).length) return error(res, 'Nothing to update.', 400);

    const before = await getCommsConfig({ redact: true });
    const cfg = await setCommsConfig(changes);

    // Register the Messenger (Facebook Page) and Instagram channels so the
    // webhook can route inbound events to them. The Page/IG id is the routable
    // identity; the page token (sends both) lives in Settings, not here.
    if (cfg.pageId) {
      await db.MessagingChannel.findOrCreate({
        where: { externalId: String(cfg.pageId) },
        defaults: { channel: 'messenger', externalId: String(cfg.pageId), label: 'Facebook Page', isActive: true },
      }).then(([row]) => (row.channel === 'messenger' ? null : row.update({ channel: 'messenger' })));
    }
    if (cfg.igId) {
      await db.MessagingChannel.findOrCreate({
        where: { externalId: String(cfg.igId) },
        defaults: { channel: 'instagram', externalId: String(cfg.igId), label: 'Instagram', isActive: true },
      }).then(([row]) => (row.channel === 'instagram' ? null : row.update({ channel: 'instagram' })));
    }

    const secretsChanged = ['appSecret', 'accessToken', 'verifyToken', 'pageAccessToken'].filter((k) => changes[k]);
    recordSettingChanges({
      user: req.user, area: 'WhatsApp', before, after: cfg, secretsChanged,
      fields: {
        wabaId:              { key: 'comms.wabaId',              label: 'WhatsApp Business Account ID' },
        appId:               { key: 'comms.appId',               label: 'Meta App ID' },
        appSecret:           { key: 'comms.appSecret',           label: 'Meta App Secret' },
        accessToken:         { key: 'comms.accessToken',         label: 'Access token' },
        verifyToken:         { key: 'comms.verifyToken',         label: 'Webhook verify token' },
        pageId:              { key: 'comms.pageId',              label: 'Facebook Page ID' },
        igId:                { key: 'comms.igId',                label: 'Instagram account ID' },
        pageAccessToken:     { key: 'comms.pageAccessToken',     label: 'Page access token' },
        graphVersion:        { key: 'comms.graphVersion',        label: 'Graph API version' },
        autoLink:            { key: 'comms.autoLink',            label: 'Auto-link on a unique phone match' },
        markReadOnOpen:      { key: 'comms.markReadOnOpen',      label: 'Send read receipts on open' },
        warnNoConsent:       { key: 'comms.warnNoConsent',       label: 'Warn when messaging without consent' },
        archiveUnlinkedDays: { key: 'comms.archiveUnlinkedDays', label: 'Archive unlinked threads after (days)' },
        mediaMaxMb:          { key: 'comms.mediaMaxMb',          label: 'Media size cap (MB)' },
        monthlyBudgetKes:    { key: 'comms.monthlyBudgetKes',    label: 'Monthly budget (KES)' },
      },
    });
    return success(res, cfg);
  } catch (err) {
    console.error('updateComms error:', err.message);
    const userFacing = /must be|not a valid|required|between|too large/i.test(err.message || '');
    return error(res, userFacing ? err.message : 'Failed to update the WhatsApp settings', userFacing ? 400 : 500);
  }
};

/**
 * POST /api/settings/comms/test — subscribe our app to the WABA and pull the
 * numbers, upserting a MessagingChannel per number so the Inbox can route.
 */
const testComms = async (req, res) => {
  try {
    const cfg = await getCommsConfig({ redact: false });
    const wabaId = (req.body && req.body.wabaId) || cfg.wabaId;
    if (!wabaId) return error(res, 'Enter the WhatsApp Business Account ID first.', 400);
    if (!cfg.accessToken) return error(res, 'Save the access token first.', 400);
    const whatsappApi = require('../services/whatsappApi');
    await whatsappApi.subscribeApp(wabaId).catch((e) => { throw new Error(e.userMessage || e.message); });
    const numbers = await whatsappApi.getPhoneNumbers(wabaId);
    for (const n of numbers) {
      await db.MessagingChannel.findOrCreate({
        where: { externalId: String(n.id) },
        defaults: { channel: 'whatsapp', externalId: String(n.id), displayPhone: n.display_phone_number, label: n.verified_name, wabaId, qualityRating: n.quality_rating, isActive: true },
      }).then(([row, created]) => (created ? row : row.update({ displayPhone: n.display_phone_number, label: n.verified_name, wabaId, qualityRating: n.quality_rating })));
    }
    return success(res, { ok: true, numbers: numbers.map((n) => ({ id: n.id, displayPhone: n.display_phone_number, name: n.verified_name, quality: n.quality_rating })) });
  } catch (err) {
    console.error('testComms error:', err.message);
    return error(res, `Connection failed: ${err.message}`, 400);
  }
};

/** PUT /api/settings/comms/costs — the rate card + monthly budget. */
const updateCommsCosts = async (req, res) => {
  try {
    const before = await getCommsConfig({ redact: true });
    if (Array.isArray(req.body.rateCard)) await setRateCard(req.body.rateCard);
    let after = before;
    if (req.body.monthlyBudgetKes !== undefined) after = await setCommsConfig({ monthlyBudgetKes: req.body.monthlyBudgetKes });
    recordSettingChanges({
      user: req.user, area: 'WhatsApp', before, after,
      fields: { monthlyBudgetKes: { key: 'comms.monthlyBudgetKes', label: 'Monthly budget (KES)' } },
    });
    // The rate card itself is logged as one change line (values are prices, not secrets).
    recordSettingChanges({
      user: req.user, area: 'WhatsApp',
      before: { rateCard: '(previous)' }, after: { rateCard: `${(req.body.rateCard || []).length} row(s) updated` },
      fields: { rateCard: { key: 'comms.rateCard', label: 'WhatsApp rate card' } },
    });
    return success(res, { rateCard: await getRateCard(), monthlyBudgetKes: (await getCommsConfig()).monthlyBudgetKes });
  } catch (err) {
    console.error('updateCommsCosts error:', err.message);
    const userFacing = /must|row|large|effective/i.test(err.message || '');
    return error(res, userFacing ? err.message : 'Failed to update the WhatsApp costs', userFacing ? 400 : 500);
  }
};

module.exports = {
  getPasswordRotation,
  updatePasswordRotation,
  getLabInbox,
  updateLabInbox,
  testLabInbox,
  getComms,
  updateComms,
  testComms,
  updateCommsCosts,
};
