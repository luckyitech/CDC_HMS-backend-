// =====================================================================
// HR Suite — fingerprint scanner (17 Oct 2026).
//
// Two audiences:
//   the relay (machine, middleware/scannerAuth) — heartbeat, punches
//   HR (JWT, routes/hr.js)                       — status, setup, linking
// The scanner key is shown exactly once (create / replace) and never again.
// =====================================================================

const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../models');
const { success, error } = require('../utils/response');
const { clinicLocalToInstant, clinicDateTime } = require('../utils/clinicTime');
const { recordSettingChanges } = require('../services/settingChangeLog');
const scanners = require('../services/scannerService');
const svc = require('../services/hrAttendanceService');
const { sha256 } = require('../middleware/scannerAuth');
const hrScope = require('../services/hrScope');
const { PERMISSIONS } = require('../constants/permissions');

const { HrScanner, HrScannerUser, User } = db;
const { STAFF_ROLES } = require('../constants/staffRoles');

const MAX_BATCH = 2000;
const POLL_SECONDS = 60;
const AREA = 'HR Suite';

const newKey = () => crypto.randomBytes(24).toString('hex');

/** A scanner as HR sees it — never the key hash. */
const serializeScanner = (s, now = new Date()) => ({
  id: s.id, serial: s.serial, label: s.label, location: s.location, status: s.status,
  goLiveAt: s.goLiveAt, keySetAt: s.keySetAt, lastSeenAt: s.lastSeenAt, lastPunchAt: s.lastPunchAt,
  recordCount: s.recordCount, userCount: s.userCount, relayVersion: s.relayVersion, relayHost: s.relayHost,
  clockDriftSeconds: s.clockDriftSeconds,
  online: scanners.isOnline(s, now),
});

const auditFields = (s) => ({
  label:    { key: `hr.scanner.${s.serial}.label`, label: `Scanner ${s.serial} — name` },
  location: { key: `hr.scanner.${s.serial}.location`, label: `Scanner ${s.serial} — location` },
  status:   { key: `hr.scanner.${s.serial}.status`, label: `Scanner ${s.serial} — accepting punches` },
  goLiveAt: { key: `hr.scanner.${s.serial}.goLive`, label: `Scanner ${s.serial} — counts punches from` },
  key:      { key: `hr.scanner.${s.serial}.apikey`, label: `Scanner ${s.serial} — relay key` },
});
const snapshot = (s) => ({ label: s.label, location: s.location, status: s.status, goLiveAt: s.goLiveAt ? clinicDateTime(new Date(s.goLiveAt)) : null });

// ---------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------

/** POST /api/hr/scanner-relay/heartbeat — once a minute, and the user list now and then. */
const heartbeat = async (req, res) => {
  try {
    const s = req.scanner;
    const b = req.body || {};
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    // The scanner's clock against ours (the relay sends the scanner's local
    // time): shown on the settings tab when it drifts, so HR can set it right.
    const scannerNow = b.scannerTime ? clinicLocalToInstant(b.scannerTime) : null;
    const drift = scannerNow ? Math.round((scannerNow.getTime() - Date.now()) / 1000) : null;
    await s.update({
      lastSeenAt: new Date(),
      clockDriftSeconds: drift ?? s.clockDriftSeconds,
      recordCount: num(b.recordCount) ?? s.recordCount,
      userCount: num(b.userCount) ?? s.userCount,
      relayVersion: b.relayVersion ? String(b.relayVersion).slice(0, 32) : s.relayVersion,
      relayHost: b.relayHost ? String(b.relayHost).slice(0, 64) : s.relayHost,
    });
    if (Array.isArray(b.users)) {
      const list = b.users
        .filter((u) => u && /^\d{1,24}$/.test(String(u.userNo || '')))
        .map((u) => ({ userNo: String(u.userNo), name: u.name == null ? undefined : String(u.name).slice(0, 120) }));
      await scanners.syncUserList(s, list);
    }
    // Punches left pending by an error are retried here, once a minute.
    if (await db.StaffPunch.count({ where: { scannerId: s.id, outcome: 'pending' } })) await scanners.processPending(s);
    // The relay sends punches from a day before go-live onwards (in the
    // scanner's own local time), never the scanner's whole history.
    const since = new Date(new Date(s.goLiveAt).getTime() - 24 * 3600 * 1000);
    return success(res, { pollSeconds: POLL_SECONDS, sinceLocal: clinicDateTime(since), serverTime: new Date().toISOString() });
  } catch (err) {
    console.error('HrScanner.heartbeat error:', err);
    return error(res, 'Heartbeat failed', 500);
  }
};

