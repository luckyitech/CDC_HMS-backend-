const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { canActForPatient } = require('../utils/patientFamily');
const { clinicToday, clinicDatePlusDays } = require('../utils/clinicTime');
const { naiveToDate, dateToNaive } = require('../utils/glucoseTime');
const { matchWindow } = require('../utils/glucoseMatching');
const db = require('../models');

const { PatientDiaryEvent, User } = db;

// Glucose Management Centre — patient diary controller.
//
// Mounted by routes/glucose.js under /api/patients/:uhid/glucose/diary, so it
// inherits the same merge-aware findPatient resolution, access logging and
// authorization as the rest of the glucose module. The diary is what gives a
// meter reading meal context: after any change here the server re-runs the
// time-matcher over the affected window (utils/glucoseMatching.js), which
// writes pre-/post-meal tags onto nearby meter readings without ever touching
// their values or times.
//
// Reads use req.patientIds (merge-aware); writes use req.patient.id and refuse
// a deactivated record. Attribution is from the JWT, never the client (A4).

const EVENT_TYPES = ['meal', 'activity', 'insulin', 'oral_med', 'symptom', 'note'];

const userName = (u) => (u ? `${u.role === 'doctor' ? 'Dr. ' : ''}${u.firstName} ${u.lastName}` : null);
const userInclude = { model: User, as: 'enteredBy', attributes: ['firstName', 'lastName', 'role'] };

// MariaDB returns JSON columns as strings (MySQL 8 returns parsed objects), so
// parse defensively — `detail` must always reach the client and the matcher as
// an object, never a string.
const parseDetail = (d) => {
  if (d === null || d === undefined) return null;
  if (typeof d === 'object') return d;
  try { const o = JSON.parse(d); return o && typeof o === 'object' ? o : null; } catch { return null; }
};

const formatEvent = (e) => ({
  id: e.id,
  eventType: e.eventType,
  occurredAt: dateToNaive(e.occurredAt),
  label: e.label || null,
  detail: parseDetail(e.detail),
  enteredByRole: e.enteredByRole,
  enteredByName: userName(e.enteredBy),
  createdAt: e.createdAt,
});

// Re-match the meter readings around a diary event (±6 h comfortably covers
// the ±3 h meal windows). Merge-aware — the whole family's ids.
const rematchAround = async (patientIds, occurredNaive) => {
  const d = naiveToDate(occurredNaive);
  if (!d) return;
  const from = dateToNaive(new Date(d.getTime() - 6 * 3600 * 1000));
  const to = dateToNaive(new Date(d.getTime() + 6 * 3600 * 1000));
  try { await matchWindow(patientIds, from, to); } catch (e) { console.error('Diary.rematch error:', e); }
};

// The window the client asked for (?days | ?from&to), clinic dates inclusive.
const windowFrom = (query) => {
  const today = clinicToday();
  if (query.from && query.to) return { from: String(query.from), to: String(query.to) };
  const days = Math.min(Math.max(parseInt(query.days, 10) || 14, 1), 366);
  return { from: clinicDatePlusDays(-(days - 1)), to: today };
};

// ====================================
// GET /api/patients/:uhid/glucose/diary?days=14 | from&to
// ====================================
const listDiary = async (req, res) => {
  try {
    if (!canActForPatient(req)) return error(res, 'Access denied', 403);
    const win = windowFrom(req.query);
    const rows = await PatientDiaryEvent.findAll({
      where: {
        PatientId: { [Op.in]: req.patientIds },
        status: 'Active',
        occurredAt: { [Op.between]: [naiveToDate(`${win.from} 00:00:00`), naiveToDate(`${win.to} 23:59:59`)] },
      },
      include: [userInclude],
      order: [['occurredAt', 'DESC']],
    });
    return success(res, rows.map(formatEvent));
  } catch (err) {
    console.error('Diary.list error:', err);
    return error(res, 'Failed to load the diary', 500);
  }
};

