const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { resolvePatient } = require('../utils/patientFamily');
const db = require('../models');

const { Glp1WeekNote, Glp1Therapy, Patient, User } = db;

// Notes may be added while a course is still running. A stopped course is a
// closed record.
const LIVE_STATUSES = ['Active', 'Paused'];

// ====================================
// HELPER FUNCTIONS
// ====================================

// "Dr." only for doctors — a nurse's note should not be titled one.
const authorName = (user) => {
  if (!user) return null;
  const prefix = user.role === 'doctor' ? 'Dr. ' : '';
  return `${prefix}${user.firstName} ${user.lastName}`;
};

const noteIncludes = [
  { model: User, as: 'author', attributes: ['firstName', 'lastName', 'role'] },
];

/**
 * Formats one week note for the API response.
 *
 * authorRole is the snapshot taken at write time; the frontend maps it to the
 * Nurse / Doctor badge. authorName is derived from the live user record for
 * display and carries the Dr. prefix for doctors.
 */
const formatNote = (note) => {
  const n = note.dataValues || note;
  return {
    id:         n.id,
    therapyId:  n.Glp1TherapyId,
    weekNumber: n.weekNumber,
    body:       n.body,
    authorId:   n.authorId,          // lets the client show delete only to those allowed
    authorRole: n.authorRole,
    authorName: authorName(n.author),
    status:     n.status,
    createdAt:  n.createdAt,
  };
};

/**
 * Loads a therapy and applies the merge-aware rules.
 * Returns { therapy, family } or { err }.
 */
const loadTherapy = async (therapyId, { requireLive = true } = {}) => {
  const therapy = await Glp1Therapy.findByPk(therapyId, {
    include: [{ model: Patient, attributes: ['uhid'] }],
  });

  if (!therapy) return { err: { message: `GLP-1 therapy with ID ${therapyId} not found`, code: 404 } };

  if (requireLive && !LIVE_STATUSES.includes(therapy.status)) {
    return { err: { message: `This course is ${therapy.status.toLowerCase()} — no further notes can be added`, code: 403 } };
  }

  const family = await resolvePatient(therapy.Patient?.uhid);
  if (!family) return { err: { message: 'Patient not found', code: 404 } };
  if (family.isDeactivated) {
    return { err: { message: 'This patient profile is inactive. No changes can be recorded.', code: 403 } };
  }

  return { therapy, family };
};

// ====================================
// CONTROLLER ACTIONS
// ====================================

/**
 * GET /api/glp1-week-notes
 * Lists per-week notes for a course, or for a patient.
 *
 * Query parameters — one of:
 * - therapyId
 * - uhid (merge-aware, across courses)
 * Optional: weekNumber to narrow to one week.
 *
 * Removed notes are excluded unless includeDeleted=true.
 *
 * Authorization: doctor, staff
 */
const list = async (req, res) => {
  try {
    const { therapyId, uhid, weekNumber, includeDeleted } = req.query;

    if (!therapyId && !uhid) {
      return error(res, 'Either a therapyId or a patient UHID is required', 400);
    }

    const where = {};
    if (includeDeleted !== 'true') where.status = 'active';
    if (weekNumber !== undefined) where.weekNumber = weekNumber;

    if (therapyId) {
      where.Glp1TherapyId = therapyId;
    } else {
      const family = await resolvePatient(uhid);
      if (!family) return error(res, `Patient ${uhid} not found`, 404);
      where.PatientId = { [Op.in]: family.patientIds };   // merge-aware read
    }

    const notes = await Glp1WeekNote.findAll({
      where,
      include: noteIncludes,
      order: [['weekNumber', 'ASC'], ['id', 'ASC']],
    });

    return success(res, { notes: notes.map(formatNote) });
  } catch (err) {
    console.error('Glp1WeekNote.list error:', err);
    return error(res, 'Failed to retrieve week notes', 500);
  }
};

/**
 * POST /api/glp1-week-notes
 * Adds a note to one week.
 *
 * Authorization: doctor, staff — a nurse records the injection note, a doctor
 * the clinical note. Both land in the same table, told apart by authorRole.
 *
 * Request body:
 * - therapyId, weekNumber, body (required)
 *
 * Controller auto-sets:
 * - authorId and authorRole from the JWT, never the client
 * - PatientId denormalised from the therapy, for merge-aware reads
 */
const create = async (req, res) => {
  try {
    const { therapyId, weekNumber, body } = req.body;

    const text = typeof body === 'string' ? body.trim() : '';
    if (!text) return error(res, 'A note cannot be empty', 400);

    const loaded = await loadTherapy(therapyId);
    if (loaded.err) return error(res, loaded.err.message, loaded.err.code);

    const { therapy, family } = loaded;

    const note = await Glp1WeekNote.create({
      Glp1TherapyId: therapy.id,
      PatientId:     family.patient.id,   // PascalCase FK, denormalised
      weekNumber,
      authorId:      req.user.id,         // From JWT token
      authorRole:    req.user.role,       // Snapshot at write time
      body:          text,
      status:        'active',
    });

    const full = await Glp1WeekNote.findByPk(note.id, { include: noteIncludes });

    return success(res, formatNote(full), 201);
  } catch (err) {
    console.error('Glp1WeekNote.create error:', err);
    return error(res, 'Failed to add the note', 500);
  }
};

/**
 * DELETE /api/glp1-week-notes/:id
 * Removes a note — soft delete only. The row stays and flips to 'deleted'.
 *
 * Authorization: doctor, staff at the route. Ownership is enforced here: a nurse
 * may remove only a note they wrote; a doctor may remove any, so a clinical
 * record can be corrected without hunting down whoever typed it.
 */
const remove = async (req, res) => {
  try {
    const { id } = req.params;

    const note = await Glp1WeekNote.findByPk(id);
    if (!note) return error(res, `Note with ID ${id} not found`, 404);
    if (note.status === 'deleted') {
      return error(res, 'This note has already been removed', 410);
    }

    // Merge-aware guard and an inactive-patient check.
    const loaded = await loadTherapy(note.Glp1TherapyId, { requireLive: false });
    if (loaded.err) return error(res, loaded.err.message, loaded.err.code);

    // Ownership: doctors may remove any note; everyone else only their own.
    if (req.user.role !== 'doctor' && note.authorId !== req.user.id) {
      return error(res, 'You can only remove a note you wrote', 403);
    }

    note.status    = 'deleted';
    note.deletedBy = req.user.id;   // From JWT token
    note.deletedAt = new Date();
    await note.save();

    return success(res, { message: `Note removed from week ${note.weekNumber}`, id: note.id });
  } catch (err) {
    console.error('Glp1WeekNote.remove error:', err);
    return error(res, 'Failed to remove the note', 500);
  }
};

// ====================================
// EXPORTS
// ====================================
module.exports = {
  list,
  create,
  remove,
  formatNote,
  noteIncludes,
};
