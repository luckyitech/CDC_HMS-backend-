const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { resolvePatient } = require('../utils/patientFamily');
const { clinicToday } = require('../utils/clinicTime');
const { changeMode, diff } = require('../utils/dermRules');
const dermExam = require('../utils/dermExam');
const { sequelize, User, Patient, DermSkinExam, DermEdit } = require('../models');

// =====================================================================
// Dermatology — Today's whole-skin exam (9 Oct 2026, Emu; decision S1).
//
// Hair, nails, lymph nodes and mucosa belong to the patient that day, not to
// one finding: one DermSkinExams row per patient per clinic day. Merge-aware:
// read across the family, written to the canonical patient, refused on an
// inactive (merged-away) file. Author from the JWT. The author may change it
// the same day; anyone else (or later) amends it with a reason, kept in
// DermEdits (entity 'skin_exam'). Never deleted.
// =====================================================================

const USER_ATTRS = ['id', 'firstName', 'lastName', 'role'];
const userName = (u) => (u ? `${u.role === 'doctor' ? 'Dr ' : ''}${u.firstName} ${u.lastName}`.trim() : null);
const MANY = new Set(dermExam.EXAM_FIELDS.filter((f) => f.kind === 'many').map((f) => f.key));
const parse = (t) => { try { return JSON.parse(t); } catch { return {}; } };

const formatExam = (e) => {
  if (!e) return null;
  const out = { id: e.id, patientId: e.PatientId, visitDate: e.visitDate, status: e.status };
  for (const k of dermExam.SKIN_EXAM_KEYS) {
    const v = e[k];
    if (dermExam.EXAM_SWITCHES.includes(k)) out[k] = !!v;
    else if (MANY.has(k)) out[k] = dermExam.listOf(v);
    else out[k] = v === undefined ? null : v;
  }
  out.doctorId = e.doctorId;
  out.doctorName = userName(e.doctor);
  out.amendedByName = userName(e.amendedBy);
  out.amendedAt = e.amendedAt;
  out.updatedAt = e.updatedAt;
  out.sections = dermExam.skinExamSections(out);
  return out;
};

const INCLUDE = [
  { model: User, as: 'doctor', attributes: USER_ATTRS },
  { model: User, as: 'amendedBy', attributes: USER_ATTRS },
];

/** The family's exam for a day — the canonical file's row first. */
const examFor = async (family, date, transaction) => {
  const rows = await DermSkinExam.findAll({
    where: { PatientId: { [Op.in]: family.patientIds }, visitDate: date, status: 'active' },
    include: INCLUDE, order: [['id', 'ASC']], transaction,
  });
  return rows.find((r) => r.PatientId === family.patient.id) || rows[0] || null;
};

const editsFor = async (examId) => {
  if (!examId) return [];
  const rows = await DermEdit.findAll({
    where: { entity: 'skin_exam', entityId: examId, action: 'amend' },
    include: [{ model: User, as: 'editedBy', attributes: USER_ATTRS }],
    order: [['createdAt', 'ASC'], ['id', 'ASC']],
  });
  return rows.map((r) => ({ when: r.createdAt, by: userName(r.editedBy), reason: r.reason, changes: parse(r.changes) }));
};

// ---------------------------------------------------------------------
// GET /api/derm/patients/:uhid/skin-exam?date=YYYY-MM-DD (default today)
// ---------------------------------------------------------------------
const getSkinExam = async (req, res) => {
  try {
    const family = await resolvePatient(req.params.uhid);
    if (!family) return error(res, 'Patient not found', 404);
    const today = clinicToday();
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : today;
    const row = await examFor(family, date);
    return success(res, {
      today, date, exam: formatExam(row), amendments: await editsFor(row?.id),
      mode: row ? changeMode({ doctorId: row.doctorId, visitDate: row.visitDate }, req.user.id, today) : 'new',
    });
  } catch (err) {
    console.error('DermSkinExam.get error:', err);
    return error(res, 'Server error', 500);
  }
};

