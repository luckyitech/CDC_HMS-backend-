// =====================================================================
// Sign-ins (16 Oct 2026, Emu) — the record of where and how staff sign in,
// and the clinic's sign-in security settings. Admin → Monitoring → Sign-ins;
// Admin → Settings → Sign-in security.
//
// Gates (routes/signins.js): reading needs it.signins.view, the settings need
// it.security.settings — both explicit grants or the main admin account,
// never admin.access (constants/permissions.js canViewSignins /
// canEditSigninSecurity).
// =====================================================================

const { Op } = require('sequelize');
const db = require('../models');
const { success, error } = require('../utils/response');
const { clinicMidnight, clinicToday } = require('../utils/clinicTime');
const { nextDate } = require('../utils/workHours');
const { clientIp, matchNetwork, isPublicIp } = require('../utils/ip');
const { signinSummary, placeText, FAIL_TEXT } = require('../services/signinLog');
const { REASON_LABELS } = require('../utils/signinFlags');
const {
  getSigninSecurityConfig, setSigninSecurityConfig, redact, FIELDS, PROVIDERS,
} = require('../utils/signinSecurityConfig');
const { recordSettingChanges } = require('../services/settingChangeLog');
const { blockedByLock, isExempt } = require('../utils/networkLock');
const { canWorkOutsideClinic, INTERNAL_ROLES } = require('../constants/permissions');

const { UserLoginLog, User } = db;

/** Who may work outside the clinic once the lock is on (besides the main admin account). */
const remoteHolders = async () => {
  const staff = await User.findAll({
    where: { isActive: true, role: { [Op.in]: INTERNAL_ROLES.filter((r) => r !== 'admin') } },
    attributes: ['id', 'firstName', 'lastName', 'role', 'permissions', 'deniedPermissions', 'staffType'],
    order: [['firstName', 'ASC']],
  });
  return staff.filter((u) => canWorkOutsideClinic(u))
    .map((u) => ({ id: u.id, name: `${u.firstName} ${u.lastName}`.trim(), role: u.role }));
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const OUTCOMES = ['success', 'failed'];
const NETWORKS = ['clinic', 'outside', 'unknown'];

/** One row as every screen shows it. `full` adds the browser string and coordinates. */
const formatRow = (r, { full = false } = {}) => {
  const reasons = r.flagReasons ? r.flagReasons.split(',').filter(Boolean) : [];
  return {
    id: r.id,
    loginAt: r.loginAt,
    userId: r.userId,
    name: r.name,
    role: r.role,
    emailTried: r.emailTried,
    outcome: r.outcome || 'success',
    failReason: r.failReason,
    failText: r.failReason ? FAIL_TEXT[r.failReason] || r.failReason : null,
    method: r.method || 'password',
    ipAddress: r.ipAddress,
    deviceLabel: r.deviceLabel,
    network: r.network || 'unknown',
    networkLabel: r.networkLabel,
    place: placeText(r),
    countryCode: r.countryCode,
    isp: r.isp,
    gpsStatus: r.gpsStatus,
    hasGps: r.gpsStatus === 'given' && r.gpsLat != null,
    flagged: !!r.flagged,
    flagReasons: reasons,
    flagText: reasons.map((k) => REASON_LABELS[k] || k),
    alertedAt: r.alertedAt,
    summary: signinSummary(r),
    ...(full ? {
      userAgent: r.userAgent,
      region: r.region,
      city: r.city,
      country: r.country,
      gpsLat: r.gpsLat != null ? Number(r.gpsLat) : null,
      gpsLng: r.gpsLng != null ? Number(r.gpsLng) : null,
      gpsAccuracy: r.gpsAccuracy,
      gpsAt: r.gpsAt,
    } : {}),
  };
};

/** The filters shared by the list and its totals. */
const whereFrom = (q) => {
  const where = {};
  const from = DATE.test(q.from || '') ? q.from : null;
  const to = DATE.test(q.to || '') ? q.to : null;
  if (from || to) {
    where.loginAt = {};
    if (from) where.loginAt[Op.gte] = clinicMidnight(from);
    if (to) where.loginAt[Op.lt] = clinicMidnight(nextDate(to));
  }
  if (OUTCOMES.includes(q.outcome)) where.outcome = q.outcome;
  // Rows recorded before 16 Oct 2026 have no network: they read as unknown.
  if (NETWORKS.includes(q.network)) where.network = q.network === 'unknown' ? { [Op.or]: ['unknown', null] } : q.network;
  if (q.flagged === 'true') where.flagged = true;
  const userId = parseInt(q.userId, 10);
  if (Number.isInteger(userId) && userId > 0) where.userId = userId;
  const term = String(q.q || '').trim().slice(0, 80);
  if (term) {
    const like = { [Op.like]: `%${term.replace(/[%_\\]/g, '\\$&')}%` };
    where[Op.or] = [{ name: like }, { emailTried: like }, { ipAddress: like }, { city: like }, { country: like }];
  }
  return where;
};

// GET /api/signins
const list = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const where = whereFrom(req.query);
    const [{ rows, count }, failed, outside, flagged] = await Promise.all([
      UserLoginLog.findAndCountAll({ where, order: [['loginAt', 'DESC'], ['id', 'DESC']], limit, offset: (page - 1) * limit }),
      // Each total is the current filter AND its own condition (never replacing it).
      UserLoginLog.count({ where: { [Op.and]: [where, { outcome: 'failed' }] } }),
      UserLoginLog.count({ where: { [Op.and]: [where, { network: 'outside' }] } }),
      UserLoginLog.count({ where: { [Op.and]: [where, { flagged: true }] } }),
    ]);
    return success(res, {
      signins: rows.map((r) => formatRow(r)),
      total: count,
      page,
      pages: Math.max(1, Math.ceil(count / limit)),
      totals: { all: count, failed, outside, flagged, successful: count - failed },
    });
  } catch (err) {
    console.error('Signin.list error:', err);
    return error(res, 'Failed to load sign-ins.', 500);
  }
};