// ZKTeco verify codes: 1 fingerprint; 2 and 4 card. Anything else is kept as a
// fingerprint-scanner punch with its code stored (verifyCode) for the record.
const sourceOfVerify = (code) => ([2, 4].includes(Number(code)) ? 'card' : 'fingerprint');

/** POST /api/hr/scanner-relay/punches — new punches read from the scanner. */
const punches = async (req, res) => {
  try {
    const list = req.body?.punches;
    if (!Array.isArray(list)) return error(res, 'punches must be a list', 400);
    if (list.length > MAX_BATCH) return error(res, `At most ${MAX_BATCH} punches per batch`, 413);
    const parsed = [];
    let rejected = 0;
    for (const p of list) {
      const userNo = String(p?.userNo ?? '').trim();
      const at = clinicLocalToInstant(p?.time);
      if (!/^\d{1,24}$/.test(userNo) || !at) { rejected += 1; continue; }
      const verifyCode = Number.isFinite(Number(p.verify)) ? Number(p.verify) : null;
      parsed.push({ userNo, at, verifyCode, source: sourceOfVerify(verifyCode) });
    }
    const result = await scanners.ingestPunches(req.scanner, parsed);
    await req.scanner.update({ lastSeenAt: new Date() });
    console.log(`[HR] scanner ${req.scanner.serial}: ${result.received} received, ${result.stored} new, ${JSON.stringify(result.counts)}`);
    return success(res, { ...result, rejected });
  } catch (err) {
    console.error('HrScanner.punches error:', err);
    return error(res, 'The punches could not be stored. The relay will send them again.', 500);
  }
};

// ---------------------------------------------------------------------
// HR
// ---------------------------------------------------------------------

/** GET /api/hr/scanners/status — the Online / Offline pill (anyone who checks in). */
const status = async (req, res) => {
  try {
    const now = new Date();
    const rows = await HrScanner.findAll({ where: { status: 'active' }, order: [['id', 'ASC']] });
    return success(res, rows.map((s) => ({ id: s.id, label: s.label, online: scanners.isOnline(s, now), lastSeenAt: s.lastSeenAt, lastPunchAt: s.lastPunchAt })));
  } catch (err) {
    console.error('HrScanner.status error:', err);
    return error(res, 'Failed to load scanner status', 500);
  }
};

/** GET /api/hr/scanners */
const list = async (req, res) => {
  try {
    const now = new Date();
    const rows = await HrScanner.findAll({ order: [['id', 'ASC']] });
    const waiting = await db.StaffPunch.findAll({
      where: { outcome: 'unlinked', scannerId: { [Op.in]: rows.map((r) => r.id).concat(0) } },
      attributes: ['scannerId', [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'n']],
      group: ['scannerId'], raw: true,
    });
    const waitingBy = new Map(waiting.map((w) => [w.scannerId, Number(w.n)]));
    return success(res, rows.map((s) => ({ ...serializeScanner(s, now), waiting: waitingBy.get(s.id) || 0 })));
  } catch (err) {
    console.error('HrScanner.list error:', err);
    return error(res, 'Failed to load scanners', 500);
  }
};

