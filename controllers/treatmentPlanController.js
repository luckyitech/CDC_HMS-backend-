const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { resolvePatient } = require('../utils/patientFamily');
const { clinicToday, clinicClockTime } = require('../utils/clinicTime');
const db = require('../models');

const { TreatmentPlan, Patient, User } = db;

// ====================================
// HELPER FUNCTIONS
// ====================================

/**
 * Formats a single treatment plan for the API response.
 * Transforms raw database data into a clean, consistent format.
 *
 * @param {Object} plan - The raw treatment plan object from the database
 * @returns {Object} - Formatted treatment plan object
 */
const formatTreatmentPlan = (plan) => {
  const p = plan.dataValues || plan;
  return {
    id: p.id,
    uhid: p.Patient?.uhid || null,
    patientName: p.Patient
      ? `${p.Patient.firstName} ${p.Patient.lastName}`
      : null,
    doctorName: p.doctor
      ? `Dr. ${p.doctor.firstName} ${p.doctor.lastName}`
      : null,
    // See consultationNoteController.formatConsultationNote — visit scoping.
    doctorId: p.doctorId,
    createdAt: p.createdAt,
    date: p.date,
    time: p.time,
    diagnosis: p.diagnosis,
    plan: p.plan,
    status: p.status,
    consultationId: p.consultationId,
  };
};

/**
 * Reusable "include" configuration for Sequelize queries.
 * Joins the Patient and Doctor tables.
 */
