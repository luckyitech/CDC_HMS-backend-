// =====================================================================
// HR Suite (B21) — Time & Attendance controller.
//
// tap()     the only thing that can check a person in or out by NFC
// mine / mySummary   the person's own record (hr.checkin)
// today / list       everyone's (hr.view)
// manual / amend     HR corrections with a mandatory reason (hr.write),
//                    written to the person's UserEditLog
//
// Nothing on a web page checks anyone in: `tap` needs a fresh, signed tag
// URL; the check-OUT confirmation re-posts a short-lived token the server
// only issues after a verified tap (so the single-use tag URL is not replayed
// by the confirm), and it can only close that user's own open session.
// =====================================================================

const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');
const db = require('../models');
const { success, error } = require('../utils/response');
const { clinicToday } = require('../utils/clinicTime');
const { getHrConfig } = require('../utils/hrConfig');
const { verifySun } = require('../utils/ntag424');
const { decrypt } = require('../utils/crypto');
const { decide, punctuality, starFor, clinicHHMM, minutesBetween } = require('../utils/attendanceRules');
const { buildTapMessages, titleFor } = require('../utils/tapMessages');
const { buildChanges } = require('../utils/auditChanges');
const { parseJsonColumn } = require('../utils/jsonColumn');
const { canViewHr } = require('../utils/hrAccess');
const svc = require('../services/hrAttendanceService');

const { sequelize, StaffAttendance, HrNfcTag, User, StaffProfile, StaffLeave, StaffWorkHours } = db;

const CONFIRM_TTL = '10m';

const clientIp = (req) =>
  (req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.socket?.remoteAddress || null);