/** POST /api/hr/scanners — register a scanner; returns its key ONCE. */
const create = async (req, res) => {
  try {
    const serial = String(req.body.serial).trim().toUpperCase();
    if (await HrScanner.findOne({ where: { serial } })) return error(res, 'A scanner with that serial number is already registered.', 409);
    const goLiveAt = req.body.goLiveAt ? new Date(req.body.goLiveAt) : new Date();
    if (Number.isNaN(goLiveAt.getTime())) return error(res, 'The go-live time is not valid', 400);
    const key = newKey();
    const s = await HrScanner.create({
      serial, label: String(req.body.label).trim(), location: req.body.location ? String(req.body.location).trim() : null,
      keyHash: sha256(key), keySetAt: new Date(), goLiveAt, status: 'active', createdById: req.user.id,
    });
    recordSettingChanges({ user: req.user, area: AREA, before: {}, after: snapshot(s), fields: auditFields(s), secretsChanged: ['key'] });
    return success(res, { ...serializeScanner(s), key }, 201);
  } catch (err) {
    console.error('HrScanner.create error:', err);
    return error(res, 'Failed to register the scanner', 500);
  }
};

/** PATCH /api/hr/scanners/:id — name, location, accepting punches, go-live. */
const update = async (req, res) => {
  try {
    const s = await HrScanner.findByPk(req.params.id);
    if (!s) return error(res, 'Scanner not found', 404);
    const before = snapshot(s);
    const patch = {};
    if (req.body.label !== undefined) patch.label = String(req.body.label).trim();
    if (req.body.location !== undefined) patch.location = req.body.location ? String(req.body.location).trim() : null;
    if (req.body.status !== undefined) {
      if (!['active', 'stopped'].includes(req.body.status)) return error(res, 'Status must be active or stopped', 400);
      patch.status = req.body.status;
    }
    let goLiveMoved = false;
    if (req.body.goLiveAt !== undefined) {
      const d = new Date(req.body.goLiveAt);
      if (Number.isNaN(d.getTime())) return error(res, 'The go-live time is not valid', 400);
      // Minute precision: the settings form sends minutes, so saving a new name
      // must not count as moving go-live (and re-check every punch).
      goLiveMoved = Math.floor(d.getTime() / 60000) !== Math.floor(new Date(s.goLiveAt).getTime() / 60000);
      if (goLiveMoved) patch.goLiveAt = d;
    }
    await s.update(patch);
    recordSettingChanges({ user: req.user, area: AREA, before, after: snapshot(s), fields: auditFields(s) });
    if (goLiveMoved) await scanners.reprocessGoLive(s);
    return success(res, serializeScanner(s));
  } catch (err) {
    console.error('HrScanner.update error:', err);
    return error(res, 'Failed to save the scanner', 500);
  }
};

/** POST /api/hr/scanners/:id/key — replace the relay key; returns it ONCE. */
const replaceKey = async (req, res) => {
  try {
    const s = await HrScanner.findByPk(req.params.id);
    if (!s) return error(res, 'Scanner not found', 404);
    const key = newKey();
    await s.update({ keyHash: sha256(key), keySetAt: new Date() });
    recordSettingChanges({ user: req.user, area: AREA, before: { key: true }, after: {}, fields: { key: auditFields(s).key }, secretsChanged: ['key'] });
    return success(res, { ...serializeScanner(s), key });
  } catch (err) {
    console.error('HrScanner.replaceKey error:', err);
    return error(res, 'Failed to replace the key', 500);
  }
};

/** The settings tab's table, and the staff it can link to. */
const usersPayload = async (s) => ({ users: await scanners.usersFor(s), staff: await scanners.staffOptions() });

/** GET /api/hr/scanners/:id/users */
const users = async (req, res) => {
  try {
    const s = await HrScanner.findByPk(req.params.id);
    if (!s) return error(res, 'Scanner not found', 404);
    return success(res, await usersPayload(s));
  } catch (err) {
    console.error('HrScanner.users error:', err);
    return error(res, 'Failed to load the scanner users', 500);
  }
};

const linkLabel = (s, u) => `Scanner ID ${u.userNo} on ${s.label}`;