// ====================================
// POST /api/patients/:uhid/glucose/diary
// Body: { eventType, occurredAt:'YYYY-MM-DD HH:mm:ss', label?, detail? }
// ====================================
const createDiary = async (req, res) => {
  try {
    if (!canActForPatient(req)) return error(res, 'Access denied', 403);
    if (req.isDeactivated) return error(res, 'This patient profile is inactive.', 403);

    const eventType = String(req.body.eventType || '').trim();
    if (!EVENT_TYPES.includes(eventType)) return error(res, 'Unknown diary event type', 400);
    const occurred = naiveToDate(req.body.occurredAt);
    if (!occurred) return error(res, 'occurredAt must be YYYY-MM-DD HH:mm:ss', 400);
    const detail = req.body.detail && typeof req.body.detail === 'object' && !Array.isArray(req.body.detail) ? req.body.detail : null;

    const row = await PatientDiaryEvent.create({
      PatientId: req.patient.id,
      eventType,
      occurredAt: occurred,
      label: req.body.label ? String(req.body.label).slice(0, 120) : null,
      detail,
      enteredById: req.user.id,
      enteredByRole: req.user.role === 'patient' ? 'patient' : 'clinic',
      status: 'Active',
    });

    if (eventType === 'meal') await rematchAround(req.patientIds, dateToNaive(occurred));

    const fresh = await PatientDiaryEvent.findByPk(row.id, { include: [userInclude] });
    return success(res, formatEvent(fresh), 201);
  } catch (err) {
    console.error('Diary.create error:', err);
    return error(res, 'Failed to save the diary entry', 500);
  }
};

// ====================================
// PUT /api/patients/:uhid/glucose/diary/:id
// A patient may edit their own entries; clinic users may edit any in the family.
// ====================================
const updateDiary = async (req, res) => {
  try {
    if (!canActForPatient(req)) return error(res, 'Access denied', 403);
    if (req.isDeactivated) return error(res, 'This patient profile is inactive.', 403);
    const row = await PatientDiaryEvent.findOne({ where: { id: req.params.id, PatientId: { [Op.in]: req.patientIds }, status: 'Active' } });
    if (!row) return error(res, 'Diary entry not found', 404);

    const oldOccurred = dateToNaive(row.occurredAt);
    const wasMeal = row.eventType === 'meal';

    if (req.body.eventType !== undefined) {
      const et = String(req.body.eventType).trim();
      if (!EVENT_TYPES.includes(et)) return error(res, 'Unknown diary event type', 400);
      row.eventType = et;
    }
    if (req.body.occurredAt !== undefined) {
      const occurred = naiveToDate(req.body.occurredAt);
      if (!occurred) return error(res, 'occurredAt must be YYYY-MM-DD HH:mm:ss', 400);
      row.occurredAt = occurred;
    }
    if (req.body.label !== undefined) row.label = req.body.label ? String(req.body.label).slice(0, 120) : null;
    if (req.body.detail !== undefined) row.detail = req.body.detail && typeof req.body.detail === 'object' && !Array.isArray(req.body.detail) ? req.body.detail : null;
    await row.save();

    // Re-match both the old and the new position if a meal was involved.
    if (wasMeal || row.eventType === 'meal') {
      await rematchAround(req.patientIds, oldOccurred);
      const newOccurred = dateToNaive(row.occurredAt);
      if (newOccurred !== oldOccurred) await rematchAround(req.patientIds, newOccurred);
    }

    const fresh = await PatientDiaryEvent.findByPk(row.id, { include: [userInclude] });
    return success(res, formatEvent(fresh));
  } catch (err) {
    console.error('Diary.update error:', err);
    return error(res, 'Failed to update the diary entry', 500);
  }
};

// ====================================
// DELETE /api/patients/:uhid/glucose/diary/:id  — soft-delete
// ====================================
const deleteDiary = async (req, res) => {
  try {
    if (!canActForPatient(req)) return error(res, 'Access denied', 403);
    if (req.isDeactivated) return error(res, 'This patient profile is inactive.', 403);
    const row = await PatientDiaryEvent.findOne({ where: { id: req.params.id, PatientId: { [Op.in]: req.patientIds }, status: 'Active' } });
    if (!row) return error(res, 'Diary entry not found', 404);
    const occurred = dateToNaive(row.occurredAt);
    const wasMeal = row.eventType === 'meal';
    Object.assign(row, { status: 'Deleted', deletedAt: new Date() });
    await row.save();
    if (wasMeal) await rematchAround(req.patientIds, occurred);
    return success(res, { id: row.id, deleted: true });
  } catch (err) {
    console.error('Diary.delete error:', err);
    return error(res, 'Failed to delete the diary entry', 500);
  }
};

module.exports = { listDiary, createDiary, updateDiary, deleteDiary };