// ---------------------------------------------------------------------
// PUT /api/derm/patients/:uhid/skin-exam — record or correct TODAY's exam
// ---------------------------------------------------------------------
// None yet → created (author from the JWT). Mine from today → changed in
// place. Someone else's today → 409 SOMEONE_ELSE_TODAY (they amend instead).
const saveSkinExam = async (req, res) => {
  try {
    const family = await resolvePatient(req.params.uhid);
    if (!family) return error(res, 'Patient not found', 404);
    if (family.isDeactivated) return error(res, 'This patient file is inactive (merged). Open the active file.', 403);

    const clean = dermExam.cleanSkinExam(req.body);
    if (!clean.ok) return error(res, clean.message, 400, { field: clean.field });

    const today = clinicToday();
    await sequelize.transaction(async (transaction) => {
      const existing = await examFor(family, today, transaction);
      if (existing && changeMode({ doctorId: existing.doctorId, visitDate: existing.visitDate }, req.user.id, today) !== 'edit') {
        const err = new Error('someone else today'); err.code = 'SOMEONE_ELSE_TODAY'; throw err;
      }
      if (existing) await existing.update(clean.value, { transaction });
      else await DermSkinExam.create({ ...clean.value, PatientId: family.patient.id, visitDate: today, doctorId: req.user.id }, { transaction });
    });
    req.query.date = today;
    return getSkinExam(req, res);
  } catch (err) {
    if (err.code === 'SOMEONE_ELSE_TODAY') {
      return error(res, 'Another doctor already recorded today\'s whole-skin exam. Amend their entry instead (a reason is needed).', 409, { code: 'SOMEONE_ELSE_TODAY' });
    }
    if (err.name === 'SequelizeUniqueConstraintError') {
      return error(res, 'Today\'s whole-skin exam was just saved by someone else. Reload and amend it.', 409, { code: 'SOMEONE_ELSE_TODAY' });
    }
    console.error('DermSkinExam.save error:', err);
    return error(res, 'Server error', 500);
  }
};

// ---------------------------------------------------------------------
// PUT /api/derm/skin-exams/:id — amend (reason required; kept in DermEdits)
// ---------------------------------------------------------------------
// The whole exam is sent (as when saving); every field that changed goes to
// the trail with before → after. The author stays the author.
const amendSkinExam = async (req, res) => {
  try {
    const row = await DermSkinExam.findByPk(req.params.id, { include: INCLUDE });
    if (!row || row.status !== 'active') return error(res, 'Entry not found', 404);
    // The exam sits under the file it was written to; after a merge it is
    // amended through the active (canonical) file.
    let owner = await Patient.findByPk(row.PatientId, { attributes: ['id', 'uhid', 'mergedIntoId'] });
    if (owner && owner.mergedIntoId) owner = await Patient.findByPk(owner.mergedIntoId, { attributes: ['id', 'uhid', 'mergedIntoId'] });
    const family = owner ? await resolvePatient(owner.uhid) : null;
    if (!family) return error(res, 'Patient not found', 404);
    if (family.isDeactivated) return error(res, 'This patient file is inactive (merged). Open the active file.', 403);

    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) return error(res, 'Give a reason for amending this entry', 400, { code: 'REASON_REQUIRED' });

    const clean = dermExam.cleanSkinExam(req.body);
    if (!clean.ok) return error(res, clean.message, 400, { field: clean.field });

    const before = { ...row.get({ plain: true }) };
    for (const k of dermExam.EXAM_SWITCHES) before[k] = !!before[k];
    const changes = diff(before, clean.value, dermExam.SKIN_EXAM_KEYS);
    if (!Object.keys(changes).length) return error(res, 'Nothing was changed', 400, { code: 'NO_CHANGE' });

    await sequelize.transaction(async (transaction) => {
      await row.update({ ...clean.value, amendedById: req.user.id, amendedAt: new Date() }, { transaction });
      await DermEdit.create({
        entity: 'skin_exam', entityId: row.id, action: 'amend',
        changes: JSON.stringify(changes), reason: reason.slice(0, 500), editedById: req.user.id,
      }, { transaction });
    });
    req.params.uhid = family.patient.uhid;
    req.query.date = row.visitDate;
    return getSkinExam(req, res);
  } catch (err) {
    console.error('DermSkinExam.amend error:', err);
    return error(res, 'Server error', 500);
  }
};

module.exports = { getSkinExam, saveSkinExam, amendSkinExam, formatExam, examFor, INCLUDE };
