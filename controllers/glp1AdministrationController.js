const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { resolvePatient } = require('../utils/patientFamily');
const { doseStepForReview } = require('../utils/glp1Schedule');
const db = require('../models');

const { Glp1Administration, Glp1Therapy, Patient, User } = db;

const LIVE_STATUSES = ['Active', 'Paused'];

// ====================================
// HELPER FUNCTIONS
// ====================================

const administrationIncludes = [
  { model: User, as: 'administeredByUser', attributes: ['firstName', 'lastName', 'role'] },
];

/**
 * Formats one weekly injection record.
 * clinicianName rather than doctorName — a nurse gives most of these.
 */
const formatAdministration = (administration) => {
  const a = administration.dataValues || administration;
  return {
    id:               a.id,
    therapyId:        a.Glp1TherapyId,
    weekNumber:       a.weekNumber,
    status:           a.status,
    administeredDate: a.administeredDate,
    dose:             a.dose,
    site:             a.site,
    note:             a.note,
    clinicianName:    a.administeredByUser
      ? `${a.administeredByUser.firstName} ${a.administeredByUser.lastName}`
      : null,
    clinicianRole:    a.administeredByUser?.role || null,
    recordedAt:       a.createdAt,
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
    return { err: { message: `This course is ${therapy.status.toLowerCase()} — no further doses can be recorded`, code: 403 } };
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
 * GET /api/glp1-administrations
 * Lists the weekly injection record for a course, or for a patient.
 *
 * Query parameters — one of:
 * - therapyId
 * - uhid (merge-aware, across courses)
 * Optional: status=missed
 *
 * Authorization: doctor, staff
 */
const list = async (req, res) => {
  try {
    const { therapyId, uhid, status } = req.query;

    if (!therapyId && !uhid) {
      return error(res, 'Either a therapyId or a patient UHID is required', 400);
    }

    const where = {};
    if (status) where.status = status;

    if (therapyId) {
      where.Glp1TherapyId = therapyId;
    } else {
      const family = await resolvePatient(uhid);
      if (!family) return error(res, `Patient ${uhid} not found`, 404);
      where.PatientId = { [Op.in]: family.patientIds };
    }

    const administrations = await Glp1Administration.findAll({
      where,
      include: administrationIncludes,
      order: [['weekNumber', 'ASC']],
    });

    return success(res, { administrations: administrations.map(formatAdministration) });
  } catch (err) {
    console.error('Glp1Administration.list error:', err);
    return error(res, 'Failed to retrieve injection records', 500);
  }
};

/**
 * POST /api/glp1-administrations
 * Records one week as given, missed or omitted.
 *
 * Authorization: doctor, staff. Nurses give most of these, so staff can record
 * them — but staff still cannot start or stop a course, which is a prescribing
 * decision.
 *
 * Request body:
 * - therapyId, weekNumber, status (required)
 * - administeredDate, dose, site, note
 *
 * Controller auto-sets:
 * - administeredBy from the JWT
 * - dose from the ladder when omitted and the dose was given
 *
 * Recording the same week twice updates it rather than duplicating — the unique
 * index on (Glp1TherapyId, weekNumber) makes that the only sane behaviour, and
 * a nurse correcting a mistyped week should not have to delete anything.
 */
const record = async (req, res) => {
  try {
    const { therapyId, weekNumber, status, administeredDate, dose, site, note } = req.body;

    const loaded = await loadTherapy(therapyId);
    if (loaded.err) return error(res, loaded.err.message, loaded.err.code);

    const { therapy, family } = loaded;

    if (status !== 'given' && !String(note || '').trim()) {
      return error(res, `A reason is required when a dose is ${status}`, 400);
    }

    // What the ladder says they should have had this week
    const step = doseStepForReview(therapy.doseSchedule || [], Number(weekNumber));
    const resolvedDose = dose ?? (status === 'given' && step ? step.dose : null);

    const existing = await Glp1Administration.findOne({
      where: { Glp1TherapyId: therapy.id, weekNumber },
    });

    const values = {
      Glp1TherapyId:    therapy.id,
      PatientId:        family.patient.id,
      weekNumber,
      status,
      administeredDate: status === 'given'
        ? (administeredDate || new Date().toISOString().slice(0, 10))
        : (administeredDate || null),
      dose:             resolvedDose,
      site:             site || null,
      note:             note || null,
      administeredBy:   req.user.id,   // From JWT token
    };

    let administration;
    if (existing) {
      await existing.update(values);
      administration = existing;
    } else {
      administration = await Glp1Administration.create(values);
    }

    const full = await Glp1Administration.findByPk(administration.id, {
      include: administrationIncludes,
    });

    return success(res, formatAdministration(full), existing ? 200 : 201);
  } catch (err) {
    console.error('Glp1Administration.record error:', err);
    return error(res, 'Failed to record the injection', 500);
  }
};

/**
 * DELETE /api/glp1-administrations/:id
 * Removes a week's record — used when a week was logged against the wrong
 * course or the wrong week. The week returns to "not yet recorded".
 *
 * Authorization: doctor, staff
 *
 * This is a hard delete, and deliberately so: unlike a review, this row carries
 * no clinical assessment. An erroneous "missed" left on the record would be
 * worse than removing it.
 */
const remove = async (req, res) => {
  try {
    const { id } = req.params;

    const administration = await Glp1Administration.findByPk(id);
    if (!administration) return error(res, `Injection record with ID ${id} not found`, 404);

    const loaded = await loadTherapy(administration.Glp1TherapyId);
    if (loaded.err) return error(res, loaded.err.message, loaded.err.code);

    const { weekNumber } = administration;
    await administration.destroy();

    return success(res, { message: `Week ${weekNumber} record removed`, weekNumber });
  } catch (err) {
    console.error('Glp1Administration.remove error:', err);
    return error(res, 'Failed to remove the injection record', 500);
  }
};

// ====================================
// EXPORTS
// ====================================
module.exports = {
  list,
  record,
  remove,
  formatAdministration,
  administrationIncludes,
};
