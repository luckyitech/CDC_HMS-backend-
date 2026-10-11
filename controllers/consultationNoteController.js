const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { resolvePatient } = require('../utils/patientFamily');
const { clinicToday, clinicClockTime } = require('../utils/clinicTime');
const { PERMISSIONS, hasPermission } = require('../constants/permissions');
const db = require('../models');
const { cleanSections, renderNoteText, htmlToText } = require('../utils/noteSections');
const noteSections = require('../services/noteSections');

const { ConsultationNote, Patient, User, sequelize } = db;

// ====================================
// HELPER FUNCTIONS
// ====================================

/**
 * Formats a single consultation note for the API response.
 */
const formatConsultationNote = (note) => {
  const n = note.dataValues || note;
  return {
    id: n.id,
    uhid: n.Patient?.uhid || null,
    patientName: n.Patient
      ? `${n.Patient.firstName} ${n.Patient.lastName}`
      : null,
    doctorName: n.doctor
      ? `Dr. ${n.doctor.firstName} ${n.doctor.lastName}`
      : null,
    // doctorId + createdAt let the consultation editor find THIS doctor's note
    // for THIS visit (created after the queue check-in), instead of any note
    // dated today — two check-ins on one day must not overwrite each other.
    doctorId: n.doctorId,
    createdAt: n.createdAt,
    date: n.date,
    time: n.time,
    notes: n.notes,
    vitals: n.vitals,
    assessment: n.assessment,
    plan: n.plan,
    prescriptionIds: n.prescriptionIds,
    // History sections (10 Oct 2026) — [] for a note written before them
    sections: n.sections || [],
  };
};

/** Attach each note's sections (one query for the whole page). */
const withSections = async (notes) => {
  const list = Array.isArray(notes) ? notes : [notes];
  const byNote = await noteSections.loadSections(list.map((n) => n.id));
  list.forEach((n) => { n.setDataValue('sections', byNote[n.id] || []); });
  return notes;
};

/**
 * A note made of sections: the rows to save and the plain-text rendition
 * that goes in `notes`. Returns null when the client sent no sections (a
 * legacy client, or a plain note).
 */
const sectionsFromBody = (body) => {
  const rows = cleanSections(body.sections);
  if (!Array.isArray(body.sections)) return null;
  return { rows, notes: renderNoteText(rows) };
};

/**
 * Allergies are the patient file's — the Allergies section is that one copy,
 * shown in the note and written back when saved (Emu, 10 Oct 2026).
 */
const writeAllergiesBack = async (family, rows, transaction) => {
  const al = rows.find((r) => r.key === 'al');
  if (!al) return;
  const text = htmlToText(al.html).replace(/\s*\n\s*/g, '; ').trim().slice(0, 255);
  if (!text) return;
  if (String(family.patient.allergies || '').trim() === text) return;
  await family.patient.update({ allergies: text }, { transaction });
};

/**
 * Reusable "include" configuration for Sequelize queries.
 */
const consultationNoteIncludes = [
  {
    model: Patient,
    attributes: ['uhid', 'firstName', 'lastName'],
  },
  {
    model: User,
    as: 'doctor',
    attributes: ['firstName', 'lastName'],
  },
];

// ====================================
// CONTROLLER ACTIONS
// ====================================

/**
 * POST /api/consultation-notes
 * Creates a new consultation note
 *
 * Authorization: Only doctors
 *
 * Request body expects:
 * - uhid: Patient UHID
 * - notes: Consultation notes text
 * - vitals: JSON object with vital signs
 * - assessment: Clinical assessment
 * - plan: Treatment plan
 * - prescriptionIds: Array of prescription IDs (optional)
 *
 * Controller auto-sets:
 * - date: Current date
 * - time: Current time
 * - doctorId: From JWT token
 */
