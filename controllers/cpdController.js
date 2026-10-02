// CPD — continuing professional development. B27 phase 5 (decision D12, 29 Sep).
//
// Self (/api/hr/me/cpd, routes/hrSelf.js, hr.self): a person logs their own CPD
// with points and an optional certificate, and edits or deletes an entry only
// while it is still pending. Every self action is on req.user.id — no route
// names a person.
//
// HR (/api/hr/cpd, routes/hr.js, cpd.verify): the queue of pending entries,
// and verify (optionally adjusting the points) or reject with a note. Verifying
// stamps and LOCKS the row; the person is notified. Nobody's points count until
// HR has verified them (mockup 5A/5B).
//
// Counted per CALENDAR YEAR against a per-cadre target (utils/hrConfig
// hr.cpd.targets). The progress bar counts VERIFIED points only; pending points
// are shown apart. The rules are pure: utils/cpd.

const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { clinicToday } = require('../utils/clinicTime');
const { validateCpd, summariseCpd, cadreForRole, CPD_CATEGORIES } = require('../utils/cpd');
const { getHrConfig } = require('../utils/hrConfig');
const { resolveStoredFile } = require('../utils/staffDocumentStorage');
const hrNotify = require('../services/hrNotify');
const hrScope = require('../services/hrScope');
const { PERMISSIONS } = require('../constants/permissions');
const db = require('../models');

const { CpdActivity, StaffDocument, User, StaffProfile } = db;

const fullName = (u) => (u ? `${u.firstName} ${u.lastName}`.trim() : null);
const CERT_CATEGORY = 'Training Certificate';

const CPD_MESSAGES = {
  TITLE_REQUIRED: 'Give the activity a title.',
  BAD_DATE: 'Choose a valid date.',
  BAD_POINTS: 'Give the points as a number.',
};

const shape = (a) => ({
  id: a.id,
  date: String(a.date).slice(0, 10),
  title: a.title,
  provider: a.provider,
  category: a.category,
  points: Number(a.points),
  status: a.status,
  note: a.note,
  verifiedAt: a.verifiedAt,
  verifiedBy: a.verifiedBy ? fullName(a.verifiedBy) : null,
  document: a.document ? { id: a.document.id, fileName: a.document.fileName } : null,
  person: a.User ? {
    id: a.User.id,
    name: fullName(a.User),
    role: a.User.role,
    employeeId: a.User.StaffProfile?.employeeId || null,
  } : undefined,
});

const selfIncludes = () => [
  { model: User, as: 'verifiedBy', attributes: ['firstName', 'lastName'], required: false },
  { model: StaffDocument, as: 'document', attributes: ['id', 'fileName'], required: false },
];
const hrIncludes = () => [
  ...selfIncludes(),
  { model: User, attributes: ['id', 'firstName', 'lastName', 'role'], include: [{ model: StaffProfile, attributes: ['employeeId'], required: false }] },
];

/** An own, live Training-Certificate document id, or null; false if it isn't the person's. */
const ownCertificate = async (userId, documentId) => {
  if (documentId === undefined || documentId === null || documentId === '') return null;
  const id = Number(documentId);
  if (!Number.isInteger(id) || id < 1) return false;
  const doc = await StaffDocument.findOne({ where: { id, UserId: userId, isArchived: false }, attributes: ['id'] });
  return doc ? id : false;
};

const targetFor = async (role) => {
  const cfg = await getHrConfig();
  return Number(cfg.cpdTargets?.[cadreForRole(role)] || 0);
};

// ---------------------------------------------------------------------------
// Self — hr.self
// ---------------------------------------------------------------------------

/**
 * One person's CPD for a calendar year + the summary. ONE builder for My
 * profile (self) and the HR staff file's Credentials tab (read-only).
 */
const yearFor = async (person, yearParam) => {
  const year = parseInt(yearParam, 10) || Number(clinicToday().slice(0, 4));
  const rows = await CpdActivity.findAll({
    where: {
      UserId: person.id,
      status: { [Op.ne]: 'archived' },
      date: { [Op.between]: [`${year}-01-01`, `${year}-12-31`] },
    },
    include: selfIncludes(),
    order: [['date', 'DESC'], ['id', 'DESC']],
  });
  const target = await targetFor(person.role);
  return {
    year,
    categories: CPD_CATEGORIES,
    activities: rows.map(shape),
    summary: summariseCpd(rows.map((r) => ({ status: r.status, points: r.points })), target),
  };
};

