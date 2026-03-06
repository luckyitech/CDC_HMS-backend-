const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const db = require('../models');

const { ConsultationNote, Patient, User } = db;

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
    date: n.date,
    time: n.time,
    notes: n.notes,
    vitals: n.vitals,
    assessment: n.assessment,
    plan: n.plan,
    prescriptionIds: n.prescriptionIds,
  };
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

    // Find the patient by UHID
    const patient = await Patient.findOne({ where: { uhid } });
    if (!patient) {
      return error(res, `Patient ${uhid} not found`, 404);
    }

    // Get current date and time
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });

    // Create the consultation note
    const consultationNote = await ConsultationNote.create({
      PatientId: patient.id,  // PascalCase FK
      notes,
      vitals,
      assessment,
      plan,
      prescriptionIds: prescriptionIds || [],
      doctorId: req.user.id,  // From JWT token
      date,
      time,
    });

    // Re-fetch with relationships
    const full = await ConsultationNote.findByPk(consultationNote.id, {
      include: consultationNoteIncludes,
    });

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
    const { uhid, search, page = 1, limit = 20 } = req.query;

    // uhid is REQUIRED
    if (!uhid) {
      return error(res, 'Patient UHID is required', 400);
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Build the WHERE clause for search
    const where = {};
    if (search) {
      // Search across all relevant TEXT fields
      where[Op.or] = [
        { notes: { [Op.like]: `%${search}%` } },
        { assessment: { [Op.like]: `%${search}%` } },
        { plan: { [Op.like]: `%${search}%` } },
      ];
    }

    // Build includes with patient filter
    const includes = [
      {
        model: Patient,
        attributes: ['uhid', 'firstName', 'lastName'],
        where: { uhid },
        required: true,
      },
      {
        model: User,
        as: 'doctor',
        attributes: ['firstName', 'lastName'],
      },
    ];

    const { count, rows } = await ConsultationNote.findAndCountAll({
      where,
      include: includes,
      order: [['date', 'DESC'], ['time', 'DESC']],
      offset,
      limit: parseInt(limit),
      distinct: true,
    });

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

    // Update only the fields that were provided
    if (notes !== undefined) consultationNote.notes = notes;
    if (vitals !== undefined) consultationNote.vitals = vitals;
    if (assessment !== undefined) consultationNote.assessment = assessment;
    if (plan !== undefined) consultationNote.plan = plan;
    if (prescriptionIds !== undefined) consultationNote.prescriptionIds = prescriptionIds;

    await consultationNote.save();

    // Re-fetch with relationships
    const full = await ConsultationNote.findByPk(id, {
      include: consultationNoteIncludes,
    });

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
    if (req.user.role !== 'admin' && consultationNote.doctorId !== req.user.id) {
      return error(res, 'You can only delete your own consultation notes', 403);
    }

    await consultationNote.destroy();

    return success(res, { message: 'Consultation note deleted successfully' });
  } catch (err) {
    console.error('ConsultationNote.deleteNote error:', err);
    return error(res, 'Failed to delete consultation note', 500);
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
};