const create = async (req, res) => {
  try {
    const { uhid, notes, vitals, assessment, plan, prescriptionIds } = req.body;

    const family = await resolvePatient(uhid);
    if (!family) return error(res, `Patient ${uhid} not found`, 404);
    if (family.isDeactivated) return error(res, 'This patient profile is inactive. No new notes can be created.', 403);

    // Date and time as the clinic experiences them — the pair has to agree.
    // These were a UTC date beside a server-local time, so a note written at
    // 01:00 was filed under the previous day with a 01:00 AM timestamp.
    const now = new Date();
    const date = clinicToday(now);
    const time = clinicClockTime({}, now);

    const structured = sectionsFromBody(req.body);
    const noteText = structured ? structured.notes : notes;
    if (!noteText || !String(noteText).trim()) {
      return error(res, 'Nothing to save yet — write the consultation note first', 400);
    }

    // Create the consultation note (+ its sections) as one unit
    const consultationNote = await sequelize.transaction(async (transaction) => {
      const created = await ConsultationNote.create({
        PatientId: family.patient.id,  // PascalCase FK
        notes: noteText,
        vitals,
        assessment,
        plan,
        prescriptionIds: prescriptionIds || [],
        doctorId: req.user.id,  // From JWT token
        date,
        time,
      }, { transaction });
      if (structured) {
        await noteSections.saveSections(created.id, structured.rows, family.patient.id, transaction);
        await writeAllergiesBack(family, structured.rows, transaction);
      }
      return created;
    });

    // Re-fetch with relationships
    const full = await ConsultationNote.findByPk(consultationNote.id, {
      include: consultationNoteIncludes,
    });
    await withSections(full);

    return success(res, formatConsultationNote(full), 201);
  } catch (err) {
    console.error('ConsultationNote.create error:', err);
    return error(res, 'Failed to create consultation note', 500);
  }
};

/**
 * GET /api/consultation-notes
 * Lists consultation notes for a specific patient
 *
 * Query parameters:
 * - uhid: Patient UHID (REQUIRED)
 * - search: Search term (optional) - searches across:
 *   - notes text
 *   - assessment
 *   - plan
 * - page: Page number (default 1)
 * - limit: Items per page (default 20)
 *
 * Search is case-insensitive and uses LIKE with wildcards.
 */