/** GET /api/hr/me/cpd?year= — my CPD for a calendar year + the summary. */
const list = async (req, res) => {
  try {
    return success(res, await yearFor(req.user, req.query.year));
  } catch (err) {
    console.error('Cpd.list error:', err);
    return error(res, 'Failed to load your CPD', 500);
  }
};

/**
 * GET /api/staff/:employeeId/cpd?year= — READ-ONLY, on the staff file's
 * Credentials tab (B27 debt fix, 2 Oct 2026). Same gate as the rest of the
 * staff file (users.view or the person themselves — adminOrSelf at the route).
 * CPD is a professional record, not health data. Verifying stays on
 * /hr/requests (cpd.verify); the certificate is on the Documents tab.
 */
const staffList = async (req, res) => {
  try {
    return success(res, await yearFor(req.staffUser, req.query.year));
  } catch (err) {
    console.error('Cpd.staffList error:', err);
    return error(res, 'Failed to load CPD', 500);
  }
};

/** POST /api/hr/me/cpd { date, title, provider, category, points, documentId? } */
const create = async (req, res) => {
  const v = validateCpd(req.body || {});
  if (!v.ok) return error(res, CPD_MESSAGES[v.error] || 'Check the entry', 400, { code: v.error });
  try {
    const cert = await ownCertificate(req.user.id, req.body?.documentId);
    if (cert === false) return error(res, 'That certificate isn\'t one of your documents', 400, { code: 'BAD_DOCUMENT' });
    const row = await CpdActivity.create({
      UserId: req.user.id, ...v.value, documentId: cert, status: 'pending',
    });
    await row.reload({ include: selfIncludes() });
    return success(res, shape(row), 201);
  } catch (err) {
    console.error('Cpd.create error:', err);
    return error(res, 'Failed to log the activity', 500);
  }
};

/** PATCH /api/hr/me/cpd/:id — edit, while it is still pending. */
const update = async (req, res) => {
  const v = validateCpd(req.body || {});
  if (!v.ok) return error(res, CPD_MESSAGES[v.error] || 'Check the entry', 400, { code: v.error });
  try {
    const row = await CpdActivity.findOne({ where: { id: Number(req.params.id), UserId: req.user.id } });
    if (!row) return error(res, 'Activity not found', 404);
    if (row.status !== 'pending') return error(res, 'Once HR has checked an activity it can\'t be changed', 400, { code: 'NOT_PENDING' });
    const cert = await ownCertificate(req.user.id, req.body?.documentId);
    if (cert === false) return error(res, 'That certificate isn\'t one of your documents', 400, { code: 'BAD_DOCUMENT' });
    await row.update({ ...v.value, documentId: cert });
    await row.reload({ include: selfIncludes() });
    return success(res, shape(row));
  } catch (err) {
    console.error('Cpd.update error:', err);
    return error(res, 'Failed to update the activity', 500);
  }
};

/** DELETE /api/hr/me/cpd/:id — remove, while it is still pending. */
const remove = async (req, res) => {
  try {
    const row = await CpdActivity.findOne({ where: { id: Number(req.params.id), UserId: req.user.id } });
    if (!row) return error(res, 'Activity not found', 404);
    if (row.status !== 'pending') return error(res, 'Once HR has checked an activity it can\'t be removed', 400, { code: 'NOT_PENDING' });
    await row.destroy();
    return success(res, { id: row.id, deleted: true });
  } catch (err) {
    console.error('Cpd.remove error:', err);
    return error(res, 'Failed to remove the activity', 500);
  }
};

// ---------------------------------------------------------------------------
// HR — cpd.verify (was hr.credentials)
// ---------------------------------------------------------------------------

/** GET /api/hr/cpd?status=pending|decided&year= — the verify queue. */
const hrList = async (req, res) => {
  const decided = req.query.status === 'decided';
  try {
    const where = {
      status: decided ? { [Op.in]: ['verified', 'rejected'] } : 'pending',
      // HR Tier 3 Phase 1: a department-limited verifier sees only their people.
      ...(await hrScope.scopeWhere(req.user, PERMISSIONS.CPD_VERIFY)),
    };
    if (req.query.year) {
      const y = parseInt(req.query.year, 10);
      where.date = { [Op.between]: [`${y}-01-01`, `${y}-12-31`] };
    }
    const rows = await CpdActivity.findAll({
      where,
      include: hrIncludes(),
      order: [[decided ? 'verifiedAt' : 'createdAt', decided ? 'DESC' : 'ASC']],
      limit: 300,
    });
    return success(res, rows.map(shape));
  } catch (err) {
    console.error('Cpd.hrList error:', err);
    return error(res, 'Failed to load CPD to verify', 500);
  }
};

