const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const db = require('../models');
const { generatePrescriptionNumber } = require('../utils/generateId');

const { Prescription, Patient, User } = db;

// ====================================
// HELPER FUNCTIONS
// ====================================
// These functions are reusable pieces of logic that keep our controller clean.
// They're defined at the top so we can use them in multiple actions.

/**
 * Formats a single prescription for the API response.
 * This function transforms raw database data into a clean, consistent format.
 *
 * Why do we need this?
 * - Database returns raw Sequelize objects with extra properties
 * - We want to control exactly what data the frontend receives
 * - Keeps response format consistent across all endpoints
 */
const formatPrescription = (prescription) => {
  const p = prescription.dataValues || prescription;
  return {
    id: p.id,
    prescriptionNumber: p.prescriptionNumber,
    patientUhid: p.Patient?.uhid || null,
    patientName: p.Patient
      ? `${p.Patient.firstName} ${p.Patient.lastName}`
      : null,
    doctorName: p.doctor
      ? `Dr. ${p.doctor.firstName} ${p.doctor.lastName}`
      : null,
    date: p.date,
    diagnosis: p.diagnosis,
    status: p.status,
    medications: p.medications,
    notes: p.notes,
    createdAt: p.createdAt,
  };
};

/**
 * Reusable "include" configuration for Sequelize queries.
 * This tells Sequelize to JOIN the Patient and Doctor tables.
 *
 * Why use this pattern?
 * - DRY (Don't Repeat Yourself) - define the JOIN logic once
 * - Consistent data fetching across all actions
 * - Easy to modify if relationships change
 */
const prescriptionIncludes = [
  {
    model: Patient,
    attributes: ['uhid', 'firstName', 'lastName'],  // Only fetch what we need
  },
  {
    model: User,
    as: 'doctor',  // This matches the alias in the model relationship
    attributes: ['firstName', 'lastName'],
  },
];

// ====================================
// CONTROLLER ACTIONS
// ====================================
// Each action handles one HTTP endpoint.
// Notice: NO try/catch blocks! Express 5 automatically catches async errors.

/**
 * POST /api/prescriptions
 * Creates a new prescription
 *
 * Authorization: Only doctors can create prescriptions
 *
 * How this works:
 * 1. Generate a unique prescription number (RX001, RX002, etc.)
 * 2. Create the prescription with the doctor's ID from the JWT token
 * 3. Re-fetch with JOINs to get patient and doctor names
 * 4. Return formatted response
 */
const create = async (req, res) => {
  // Step 1: Generate unique ID
  const prescriptionNumber = await generatePrescriptionNumber(Prescription);

  // Step 2: Create prescription
  // req.user.id comes from the authenticate middleware (JWT token)
  // CRITICAL: PatientId must be PascalCase (auto-generated FK naming convention)
  const prescription = await Prescription.create({
    ...req.body,
    PatientId: req.body.patientId,  // Map lowercase to PascalCase FK
    prescriptionNumber,
    doctorId: req.user.id,  // Auto-assign to the logged-in doctor
  });

  // Step 3: Re-fetch with relationships
  // We need to do this because the initial create doesn't include Patient/Doctor data
  const full = await Prescription.findByPk(prescription.id, {
    include: prescriptionIncludes,
  });

  // Step 4: Return formatted response
  return success(res, formatPrescription(full), 201);
};

/**
 * GET /api/prescriptions
 * Lists prescriptions with optional filters
 *
 * Query parameters:
 * - patientUhid: Filter by patient UHID
 * - doctorId: Filter by doctor ID
 * - status: Filter by status (Active/Completed/Cancelled)
 * - page: Page number (default 1)
 * - limit: Items per page (default 20)
 *
 * How filtering works:
 * We build a "where" object dynamically based on query params.
 * Sequelize converts this to SQL WHERE clauses automatically.
 */
const list = async (req, res) => {
  const { patientUhid, doctorId, status, page = 1, limit = 20 } = req.query;

  // Build the WHERE clause dynamically
  const where = {};

  // If doctorId filter is provided, add it to WHERE
  if (doctorId) where.doctorId = parseInt(doctorId);

  // If status filter is provided, add it to WHERE
  if (status) where.status = status;

  // Clone the includes array so we can modify it
  const includes = [...prescriptionIncludes];

  // If filtering by patient UHID, we need to add a WHERE to the Patient JOIN
  if (patientUhid) {
    includes[0] = {
      ...includes[0],
      where: { uhid: patientUhid },
      required: true,  // INNER JOIN (only show prescriptions with matching patient)
    };
  }

  // Calculate pagination offset
  const offset = (parseInt(page) - 1) * parseInt(limit);

  // Fetch prescriptions with count (for pagination metadata)
  const { count, rows } = await Prescription.findAndCountAll({
    where,
    include: includes,
    order: [['createdAt', 'DESC']],  // Newest first
    offset,
    limit: parseInt(limit),
    distinct: true,  // Count unique prescriptions (important when using JOINs)
  });

  // Format all prescriptions
  const prescriptions = rows.map(formatPrescription);

  // Return with pagination metadata
  return success(res, {
    prescriptions,
    pagination: {
      total: count,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(count / parseInt(limit)),
    },
  });
};

/**
 * GET /api/prescriptions/:id
 * Gets a single prescription by ID
 *
 * Why check if prescription exists?
 * Sequelize returns null if not found, so we return a 404 error.
 */
const getOne = async (req, res) => {
  const prescription = await Prescription.findByPk(req.params.id, {
    include: prescriptionIncludes,
  });

  if (!prescription) return error(res, 'Prescription not found', 404);

  return success(res, formatPrescription(prescription));
};

/**
 * PUT /api/prescriptions/:id
 * Updates a prescription (typically just the status)
 *
 * Common use case: Doctor marks prescription as "Completed"
 *
 * Security note: Only the prescribing doctor should update their prescriptions
 * (We'll enforce this in the route authorization)
 */
const update = async (req, res) => {
  const prescription = await Prescription.findByPk(req.params.id);

  if (!prescription) return error(res, 'Prescription not found', 404);

  // Update the prescription with request body data
  await prescription.update(req.body);

  // Re-fetch with relationships for the response
  const updated = await Prescription.findByPk(prescription.id, {
    include: prescriptionIncludes,
  });

  return success(res, formatPrescription(updated));
};

/**
 * DELETE /api/prescriptions/:id
 * Deletes a prescription
 *
 * Note: In production, you might want "soft delete" instead
 * (marking as deleted without actually removing from database)
 */
const destroy = async (req, res) => {
  const prescription = await Prescription.findByPk(req.params.id);

  if (!prescription) return error(res, 'Prescription not found', 404);

  await prescription.destroy();

  return success(res, { message: 'Prescription deleted successfully' });
};

/**
 * GET /api/prescriptions/stats
 * Returns aggregate statistics about prescriptions
 *
 * Why use Promise.all?
 * - Runs all queries in parallel (faster than sequential)
 * - Waits for all to complete before continuing
 * - Common pattern for dashboard statistics
 */
const stats = async (req, res) => {
  const [total, active, completed, cancelled] = await Promise.all([
    Prescription.count(),
    Prescription.count({ where: { status: 'Active' } }),
    Prescription.count({ where: { status: 'Completed' } }),
    Prescription.count({ where: { status: 'Cancelled' } }),
  ]);

  return success(res, { total, active, completed, cancelled });
};

// ====================================
// EXPORTS
// ====================================
// Export all actions so they can be used in routes
module.exports = { create, list, getOne, update, destroy, stats };