const list = async (req, res) => {
  try {
    const { uhid, search, doctorId, dateFrom, dateTo, page = 1, limit = 20 } = req.query;

    // uhid is REQUIRED
    if (!uhid) {
      return error(res, 'Patient UHID is required', 400);
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Build the WHERE clause
    const where = {};

    // Text search across notes, assessment, plan
    if (search) {
      where[Op.or] = [
        { notes:      { [Op.like]: `%${search}%` } },
        { assessment: { [Op.like]: `%${search}%` } },
        { plan:       { [Op.like]: `%${search}%` } },
      ];
    }

    // Date range filter
    if (dateFrom || dateTo) {
      where.date = {};
      if (dateFrom) where.date[Op.gte] = dateFrom;
      if (dateTo)   where.date[Op.lte] = dateTo;
    }

    // Doctor filter by ID
    if (doctorId) {
      const parsedDoctorId = parseInt(doctorId);
      if (!isNaN(parsedDoctorId)) where.doctorId = parsedDoctorId;
    }

    const family = await resolvePatient(uhid);
    if (!family) return error(res, 'Patient not found', 404);
    where.PatientId = { [Op.in]: family.patientIds };

    const includes = [
      { model: Patient, attributes: ['uhid', 'firstName', 'lastName'] },
      { model: User, as: 'doctor', attributes: ['firstName', 'lastName'] },
    ];

    const { count, rows } = await ConsultationNote.findAndCountAll({
      where,
      include: includes,
      order: [['date', 'DESC'], ['time', 'DESC']],
      offset,
      limit: parseInt(limit),
      distinct: true,
    });

    await withSections(rows);
    const consultationNotes = rows.map(formatConsultationNote);

    return success(res, {
      consultationNotes,
      pagination: {
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(count / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error('ConsultationNote.list error:', err);
    return error(res, 'Failed to retrieve consultation notes', 500);
  }
};

/**
 * GET /api/consultation-notes/:id
 * Gets a single consultation note by ID
 *
 * Authorization: Only doctors
 *
 * Returns the consultation note with patient and doctor details
 */
const getById = async (req, res) => {
  try {
    const { id } = req.params;

    const consultationNote = await ConsultationNote.findByPk(id, {
      include: consultationNoteIncludes,
    });

    if (!consultationNote) {
      return error(res, `Consultation note with ID ${id} not found`, 404);
    }
    await withSections(consultationNote);

    return success(res, formatConsultationNote(consultationNote));
  } catch (err) {
    console.error('ConsultationNote.getById error:', err);
    return error(res, 'Failed to retrieve consultation note', 500);
  }
};

/**
 * PUT /api/consultation-notes/:id
 * Updates an existing consultation note
 *
 * Authorization: Only doctors (and only the doctor who created it)
 *
 * Request body can include:
 * - notes: Consultation notes text
 * - vitals: JSON object with vital signs
 * - assessment: Clinical assessment
 * - plan: Treatment plan
 * - prescriptionIds: Array of prescription IDs
 */
const update = async (req, res) => {
  try {
    const { id } = req.params;
    const { notes, vitals, assessment, plan, prescriptionIds } = req.body;

    const consultationNote = await ConsultationNote.findByPk(id, {
      include: consultationNoteIncludes,
    });

    if (!consultationNote) {
      return error(res, `Consultation note with ID ${id} not found`, 404);
    }

    // Only the doctor who created the note can update it
    if (consultationNote.doctorId !== req.user.id) {
      return error(res, 'You can only update your own consultation notes', 403);
    }

    // Medical records law: notes can only be edited on the day they were
    // written — the clinic's day, so the window closes at local midnight rather
    // than at 03:00 the next morning (which is what a UTC "today" gave).
    const today = clinicToday();
    if (consultationNote.date !== today) {
      return error(res, 'Consultation notes can only be edited on the day they were written', 403);
    }

    const structured = sectionsFromBody(req.body);
    if (structured && !structured.notes.trim()) {
      return error(res, 'Nothing to save yet — write the consultation note first', 400);
    }

    // Update only the fields that were provided
    if (structured) consultationNote.notes = structured.notes;
    else if (notes !== undefined) consultationNote.notes = notes;
    if (vitals !== undefined) consultationNote.vitals = vitals;
    if (assessment !== undefined) consultationNote.assessment = assessment;
    if (plan !== undefined) consultationNote.plan = plan;
    if (prescriptionIds !== undefined) consultationNote.prescriptionIds = prescriptionIds;

    await sequelize.transaction(async (transaction) => {
      await consultationNote.save({ transaction });
      if (structured) {
        const family = await resolvePatient(consultationNote.Patient?.uhid);
        await noteSections.saveSections(consultationNote.id, structured.rows, consultationNote.PatientId, transaction);
        if (family) await writeAllergiesBack(family, structured.rows, transaction);
      }
    });

    // Re-fetch with relationships
    const full = await ConsultationNote.findByPk(id, {
      include: consultationNoteIncludes,
    });
    await withSections(full);

    return success(res, formatConsultationNote(full));
  } catch (err) {
    console.error('ConsultationNote.update error:', err);
    return error(res, 'Failed to update consultation note', 500);
  }
};

/**
 * DELETE /api/consultation-notes/:id
 * Deletes a consultation note
 *
 * Authorization: Only doctors (and only the doctor who created it) or admin
 *
 * Note: This is a hard delete. Consider soft delete for production.
 */
const deleteNote = async (req, res) => {
  try {
    const { id } = req.params;

    const consultationNote = await ConsultationNote.findByPk(id);

    if (!consultationNote) {
      return error(res, `Consultation note with ID ${id} not found`, 404);
    }

    // Only the doctor who created the note or an admin can delete it
    if (!hasPermission(req.user, PERMISSIONS.ADMIN_ACCESS) && consultationNote.doctorId !== req.user.id) {
      return error(res, 'You can only delete your own consultation notes', 403);
    }

    await consultationNote.destroy();

    return success(res, { message: 'Consultation note deleted successfully' });
  } catch (err) {
    console.error('ConsultationNote.deleteNote error:', err);
    return error(res, 'Failed to delete consultation note', 500);
  }
};

/**
 * GET /api/consultation-notes/carry-forward?uhid=
 * What pre-fills a new note's history sections: the last saved copy of each
 * carry-forward section, the patient file (allergies — anyone's entry,
 * nurses included — comorbidities, registration medicines), prescriptions
 * (current / stopped) and the retired Initial Assessment as a seed.
 *
 * Authorization: doctors
 */
const carryForward = async (req, res) => {
  try {
    const { uhid } = req.query;
    if (!uhid) return error(res, 'Patient UHID is required', 400);
    const family = await resolvePatient(uhid);
    if (!family) return error(res, 'Patient not found', 404);
    return success(res, await noteSections.carryForward(family));
  } catch (err) {
    console.error('ConsultationNote.carryForward error:', err);
    return error(res, 'Failed to load the patient history', 500);
  }
};

// ====================================
// EXPORTS
// ====================================
module.exports = {
  create,
  list,
  getById,
  update,
  deleteNote,
  carryForward,
};
