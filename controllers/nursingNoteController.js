const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { resolvePatient } = require('../utils/patientFamily');
const { clinicToday, clinicClockTime } = require('../utils/clinicTime');
const { PERMISSIONS, hasPermission } = require('../constants/permissions');
const db = require('../models');

const { NursingNote, Patient, User } = db;

const formatNote = (note) => {
  const n = note.dataValues || note;
  return {
    id:         n.id,
    uhid:       n.Patient?.uhid || null,
    authorName: n.author ? `${n.author.firstName} ${n.author.lastName}` : null,
    authorRole: n.authorRole,
    authorId:   n.authorId,          // lets the client show remove only to those allowed
    date:       n.date,
    time:       n.time,
    data:       n.data,
    action:     n.action,
    response:   n.response,
    createdAt:  n.createdAt,
  };
};

const noteIncludes = [
  { model: Patient, attributes: ['uhid', 'firstName', 'lastName'] },
  { model: User, as: 'author', attributes: ['firstName', 'lastName'] },
];

/**
 * POST /api/nursing-notes
 * Add one DAR entry to a patient's Kardex. date/time and author come from the
 * server/JWT — never the client. Merge-aware: writes go to the canonical patient.
 */
const create = async (req, res) => {
  try {
    const { uhid, data, action, response } = req.body;
    if (![data, action, response].some((f) => typeof f === 'string' && f.trim())) {
      return error(res, 'A nursing note needs at least one of Data, Action or Response', 400);
    }

    const family = await resolvePatient(uhid);
    if (!family) return error(res, `Patient ${uhid} not found`, 404);
    if (family.isDeactivated) return error(res, 'This patient profile is inactive. No new notes can be added.', 403);

    const now = new Date();
    const note = await NursingNote.create({
      PatientId:  family.patient.id,   // PascalCase FK
      authorId:   req.user.id,         // From JWT token
      authorRole: req.user.role,       // Snapshot at write time
      date:       clinicToday(now),
      time:       clinicClockTime({}, now),
      data:       (data || '').trim() || null,
      action:     (action || '').trim() || null,
      response:   (response || '').trim() || null,
      status:     'active',
    });

    const full = await NursingNote.findByPk(note.id, { include: noteIncludes });
    return success(res, formatNote(full), 201);
  } catch (err) {
    console.error('NursingNote.create error:', err);
    return error(res, 'Failed to add nursing note', 500);
  }
};

/**
 * GET /api/nursing-notes?uhid=
 * The patient's Kardex, oldest first so it reads as a running record.
 * Merge-aware: reads span the whole patient family.
 */
const list = async (req, res) => {
  try {
    const { uhid } = req.query;
    if (!uhid) return error(res, 'Patient UHID is required', 400);

    const family = await resolvePatient(uhid);
    if (!family) return error(res, 'Patient not found', 404);

    const rows = await NursingNote.findAll({
      where: { PatientId: { [Op.in]: family.patientIds }, status: 'active' },
      include: noteIncludes,
      order: [['date', 'ASC'], ['createdAt', 'ASC']],
    });

    return success(res, { nursingNotes: rows.map(formatNote) });
  } catch (err) {
    console.error('NursingNote.list error:', err);
    return error(res, 'Failed to retrieve nursing notes', 500);
  }
};

/**
 * DELETE /api/nursing-notes/:id
 * Soft delete — author or admin only. The row stays in the table with
 * status 'deleted' so the record is never truly lost.
 */
const remove = async (req, res) => {
  try {
    const { id } = req.params;
    const note = await NursingNote.findByPk(id);
    if (!note || note.status !== 'active') return error(res, `Nursing note ${id} not found`, 404);

    if (!hasPermission(req.user, PERMISSIONS.ADMIN_ACCESS) && note.authorId !== req.user.id) {
      return error(res, 'You can only remove your own nursing notes', 403);
    }

    note.status = 'deleted';
    await note.save();
    return success(res, { message: 'Nursing note removed', id: note.id });
  } catch (err) {
    console.error('NursingNote.remove error:', err);
    return error(res, 'Failed to remove nursing note', 500);
  }
};

module.exports = { create, list, remove };