const geoOf = (geo, cfg) => {
  if (cfg.geo !== 'log' || !geo || typeof geo !== 'object') return { lat: null, lng: null, accuracy: null };
  const lat = Number(geo.lat), lng = Number(geo.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return { lat: null, lng: null, accuracy: null };
  return { lat: lat.toFixed(6), lng: lng.toFixed(6), accuracy: Number.isFinite(Number(geo.accuracy)) ? Math.round(Number(geo.accuracy)) : null };
};

const personSnippet = (user) => ({ firstName: user.firstName, title: titleFor(user), name: `${user.firstName} ${user.lastName}` });

/** The month block the tap page and the dashboard both render. */
const monthBlock = async (userId, cfg, now) => {
  const m = await svc.monthDataFor(userId, clinicToday(now).slice(0, 7), cfg, now);
  return {
    month: m.month, calendar: m.calendar, stars: m.stars, streakNoRed: m.streakNoRed,
    lateCount: m.table.lateCount, earlyOutCount: m.table.earlyOutCount,
  };
};

const refusedRow = async ({ user, now, clinicDate, ip, ua, ctr, reason, tag, deviceId }) => {
  await StaffAttendance.create({
    UserId: user.id, clinicDate, checkInAt: now,
    checkInMethod: 'nfc', checkInVerification: 'refused', status: 'refused',
    checkInIp: ip, checkInTagId: tag ? tag.id : null, deviceId, createdById: user.id,
    checkInPunctuality: 'none', checkOutPunctuality: 'none',
    diagnostics: { ua, ctr, reason },
  });
};

// ---------------------------------------------------------------------
// POST /api/hr/attendance/tap
// ---------------------------------------------------------------------
const tap = async (req, res) => {
  let transaction;
  try {
    const cfg = await getHrConfig();
    const now = new Date();
    const clinicDate = clinicToday(now);
    const me = await User.findByPk(req.user.id, { attributes: ['id', 'firstName', 'lastName', 'role'] });
    if (!me) return error(res, 'User not found', 404);
    const ip = clientIp(req);
    const ua = (req.headers['user-agent'] || '').slice(0, 255) || null;
    const deviceId = req.user.deviceId || null;
    const geo = geoOf(req.body.geo, cfg);

    // --- Which path: a fresh tag URL, or the check-out confirmation token?
    let tag = null;
    let counter = null;
    let ctrHex = null;
    let confirm = false;
    if (req.body.confirmToken) {
      let claim;
      try { claim = jwt.verify(String(req.body.confirmToken), process.env.JWT_SECRET); } catch { claim = null; }
      if (!claim || claim.t !== 'hr-confirm' || claim.u !== me.id) {
        return error(res, 'That confirmation has expired — please tap the tag again.', 400);
      }
      tag = await HrNfcTag.findByPk(claim.tagId, { attributes: { exclude: ['keyEncrypted'] } });
      ctrHex = claim.ctr;
      confirm = true;
    } else {
      const uid = String(req.body.uid || '').toUpperCase();
      ctrHex = String(req.body.ctr || '').toUpperCase();
      const cmac = String(req.body.cmac || '').toUpperCase();

      tag = await HrNfcTag.findOne({ where: { uid, status: 'active' } });
      if (!tag) {
        await refusedRow({ user: me, now, clinicDate, ip, ua, ctr: ctrHex, reason: 'unknown_tag', tag: null, deviceId });
        console.log(`[HR] tap user=${me.id} tag=${uid} action=refused reason=unknown_tag`);
        return success(res, { action: 'refused', reason: 'unknown_tag', person: personSnippet(me), messages: buildTapMessages({ action: 'refused', user: me, now }) });
      }
      const v = verifySun({ uidHex: uid, ctrHex, cmacHex: cmac, keyHex: decrypt(tag.keyEncrypted) });
      if (!v.ok) {
        await refusedRow({ user: me, now, clinicDate, ip, ua, ctr: ctrHex, reason: 'bad_signature', tag, deviceId });
        console.log(`[HR] tap user=${me.id} tag=${uid} action=refused reason=bad_signature`);
        return success(res, { action: 'refused', reason: 'bad_signature', person: personSnippet(me), tag: { label: tag.label }, messages: buildTapMessages({ action: 'refused', user: me, now }) });
      }
      counter = v.counter;
    }

    transaction = await sequelize.transaction();

    if (!confirm) {
      // Replay check under a row lock: two phones cannot both spend one counter.
      const locked = await HrNfcTag.findByPk(tag.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (counter <= locked.lastCounter) {
        await transaction.rollback(); transaction = null;
        await refusedRow({ user: me, now, clinicDate, ip, ua, ctr: ctrHex, reason: 'replayed_counter', tag, deviceId });
        console.log(`[HR] tap user=${me.id} tag=${tag.uid} action=refused reason=replayed_counter`);
        return success(res, { action: 'refused', reason: 'replayed_counter', person: personSnippet(me), tag: { label: tag.label }, messages: buildTapMessages({ action: 'refused', user: me, now }) });
      }
      await locked.update({ lastCounter: counter, lastTapAt: now }, { transaction });
    }

    const last = await svc.lastSessionToday(me.id, clinicDate, transaction);
    const action = decide({ now, lastSession: last, confirm, cfg });
    // Phase 1: IP/geo are logged, never enforced, so every verified tap is 'verified'.
    const verification = 'verified';
    let session = last;
    let punct = null;
    let star = null;
    let outAction = action;
    let confirmToken = null;

    if (action === 'checkin') {
      const expected = await svc.expectedFor(me.id, clinicDate, cfg);
      const earlier = await svc.hasEarlierSessionToday(me.id, clinicDate, transaction);
      punct = earlier ? { state: 'none', minutes: null } : punctuality({ at: now, expectedAt: expected.startAt, graceMinutes: expected.grace, kind: 'in' });
      session = await StaffAttendance.create({
        UserId: me.id, clinicDate, checkInAt: now,
        checkInMethod: 'nfc', checkInVerification: verification, checkInTagId: tag.id,
        checkInIp: ip, checkInLat: geo.lat, checkInLng: geo.lng, deviceId,
        expectedInAt: expected.startAt, expectedOutAt: expected.endAt,
        checkInPunctuality: punct.state, lateMinutes: punct.state === 'late' ? punct.minutes : (expected.startAt ? 0 : null),
        checkOutPunctuality: 'none', status: 'open', createdById: me.id,
        diagnostics: { ua, ctr: ctrHex, geoAccuracy: geo.accuracy, hoursSource: expected.source },
      }, { transaction });
      star = { side: 'in', colour: starFor('in', punct.state) };
      outAction = 'checked_in';
    } else if (action === 'offer_checkout') {
      punct = punctuality({ at: now, expectedAt: last.expectedOutAt, graceMinutes: cfg.graceMinutes, kind: 'out' });
      confirmToken = jwt.sign({ t: 'hr-confirm', u: me.id, tagId: tag.id, ctr: ctrHex }, process.env.JWT_SECRET, { expiresIn: CONFIRM_TTL });
    } else if (action === 'checkout') {
      punct = punctuality({ at: now, expectedAt: last.expectedOutAt, graceMinutes: cfg.graceMinutes, kind: 'out' });
      const diag = parseJsonColumn(last.diagnostics) || {};
      await last.update({
        checkOutAt: now, checkOutMethod: 'nfc', checkOutVerification: verification, checkOutTagId: tag.id,
        checkOutIp: ip, checkOutLat: geo.lat, checkOutLng: geo.lng,
        checkOutPunctuality: punct.state, earlyOutMinutes: punct.state === 'early' ? punct.minutes : (last.expectedOutAt ? 0 : null),
        status: 'closed',
        diagnostics: { ...diag, outUa: ua, outCtr: ctrHex, outGeoAccuracy: geo.accuracy },
      }, { transaction });
      session = last;
      star = { side: 'out', colour: starFor('out', punct.state) };
      outAction = 'checked_out';
    }
    // 'duplicate' → nothing written

    await transaction.commit(); transaction = null;

    const needsMonth = outAction === 'checked_in' || outAction === 'checked_out' || outAction === 'offer_checkout';
    const month = needsMonth ? await monthBlock(me.id, cfg, now) : null;
    const duplicateSide = outAction === 'duplicate' && last && last.status !== 'open' ? 'out' : 'in';
    const messages = buildTapMessages({
      action: outAction, user: me, session: session ? session.get({ plain: true }) : null, punct, month,
      now, positiveFeedback: cfg.positiveFeedback, duplicateSide,
    });
    console.log(`[HR] tap user=${me.id} tag=${tag.uid} action=${outAction}`);

    return success(res, {
      action: outAction,
      session: session ? svc.serializeSession(session) : null,
      star,
      tag: { label: tag.label },
      person: personSnippet(me),
      month,
      messages,
      confirmToken,
      now: now.toISOString(),
      nowHHMM: clinicHHMM(now),
    });
  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch { /* ignore */ } }
    console.error('StaffAttendance.tap error:', err);
    return error(res, 'The tap could not be recorded. Please try again.', 500);
  }
};

// ---------------------------------------------------------------------
// The person's own record
// ---------------------------------------------------------------------
const rangeOf = (req) => {
  const today = clinicToday();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : `${today.slice(0, 7)}-01`;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : today;
  return { from, to };
};

const mine = async (req, res) => {
  try {
    const { from, to } = rangeOf(req);
    const rows = await StaffAttendance.findAll({
      where: { UserId: req.user.id, clinicDate: { [Op.between]: [from, to] }, status: { [Op.ne]: 'voided' } },
      include: svc.SESSION_INCLUDE, order: [['checkInAt', 'DESC']],
    });
    const cfg = await getHrConfig();
    const today = clinicToday();
    const expected = await svc.expectedFor(req.user.id, today, cfg);
    const open = rows.find((r) => r.clinicDate === today && r.status === 'open');
    if (req.query.format === 'csv') return sendCsv(res, rows, `my-attendance-${from}-${to}.csv`);
    return success(res, {
      from, to,
      rows: rows.map(svc.serializeSession),
      today: { clinicDate: today, expected: { start: expected.start, end: expected.end, grace: expected.grace, source: expected.source }, open: open ? svc.serializeSession(open) : null },
    });
  } catch (err) {
    console.error('StaffAttendance.mine error:', err);
    return error(res, 'Failed to load your attendance', 500);
  }
};

const mySummary = async (req, res) => {
  try {
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : clinicToday().slice(0, 7);
    const cfg = await getHrConfig();
    const data = await svc.monthDataFor(req.user.id, month, cfg);
    return success(res, data);
  } catch (err) {
    console.error('StaffAttendance.mySummary error:', err);
    return error(res, 'Failed to load your month', 500);
  }
};

// ---------------------------------------------------------------------
// HR: today at the clinic
// ---------------------------------------------------------------------
const today = async (req, res) => {
  try {
    const cfg = await getHrConfig();
    const now = new Date();
    const clinicDate = clinicToday(now);
    const users = (await svc.internalUsers()).filter((u) => !u.StaffProfile || !u.StaffProfile.deletedAt);
    const ids = users.map((u) => u.id);

    const [hoursRows, leaves, todayRows, missed] = await Promise.all([
      StaffWorkHours.findAll({ where: { UserId: { [Op.in]: ids }, status: 'active' } }),
      StaffLeave.findAll({ where: { UserId: { [Op.in]: ids }, status: 'Approved', startDate: { [Op.lte]: clinicDate }, endDate: { [Op.gte]: clinicDate } }, attributes: ['UserId'] }),
      StaffAttendance.findAll({ where: { clinicDate, UserId: { [Op.in]: ids } }, include: svc.SESSION_INCLUDE, order: [['checkInAt', 'ASC']] }),
      StaffAttendance.findAll({ where: { status: 'missed_checkout' }, include: svc.SESSION_INCLUDE, order: [['clinicDate', 'DESC']], limit: 50 }),
    ]);
    const hoursBy = new Map();
    for (const r of hoursRows) { const l = hoursBy.get(r.UserId) || []; l.push(r.get({ plain: true })); hoursBy.set(r.UserId, l); }
    const onLeave = new Set(leaves.map((l) => l.UserId));
    const byUser = new Map();
    for (const r of todayRows) { const l = byUser.get(r.UserId) || []; l.push(r); byUser.set(r.UserId, l); }

    const people = [];
    const counts = { inNow: 0, total: users.length, notYetIn: 0, lateToday: 0, flaggedToday: 0, refusedToday: 0, missedCheckouts: missed.length };
    for (const u of users) {
      const expected = await svc.expectedFor(u.id, clinicDate, cfg, hoursBy.get(u.id) || []);
      const sessions = (byUser.get(u.id) || []).filter((r) => ['open', 'closed', 'missed_checkout'].includes(r.status));
      const refused = (byUser.get(u.id) || []).filter((r) => r.status === 'refused');
      const flagged = (byUser.get(u.id) || []).some((r) => r.checkInVerification === 'flagged' || r.checkOutVerification === 'flagged');
      const open = sessions.find((r) => r.status === 'open');
      const last = sessions[sessions.length - 1];
      let state, lateMinutes = 0;
      if (open) state = 'in';
      else if (last) state = 'out';
      else if (onLeave.has(u.id)) state = 'on_leave';
      else if (!expected.startAt) state = 'off';
      else { state = 'not_in'; lateMinutes = Math.max(0, minutesBetween(expected.startAt, now)); }
      const first = sessions[0];
      const lateIn = first && first.checkInPunctuality === 'late';
      if (state === 'in') counts.inNow += 1;
      if (state === 'not_in') counts.notYetIn += 1;
      if (lateIn) counts.lateToday += 1;
      if (flagged) counts.flaggedToday += 1;
      counts.refusedToday += refused.length;
      people.push({
        person: svc.personOf(u),
        state, lateMinutes, flagged,
        expected: { start: expected.start, end: expected.end },
        session: (open || last) ? svc.serializeSession(open || last) : null,
        lateIn: lateIn ? first.lateMinutes : 0,
        refusedCount: refused.length,
      });
    }

    const attention = [
      ...missed.map((r) => ({ kind: 'missed_checkout', session: svc.serializeSession(r) })),
      ...todayRows.filter((r) => r.checkInVerification === 'flagged' || r.checkOutVerification === 'flagged').map((r) => ({ kind: 'flagged', session: svc.serializeSession(r) })),
      ...todayRows.filter((r) => r.status === 'refused').map((r) => ({ kind: 'refused', session: svc.serializeSession(r) })),
    ];

    return success(res, { clinicDate, now: now.toISOString(), counts, people, attention });
  } catch (err) {
    console.error('StaffAttendance.today error:', err);
    return error(res, 'Failed to load today', 500);
  }
};

// ---------------------------------------------------------------------
// HR: the register
// ---------------------------------------------------------------------
const STATUS_FILTERS = {
  flagged:   { [Op.or]: [{ checkInVerification: 'flagged' }, { checkOutVerification: 'flagged' }] },
  missed:    { status: 'missed_checkout' },
  refused:   { status: 'refused' },
  late:      { checkInPunctuality: 'late' },
  early_out: { checkOutPunctuality: 'early' },
  open:      { status: 'open' },
  voided:    { status: 'voided' },
};

const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const sendCsv = (res, rows, filename) => {
  const headers = ['Date', 'Person', 'Employee ID', 'Role', 'In', 'Out', 'Hours', 'In star', 'Out star', 'Late min', 'Early-out min', 'Method', 'Verification', 'Door', 'Status', 'Amended by'];
  const lines = rows.map(svc.serializeSession).map((s) => [
    s.clinicDate, s.person?.name, s.person?.employeeId, s.person?.role, s.checkInHHMM, s.checkOutHHMM,
    s.minutesWorked == null ? '' : `${Math.floor(s.minutesWorked / 60)}:${String(s.minutesWorked % 60).padStart(2, '0')}`,
    starFor('in', s.checkInPunctuality) || '', starFor('out', s.checkOutPunctuality) || '',
    s.lateMinutes ?? '', s.earlyOutMinutes ?? '', s.checkInMethod, s.checkInVerification, s.door || '', s.status, s.amendedBy || '',
  ].map(csvCell).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.status(200).send(`﻿${[headers.join(','), ...lines].join('\r\n')}`);
};

const list = async (req, res) => {
  try {
    const { from, to } = rangeOf(req);
    const where = { clinicDate: { [Op.between]: [from, to] } };
    if (req.query.userId) where.UserId = parseInt(req.query.userId, 10);
    if (req.query.status && STATUS_FILTERS[req.query.status]) Object.assign(where, STATUS_FILTERS[req.query.status]);
    else if (!req.query.status) where.status = { [Op.ne]: 'voided' };
    const include = svc.SESSION_INCLUDE.map((i) => ({ ...i }));
    if (req.query.role) include[0] = { ...include[0], where: { role: req.query.role } };
    const rows = await StaffAttendance.findAll({ where, include, order: [['clinicDate', 'DESC'], ['checkInAt', 'DESC']], limit: 5000 });
    if (req.query.format === 'csv') return sendCsv(res, rows, `time-attendance-${from}-${to}.csv`);
    const people = new Set(rows.map((r) => r.UserId));
    return success(res, { from, to, count: rows.length, people: people.size, rows: rows.map(svc.serializeSession) });
  } catch (err) {
    console.error('StaffAttendance.list error:', err);
    return error(res, 'Failed to load the register', 500);
  }
};

// ---------------------------------------------------------------------
// HR: corrections
// ---------------------------------------------------------------------
const parseWhen = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };

const manual = async (req, res) => {
  let transaction;
  try {
    const { userId, reason } = req.body;
    const checkInAt = parseWhen(req.body.checkInAt);
    const checkOutAt = req.body.checkOutAt ? parseWhen(req.body.checkOutAt) : null;
    if (!checkInAt) return error(res, 'A valid check-in time is required', 400);
    if (req.body.checkOutAt && !checkOutAt) return error(res, 'The check-out time is not valid', 400);
    if (checkOutAt && checkOutAt <= checkInAt) return error(res, 'Check-out must be after check-in', 400);
    if (checkInAt > new Date()) return error(res, 'A check-in cannot be in the future', 400);
    const target = await User.findByPk(userId, { attributes: ['id', 'firstName', 'lastName', 'role', 'isActive'] });
    if (!target) return error(res, 'Staff member not found', 404);

    const cfg = await getHrConfig();
    const clinicDate = clinicToday(checkInAt);
    const expected = await svc.expectedFor(target.id, clinicDate, cfg);
    const pIn = punctuality({ at: checkInAt, expectedAt: expected.startAt, graceMinutes: expected.grace, kind: 'in' });
    const pOut = checkOutAt ? punctuality({ at: checkOutAt, expectedAt: expected.endAt, graceMinutes: expected.grace, kind: 'out' }) : { state: 'none', minutes: null };

    transaction = await sequelize.transaction();
    const row = await StaffAttendance.create({
      UserId: target.id, clinicDate, checkInAt, checkOutAt,
      checkInMethod: 'manual', checkOutMethod: checkOutAt ? 'manual' : null,
      checkInVerification: 'manual', checkOutVerification: checkOutAt ? 'manual' : null,
      expectedInAt: expected.startAt, expectedOutAt: expected.endAt,
      checkInPunctuality: pIn.state, lateMinutes: pIn.state === 'late' ? pIn.minutes : (expected.startAt ? 0 : null),
      checkOutPunctuality: pOut.state, earlyOutMinutes: pOut.state === 'early' ? pOut.minutes : (checkOutAt && expected.endAt ? 0 : null),
      status: checkOutAt ? 'closed' : 'open',
      amendedById: req.user.id, amendedAt: new Date(), amendReason: reason,
      createdById: req.user.id,
      diagnostics: { manual: true },
    }, { transaction });
    await svc.writeUserEditLog({
      targetUserId: target.id, actor: req.user, transaction,
      changes: { attendanceManualEntry: { from: null, to: `${clinicDate} ${clinicHHMM(checkInAt)}–${checkOutAt ? clinicHHMM(checkOutAt) : '…'}` }, reason: { from: null, to: reason } },
    });
    await transaction.commit(); transaction = null;
    const full = await StaffAttendance.findByPk(row.id, { include: svc.SESSION_INCLUDE });
    return success(res, svc.serializeSession(full), 201);
  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch { /* ignore */ } }
    console.error('StaffAttendance.manual error:', err);
    return error(res, 'Failed to record the entry', 500);
  }
};