// GET /api/signins/:id
const detail = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return error(res, 'Sign-in not found.', 404);
    const row = await UserLoginLog.findByPk(id);
    if (!row) return error(res, 'Sign-in not found.', 404);
    return success(res, { signin: formatRow(row, { full: true }) });
  } catch (err) {
    console.error('Signin.detail error:', err);
    return error(res, 'Failed to load the sign-in.', 500);
  }
};

/** The config as the settings audit records it: networks as text, the token as set / not set. */
const auditView = (cfg) => ({
  ...redact(cfg),
  networks: (cfg.networks || []).map((n) => `${n.value} (${n.label})`),
  lookupToken: cfg.lookupToken ? 'set' : null,
});

// GET /api/signins/mine — a member of staff's own recent sign-ins (My profile).
const mine = async (req, res) => {
  try {
    const rows = await UserLoginLog.findAll({
      where: { userId: req.user.id }, order: [['loginAt', 'DESC'], ['id', 'DESC']], limit: 50,
    });
    return success(res, { signins: rows.map((r) => formatRow(r)) });
  } catch (err) {
    console.error('Signin.mine error:', err);
    return error(res, 'Failed to load your sign-ins.', 500);
  }
};

// GET /api/signins/settings
const getSettings = async (req, res) => {
  try {
    const cfg = await getSigninSecurityConfig();
    const ip = clientIp(req);
    return success(res, {
      ...redact(cfg),
      providers: PROVIDERS,
      // "Your current address" — so a clinic computer can add the clinic's own
      // network in one press (Emu does not yet know the clinic's address).
      yourAddress: ip ? {
        ip,
        public: isPublicIp(ip),
        matches: matchNetwork(ip, cfg.networks)?.value || null,
      } : null,
      // The network lock: whether the person looking could work outside, and who else can.
      youAreExempt: isExempt(req.user, { cfg }),
      remoteHolders: await remoteHolders(),
      today: clinicToday(),
    });
  } catch (err) {
    console.error('Signin.getSettings error:', err);
    return error(res, 'Failed to load sign-in security settings.', 500);
  }
};

// PUT /api/signins/settings
const updateSettings = async (req, res) => {
  try {
    const current = await getSigninSecurityConfig();
    // Never let the person saving lock themselves out: switching the lock on
    // (or removing the network they are on while it is on) from outside the
    // clinic, without remote access, is refused.
    const proposed = {
      ...current,
      lockOutside: req.body?.lockOutside !== undefined ? req.body.lockOutside === true : current.lockOutside,
      networks: Array.isArray(req.body?.networks) ? req.body.networks : current.networks,
    };
    if (proposed.lockOutside && blockedByLock({ user: req.user, ip: clientIp(req), cfg: proposed })) {
      return error(res, 'That would lock you out: you are outside the clinic network and your account has no remote access. '
        + 'Make the change from a clinic computer, or grant yourself "May sign in from outside the clinic" first.', 400);
    }
    const before = auditView(current);
    const after = await setSigninSecurityConfig(req.body || {});
    recordSettingChanges({
      user: req.user, area: 'Sign-in security', before, after: auditView(after),
      fields: FIELDS,
      secretsChanged: req.body?.lookupToken !== undefined ? ['lookupToken'] : [],
    });
    return success(res, { ...redact(after), providers: PROVIDERS });
  } catch (err) {
    if (err.status === 400) return error(res, err.message, 400);
    console.error('Signin.updateSettings error:', err);
    return error(res, 'Failed to save sign-in security settings.', 500);
  }
};

module.exports = { list, detail, mine, getSettings, updateSettings, formatRow };