/** GET /api/hr/cpd/count — pending (the sidebar/tab badge). */
const hrCount = async (req, res) => {
  try {
    const n = await CpdActivity.count({ where: { status: 'pending', ...(await hrScope.scopeWhere(req.user, PERMISSIONS.CPD_VERIFY)) } });
    return success(res, { pending: n });
  } catch (err) {
    console.error('Cpd.hrCount error:', err);
    return error(res, 'Failed to count CPD', 500);
  }
};

/**
 * PATCH /api/hr/cpd/:id/verify { decision: 'verify'|'reject', points?, note? }
 * Verify stamps and locks the row (HR may adjust the points first). Reject
 * needs a note the person sees. The person is notified; the notice carries no
 * clinical content.
 */
const verify = async (req, res) => {
  const decision = req.body?.decision;
  const note = typeof req.body?.note === 'string' && req.body.note.trim() ? req.body.note.trim().slice(0, 2000) : null;
  if (!['verify', 'reject'].includes(decision)) return error(res, 'Choose verify or reject', 400);
  if (decision === 'reject' && !note) return error(res, 'Say why it is rejected', 400, { code: 'NOTE_REQUIRED' });

  let points;
  if (decision === 'verify' && req.body?.points !== undefined && req.body.points !== null && req.body.points !== '') {
    points = Number(req.body.points);
    if (!Number.isFinite(points) || points < 0 || points > 9999.9) return error(res, 'Give the points as a number', 400, { code: 'BAD_POINTS' });
    points = Math.round(points * 10) / 10;
  }

  try {
    const row = await CpdActivity.findByPk(Number(req.params.id));
    if (!row || !(await hrScope.canActOn(req.user, PERMISSIONS.CPD_VERIFY, row.UserId))) return error(res, 'Activity not found', 404);
    if (row.status !== 'pending') return error(res, 'This activity has already been decided', 400, { code: 'NOT_PENDING' });

    await row.update({
      status: decision === 'verify' ? 'verified' : 'rejected',
      points: decision === 'verify' && points !== undefined ? points : row.points,
      verifiedById: req.user.id,
      verifiedAt: new Date(),
      note,
    });

    const actor = await User.findByPk(req.user.id, { attributes: ['id', 'firstName', 'lastName'] });
    await hrNotify.notify('change_request_decided', {
      recipients: [row.UserId],
      title: decision === 'verify' ? 'Your CPD activity was verified' : 'Your CPD activity was not approved',
      body: decision === 'verify' ? `${Number(row.points)} point${Number(row.points) === 1 ? '' : 's'} added to your CPD.` : 'Open the HMS to see why.',
      link: '/hr/me?tab=credentials',
      actorName: fullName(actor),
    });

    await row.reload({ include: hrIncludes() });
    return success(res, shape(row));
  } catch (err) {
    console.error('Cpd.verify error:', err);
    return error(res, 'Failed to record the decision', 500);
  }
};

/**
 * GET /api/hr/cpd/:id/certificate — the certificate, for cpd.verify, so HR
 * can check it before verifying. Streams from private/ like the leave attachment.
 */
const certificate = async (req, res) => {
  try {
    const row = await CpdActivity.findByPk(Number(req.params.id), { include: [{ model: StaffDocument, as: 'document' }] });
    if (!row || !row.document || row.document.isArchived
        || !(await hrScope.canActOn(req.user, PERMISSIONS.CPD_VERIFY, row.UserId))) return error(res, 'No certificate on this activity', 404);
    const resolved = resolveStoredFile(row.document.filePath);
    if (!resolved) return error(res, 'File is missing from the server', 404);
    return res.download(resolved, row.document.fileName);
  } catch (err) {
    console.error('Cpd.certificate error:', err);
    return error(res, 'Failed to load the certificate', 500);
  }
};

module.exports = {
  list, staffList, create, update, remove,
  hrList, hrCount, verify, certificate,
  // tests
  shape,
};