const amend = async (req, res) => {
  let transaction;
  try {
    const row = await StaffAttendance.findByPk(req.params.id);
    if (!row) return error(res, 'Session not found', 404);
    if (row.status === 'refused') return error(res, 'A refused tap cannot be amended — record a manual entry instead', 400);
    const { reason } = req.body;
    const before = { checkInAt: row.checkInAt, checkOutAt: row.checkOutAt, status: row.status };
    const after = { ...before };

    if (req.body.checkInAt !== undefined) { const d = parseWhen(req.body.checkInAt); if (!d) return error(res, 'The check-in time is not valid', 400); after.checkInAt = d; }
    if (req.body.checkOutAt !== undefined) {
      if (req.body.checkOutAt === null || req.body.checkOutAt === '') after.checkOutAt = null;
      else { const d = parseWhen(req.body.checkOutAt); if (!d) return error(res, 'The check-out time is not valid', 400); after.checkOutAt = d; }
    }
    if (req.body.status !== undefined) {
      if (!['closed', 'voided', 'open'].includes(req.body.status)) return error(res, 'Status must be closed, open or voided', 400);
      after.status = req.body.status;
    }
    if (after.checkOutAt && after.checkOutAt <= after.checkInAt) return error(res, 'Check-out must be after check-in', 400);
    if (after.status !== 'voided') {
      if (after.checkOutAt) after.status = 'closed';
      else if (after.status === 'closed') return error(res, 'A closed session needs a check-out time', 400);
      else if (row.status === 'missed_checkout' && !after.checkOutAt) after.status = 'missed_checkout';
    }

    const cfg = await getHrConfig();
    const clinicDate = clinicToday(after.checkInAt);
    const expected = await svc.expectedFor(row.UserId, clinicDate, cfg);
    const pIn = punctuality({ at: after.checkInAt, expectedAt: expected.startAt, graceMinutes: expected.grace, kind: 'in' });
    const pOut = after.checkOutAt ? punctuality({ at: after.checkOutAt, expectedAt: expected.endAt, graceMinutes: expected.grace, kind: 'out' }) : { state: 'none', minutes: null };

    const changes = buildChanges(
      { checkInAt: before.checkInAt, checkOutAt: before.checkOutAt, status: before.status },
      { checkInAt: after.checkInAt, checkOutAt: after.checkOutAt, status: after.status },
    );
    if (!Object.keys(changes).length) return error(res, 'Nothing changed', 400);

    transaction = await sequelize.transaction();
    await row.update({
      checkInAt: after.checkInAt, checkOutAt: after.checkOutAt, clinicDate, status: after.status,
      checkOutMethod: after.checkOutAt ? (row.checkOutMethod || 'manual') : null,
      checkOutVerification: after.checkOutAt ? (row.checkOutVerification || 'manual') : null,
      expectedInAt: expected.startAt, expectedOutAt: expected.endAt,
      checkInPunctuality: row.checkInPunctuality === 'none' && !expected.startAt ? 'none' : pIn.state,
      lateMinutes: pIn.state === 'late' ? pIn.minutes : (expected.startAt ? 0 : null),
      checkOutPunctuality: pOut.state, earlyOutMinutes: pOut.state === 'early' ? pOut.minutes : (after.checkOutAt && expected.endAt ? 0 : null),
      amendedById: req.user.id, amendedAt: new Date(), amendReason: reason,
    }, { transaction });
    await svc.writeUserEditLog({ targetUserId: row.UserId, actor: req.user, transaction, changes: { ...changes, reason: { from: null, to: reason } } });
    await transaction.commit(); transaction = null;
    const full = await StaffAttendance.findByPk(row.id, { include: svc.SESSION_INCLUDE });
    return success(res, svc.serializeSession(full));
  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch { /* ignore */ } }
    console.error('StaffAttendance.amend error:', err);
    return error(res, 'Failed to amend the session', 500);
  }
};

/** GET /api/hr/attendance/:id — one row; own rows for everyone, any row for hr.view. */
const getOne = async (req, res) => {
  try {
    const row = await StaffAttendance.findByPk(req.params.id, { include: svc.SESSION_INCLUDE });
    if (!row) return error(res, 'Session not found', 404);
    if (row.UserId !== req.user.id && !canViewHr(req.user)) return error(res, 'You do not have permission to do that.', 403);
    return success(res, svc.serializeSession(row));
  } catch (err) {
    console.error('StaffAttendance.getOne error:', err);
    return error(res, 'Failed to load the session', 500);
  }
};

module.exports = { tap, mine, mySummary, today, list, manual, amend, getOne };