const treatmentPlanIncludes = [
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
 * POST /api/treatment-plans
 * Creates a new treatment plan
 *
 * Authorization: Only doctors can create treatment plans
 *
 * Request body expects:
 * - uhid: Patient UHID (e.g., "CDC001")
 * - diagnosis: The diagnosis
 * - plan: The treatment plan (can be multi-line text)
 * - consultationId: Optional consultation note ID
 *
 * Controller auto-sets:
 * - date: Current date
 * - time: Current time
 * - doctorId: From JWT token
 * - status: "Active"
 *
 * IMPORTANT BUSINESS LOGIC:
 * When creating a new treatment plan, automatically set all other
 * Active treatment plans for the same patient to "Completed".
 * This ensures only ONE active treatment plan exists per patient.
 */
const create = async (req, res) => {
  const { uhid, diagnosis, plan, consultationId } = req.body;

  const family = await resolvePatient(uhid);
  if (!family) return error(res, `Patient ${uhid} not found`, 404);
  if (family.isDeactivated) return error(res, 'This patient profile is inactive. No new treatment plans can be created.', 403);

  const { patient, patientIds } = family;

  // Step 2: Auto-complete all other Active treatment plans for this patient (and merged)
  await TreatmentPlan.update(
    { status: 'Completed' },
    { where: { PatientId: { [Op.in]: patientIds }, status: 'Active' } },
  );

  // Step 3: Date and time as the clinic experiences them — the pair has to
  // agree. This was a UTC date beside a server-local time, so a plan written
  // at 01:00 was filed under the previous day with a 01:00 AM timestamp.
  const now = new Date();
  const date = clinicToday(now);              // YYYY-MM-DD
  const time = clinicClockTime({}, now);      // "10:30 AM"

  // Step 4: Create the new treatment plan
  // CRITICAL: PatientId must be PascalCase (auto-generated FK naming convention)
  const treatmentPlan = await TreatmentPlan.create({
    PatientId: patient.id,  // PascalCase FK
    diagnosis,
    plan,
    consultationId: consultationId || null,
    doctorId: req.user.id,  // From JWT token (doctor ID)
    date,
    time,
    status: 'Active',  // New plans always start as Active
  });

  // Step 5: Re-fetch with relationships to get complete data
  const full = await TreatmentPlan.findByPk(treatmentPlan.id, {
    include: treatmentPlanIncludes,
  });

  return success(res, formatTreatmentPlan(full), 201);
};

/**
 * GET /api/treatment-plans
 * Lists treatment plans for a specific patient
 *
 * Query parameters:
 * - uhid: Patient UHID (REQUIRED)
 * - page: Page number (default 1)
 * - limit: Items per page (default 20)
 *
 * Authorization: Doctors and staff can view treatment plans
 */
const list = async (req, res) => {
  const { uhid, page = 1, limit = 20 } = req.query;

  // uhid is REQUIRED for this endpoint
  if (!uhid) {
    return error(res, 'Patient UHID is required', 400);
  }

  // Calculate pagination offset
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const family = await resolvePatient(uhid);
  if (!family) return error(res, 'Patient not found', 404);

  const includes = [
    { model: Patient, attributes: ['uhid', 'firstName', 'lastName'] },
    { model: User, as: 'doctor', attributes: ['firstName', 'lastName'] },
  ];

  // Fetch treatment plans with count
  const { count, rows } = await TreatmentPlan.findAndCountAll({
    where: { PatientId: { [Op.in]: family.patientIds } },
    include: includes,
    order: [['date', 'DESC'], ['time', 'DESC']],  // Newest first
    offset,
    limit: parseInt(limit),
    distinct: true,
  });

  // Format all treatment plans
  const treatmentPlans = rows.map(formatTreatmentPlan);

  return success(res, {
    treatmentPlans,
    pagination: {
      total: count,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(count / parseInt(limit)),
    },
  });
};

/**
 * GET /api/treatment-plans/:id
 * Gets a single treatment plan by ID
 */
const getOne = async (req, res) => {
  const treatmentPlan = await TreatmentPlan.findByPk(req.params.id, {
    include: treatmentPlanIncludes,
  });

  if (!treatmentPlan) return error(res, 'Treatment plan not found', 404);

  return success(res, formatTreatmentPlan(treatmentPlan));
};

/**
 * PUT /api/treatment-plans/:id/status
 * Updates a treatment plan status
 *
 * Request body:
 * - status: New status ("Active" or "Completed")
 *
 * Common use case: Doctor marks a plan as Completed
 *
 * Authorization: Only doctors
 */
const updateStatus = async (req, res) => {
  const { status } = req.body;

  const treatmentPlan = await TreatmentPlan.findByPk(req.params.id);

  if (!treatmentPlan) return error(res, 'Treatment plan not found', 404);

  // Update the status
  await treatmentPlan.update({ status });

  // Re-fetch with relationships for the response
  const updated = await TreatmentPlan.findByPk(treatmentPlan.id, {
    include: treatmentPlanIncludes,
  });

  return success(res, formatTreatmentPlan(updated));
};

/**
 * DELETE /api/treatment-plans/:id
 * Deletes a treatment plan
 *
 * Note: In production, consider soft-delete for audit trail
 *
 * Authorization: Doctors and admins only
 */
const destroy = async (req, res) => {
  const treatmentPlan = await TreatmentPlan.findByPk(req.params.id);

  if (!treatmentPlan) return error(res, 'Treatment plan not found', 404);

  await treatmentPlan.destroy();

  return success(res, { message: 'Treatment plan deleted successfully' });
};

/**
 * GET /api/treatment-plans/stats
 * Returns aggregate statistics about treatment plans
 *
 * Returns:
 * - total: Total number of treatment plans
 * - active: Number of active plans
 * - completed: Number of completed plans
 *
 * Used for doctor dashboard
 */
const stats = async (req, res) => {
  const [total, active, completed] = await Promise.all([
    TreatmentPlan.count(),
    TreatmentPlan.count({ where: { status: 'Active' } }),
    TreatmentPlan.count({ where: { status: 'Completed' } }),
  ]);

  return success(res, { total, active, completed });
};

// ====================================
// UPDATE DIAGNOSIS & PLAN
// ====================================

/**
 * PUT /api/treatment-plans/:id
 * Updates the diagnosis and/or plan text of an existing treatment plan.
 *
 * Authorization: Doctor only
 */
const update = async (req, res) => {
  const { diagnosis, plan } = req.body;

  const treatmentPlan = await TreatmentPlan.findByPk(req.params.id);
  if (!treatmentPlan) return error(res, 'Treatment plan not found', 404);

  // Medical records law: a treatment plan can only be edited on the day it was
  // written — the clinic's day, so the window closes at local midnight rather
  // than at 03:00 the next morning (which is what a UTC "today" gave).
  const today = clinicToday();
  if (treatmentPlan.date !== today) {
    return error(res, 'Treatment plans can only be edited on the day they were written', 403);
  }

  await treatmentPlan.update({
    ...(diagnosis !== undefined && { diagnosis }),
    ...(plan      !== undefined && { plan }),
  });

  const updated = await TreatmentPlan.findByPk(treatmentPlan.id, {
    include: treatmentPlanIncludes,
  });

  return success(res, formatTreatmentPlan(updated));
};

// ====================================
// EXPORTS
// ====================================
module.exports = {
  create,
  list,
  getOne,
  update,
  updateStatus,
  destroy,
  stats,
};