/** Link one scanner user (the person must be active staff, not linked elsewhere on this scanner). */
const linkOne = async (req, s, u, staffId) => {
  const target = await User.findByPk(staffId, { attributes: ['id', 'firstName', 'lastName', 'role', 'isActive'] });
  if (!target || !target.isActive || !STAFF_ROLES.includes(target.role)) return { status: 404, message: 'Staff member not found' };
  // A link puts every punch of that scanner ID on the person's attendance, so
  // it needs the same right as amending their attendance (and its scope).
  if (!(await hrScope.canActOn(req.user, PERMISSIONS.HR_ATTENDANCE_AMEND, target.id))) {
    return { status: 403, message: 'Linking a scanner ID needs the right to amend this person\'s attendance.' };
  }
  const taken = await HrScannerUser.findOne({ where: { scannerId: s.id, UserId: target.id, status: 'linked', id: { [Op.ne]: u.id } } });
  if (taken) return { status: 409, message: `${target.firstName} is already linked to scanner ID ${taken.userNo}.` };
  const previous = u.status === 'linked' ? u.UserId : null;
  if (previous === target.id) return { ok: true };
  await u.update({ status: 'linked', UserId: target.id, linkedById: req.user.id, linkedAt: new Date() });
  await svc.writeUserEditLog({ targetUserId: target.id, actor: req.user, changes: { scannerLink: { from: null, to: linkLabel(s, u) } } });
  if (previous) await svc.writeUserEditLog({ targetUserId: previous, actor: req.user, changes: { scannerLink: { from: linkLabel(s, u), to: null } } });
  await scanners.reprocessUser(s, u, previous);
  return { ok: true };
};

/** PATCH /api/hr/scanners/:id/users/:userId — { action: 'link', staffId } | { action: 'unlink' } | { action: 'ignore' } */
const setLink = async (req, res) => {
  try {
    const s = await HrScanner.findByPk(req.params.id);
    if (!s) return error(res, 'Scanner not found', 404);
    const u = await HrScannerUser.findOne({ where: { id: req.params.userId, scannerId: s.id } });
    if (!u) return error(res, 'Scanner user not found', 404);
    const { action } = req.body;
    if (action === 'link') {
      const r = await linkOne(req, s, u, req.body.staffId);
      if (!r.ok) return error(res, r.message, r.status);
    } else if (action === 'unlink' || action === 'ignore') {
      const previous = u.status === 'linked' ? u.UserId : null;
      if (previous && !(await hrScope.canActOn(req.user, PERMISSIONS.HR_ATTENDANCE_AMEND, previous))) {
        return error(res, 'Unlinking needs the right to amend this person\'s attendance.', 403);
      }
      await u.update({ status: action === 'ignore' ? 'ignored' : 'unlinked', UserId: null, linkedById: req.user.id, linkedAt: null });
      if (previous) await svc.writeUserEditLog({ targetUserId: previous, actor: req.user, changes: { scannerLink: { from: linkLabel(s, u), to: null } } });
      await scanners.reprocessUser(s, u, previous);
    } else {
      return error(res, 'action must be link, unlink or ignore', 400);
    }
    return success(res, await usersPayload(s));
  } catch (err) {
    console.error('HrScanner.setLink error:', err);
    return error(res, 'Failed to save the link', 500);
  }
};

/** POST /api/hr/scanners/:id/users/confirm-matches — link every proposal in one click. */
const confirmMatches = async (req, res) => {
  try {
    const s = await HrScanner.findByPk(req.params.id);
    if (!s) return error(res, 'Scanner not found', 404);
    const rows = await scanners.usersFor(s);
    let linked = 0;
    for (const r of rows.filter((x) => x.proposal)) {
      const u = await HrScannerUser.findByPk(r.id);
      const result = await linkOne(req, s, u, r.proposal.id);
      if (result.ok) linked += 1;
    }
    return success(res, { linked, ...(await usersPayload(s)) });
  } catch (err) {
    console.error('HrScanner.confirmMatches error:', err);
    return error(res, 'Failed to confirm the matches', 500);
  }
};

module.exports = { heartbeat, punches, status, list, create, update, replaceKey, users, setLink, confirmMatches };
