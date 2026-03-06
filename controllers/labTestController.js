const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const db = require('../models');
const { generateLabTestNumber } = require('../utils/generateId');

const { LabTest, Patient, User } = db;

const computeAge = (dateOfBirth) => {
  if (!dateOfBirth) return null;
  const today = new Date();
  const dob = new Date(dateOfBirth);
  let age = today.getFullYear() - dob.getFullYear();
  const m = today.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
  return age;
};

// ====================================
// HELPER FUNCTIONS
// ====================================

/**
 * Formats a single lab test for the API response.
 * Transforms raw database data into a clean, consistent format.
 *
 * @param {Object} labTest - The raw lab test object from the database
 * @param {boolean} includePatientDetails - Whether to include age/gender (for pending tests view)
 * @returns {Object} - Formatted lab test object
 */
const formatLabTest = (labTest, includePatientDetails = false) => {
  const lt = labTest.dataValues || labTest;

  const formatted = {
    id: lt.id,
    testNumber: lt.testNumber,
    uhid: lt.Patient?.uhid || null,
    patientName: lt.Patient
      ? `${lt.Patient.firstName} ${lt.Patient.lastName}`
      : null,
    testType: lt.testType,
    orderedBy: lt.orderedBy
      ? `Dr. ${lt.orderedBy.firstName} ${lt.orderedBy.lastName}`
      : null,
    orderedDate: lt.orderedDate,
    orderedTime: lt.orderedTime,
    sampleType: lt.sampleType,
    priority: lt.priority,
    status: lt.status,
    sampleCollected: lt.sampleCollected,
    collectionDate: lt.collectionDate,
    results: lt.results,
    normalRange: lt.normalRange,
    interpretation: lt.interpretation,
    isCritical: lt.isCritical,
    technicianNotes: lt.technicianNotes,
    completedBy: lt.completedBy,
    completedDate: lt.completedDate,
    reportGenerated: lt.reportGenerated,
    notes: lt.notes,
  };

  // For pending tests view, include patient demographics
  if (includePatientDetails && lt.Patient) {
    formatted.age = computeAge(lt.Patient.dateOfBirth) ?? lt.Patient.age;
    formatted.gender = lt.Patient.gender;
  }

  return formatted;
};

/**
 * Reusable "include" configuration for Sequelize queries.
 * Joins the Patient and Doctor (orderedBy) tables.
 */
const labTestIncludes = [
  {
    model: Patient,
    attributes: ['uhid', 'firstName', 'lastName', 'age', 'dateOfBirth', 'gender'],
  },
  {
    model: User,
    as: 'orderedBy',  // This matches the alias in the model relationship
    attributes: ['firstName', 'lastName'],
  },
];

// ====================================
// CONTROLLER ACTIONS
// ====================================

/**
 * POST /api/lab-tests
 * Orders a new lab test
 *
 * Authorization: Only doctors can order lab tests
 *
 * Request body expects:
 * - uhid: Patient UHID (e.g., "CDC001")
 * - testType: Type of test (e.g., "HbA1c", "Fasting Blood Sugar")
 * - sampleType: Sample type (e.g., "Blood", "Urine")
 * - priority: Priority level ("Routine", "Urgent", "STAT")
 * - notes: Optional notes
 *
 * Controller auto-sets:
 * - testNumber: LAB-2026-001
 * - orderedById: From JWT token
 * - orderedDate, orderedTime: Current date/time
 * - status: "Pending"
 */
const create = async (req, res) => {
  const { uhid, testType, sampleType, priority, notes } = req.body;

  // Step 1: Find the patient by UHID
  // We need the patient ID to create the foreign key relationship
  const patient = await Patient.findOne({ where: { uhid } });
  if (!patient) {
    return error(res, `Patient ${uhid} not found`, 404);
  }

  // Step 2: Generate unique test number
  const testNumber = await generateLabTestNumber(LabTest);

  // Step 3: Get current date and time
  const now = new Date();
  const orderedDate = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const orderedTime = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }); // "10:30 AM"

  // Step 4: Create the lab test
  // CRITICAL: PatientId must be PascalCase (auto-generated FK naming convention)
  const labTest = await LabTest.create({
    testNumber,
    PatientId: patient.id,  // PascalCase FK
    testType,
    sampleType,
    priority: priority || 'Routine',  // Default to Routine if not specified
    orderedById: req.user.id,  // From JWT token (doctor ID)
    orderedDate,
    orderedTime,
    status: 'Pending',  // All new tests start as Pending
    notes,
  });

  // Step 5: Re-fetch with relationships to get complete data
  const full = await LabTest.findByPk(labTest.id, {
    include: labTestIncludes,
  });

  return success(res, formatLabTest(full), 201);
};

/**
 * GET /api/lab-tests
 * Lists all lab tests with optional filters
 *
 * Query parameters:
 * - uhid: Filter by patient UHID
 * - status: Filter by status
 * - testType: Filter by test type
 * - priority: Filter by priority
 * - page: Page number (default 1)
 * - limit: Items per page (default 20)
 *
 * Authorization: Lab technicians, doctors, staff can all view tests
 */
const list = async (req, res) => {
  const { uhid, status, testType, priority, page = 1, limit = 20 } = req.query;

  // Build the WHERE clause dynamically
  const where = {};
  if (status) where.status = status;
  if (testType) where.testType = testType;
  if (priority) where.priority = priority;

  // Clone the includes array so we can modify it
  const includes = [...labTestIncludes];

  // If filtering by patient UHID, add a WHERE to the Patient JOIN
  if (uhid) {
    includes[0] = {
      ...includes[0],
      where: { uhid },
      required: true,  // INNER JOIN
    };
  }

  // Calculate pagination offset
  const offset = (parseInt(page) - 1) * parseInt(limit);

  // Fetch lab tests with count
  const { count, rows } = await LabTest.findAndCountAll({
    where,
    include: includes,
    order: [['orderedDate', 'DESC'], ['orderedTime', 'DESC']],  // Newest first
    offset,
    limit: parseInt(limit),
    distinct: true,
  });

  // Format all lab tests
  const labTests = rows.map((lt) => formatLabTest(lt));

  return success(res, {
    labTests,
    pagination: {
      total: count,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(count / parseInt(limit)),
    },
  });
};

/**
 * GET /api/lab-tests/pending
 * Lists pending and in-progress tests
 *
 * Returns tests where status IN ('Pending', 'Sample Collected', 'In Progress')
 * Includes patient age and gender for lab technician workflow
 *
 * Authorization: Lab technicians primarily use this endpoint
 */
const pending = async (req, res) => {
  const { page = 1, limit = 20 } = req.query;

  const offset = (parseInt(page) - 1) * parseInt(limit);

  // Find tests that are not yet completed
  const { count, rows } = await LabTest.findAndCountAll({
    where: {
      status: {
        [Op.in]: ['Pending', 'Sample Collected', 'In Progress'],
      },
    },
    include: labTestIncludes,
    order: [
      // Prioritize by priority level, then by order date
      ['priority', 'ASC'],  // STAT comes before Urgent, Urgent before Routine
      ['orderedDate', 'ASC'],
      ['orderedTime', 'ASC'],
    ],
    offset,
    limit: parseInt(limit),
    distinct: true,
  });

  // Format with patient details
  const labTests = rows.map((lt) => formatLabTest(lt, true));

  return success(res, {
    labTests,
    pagination: {
      total: count,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(count / parseInt(limit)),
    },
  });
};

/**
 * GET /api/lab-tests/critical
 * Lists tests with critical results
 *
 * Returns completed tests where isCritical = true
 * Used by doctors and lab supervisors to identify urgent cases
 *
 * Authorization: Lab technicians and doctors
 */
const critical = async (req, res) => {
  const { page = 1, limit = 20 } = req.query;

  const offset = (parseInt(page) - 1) * parseInt(limit);

  const { count, rows } = await LabTest.findAndCountAll({
    where: {
      status: 'Completed',
      isCritical: true,
    },
    include: labTestIncludes,
    order: [['completedDate', 'DESC']],  // Most recent first
    offset,
    limit: parseInt(limit),
    distinct: true,
  });

  const labTests = rows.map((lt) => formatLabTest(lt));

  return success(res, {
    labTests,
    pagination: {
      total: count,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(count / parseInt(limit)),
    },
  });
};

/**
 * GET /api/lab-tests/:id
 * Gets a single lab test by ID
 */
const getOne = async (req, res) => {
  const labTest = await LabTest.findByPk(req.params.id, {
    include: labTestIncludes,
  });

  if (!labTest) return error(res, 'Lab test not found', 404);

  return success(res, formatLabTest(labTest));
};

/**
 * PUT /api/lab-tests/:id
 * Updates a lab test (typically entering results and changing status)
 *
 * Common use case: Lab technician enters test results
 *
 * Request body can include:
 * - status: New status
 * - sampleCollected: Boolean
 * - collectionDate: When sample was collected
 * - results: JSON object with test results
 * - normalRange: String describing normal range
 * - interpretation: "Normal", "Abnormal", "Controlled", etc.
 * - isCritical: Boolean flag for critical results
 * - technicianNotes: Notes from lab tech
 * - completedBy: Name of person who completed the test
 * - completedDate: Date test was completed
 * - reportGenerated: Boolean
 *
 * Authorization: Lab technicians
 */
const update = async (req, res) => {
  const labTest = await LabTest.findByPk(req.params.id);

  if (!labTest) return error(res, 'Lab test not found', 404);

  // Update the lab test with request body data
  await labTest.update(req.body);

  // Re-fetch with relationships for the response
  const updated = await LabTest.findByPk(labTest.id, {
    include: labTestIncludes,
  });

  return success(res, formatLabTest(updated));
};

/**
 * DELETE /api/lab-tests/:id
 * Deletes a lab test
 *
 * Note: In production, consider soft-delete for audit trail
 *
 * Authorization: Doctors and admins only
 */
const destroy = async (req, res) => {
  const labTest = await LabTest.findByPk(req.params.id);

  if (!labTest) return error(res, 'Lab test not found', 404);

  await labTest.destroy();

  return success(res, { message: 'Lab test deleted successfully' });
};

/**
 * GET /api/lab-tests/stats
 * Returns aggregate statistics about lab tests
 *
 * Returns:
 * - totalTests: Total number of tests
 * - completed: Number of completed tests
 * - pending: Number pending (includes all non-completed)
 * - critical: Number of critical results
 * - normal: Number with normal interpretation
 * - abnormal: Number with abnormal interpretation
 *
 * Used for lab dashboard
 */
const stats = async (req, res) => {
  const [
    totalTests,
    completed,
    pending,
    critical,
    normal,
    abnormal,
  ] = await Promise.all([
    LabTest.count(),
    LabTest.count({ where: { status: 'Completed' } }),
    LabTest.count({
      where: {
        status: {
          [Op.in]: ['Pending', 'Sample Collected', 'In Progress'],
        },
      },
    }),
    LabTest.count({ where: { isCritical: true, status: 'Completed' } }),
    LabTest.count({ where: { interpretation: 'Normal', status: 'Completed' } }),
    LabTest.count({
      where: {
        interpretation: {
          [Op.in]: ['Abnormal', 'Critical'],
        },
        status: 'Completed',
      },
    }),
  ]);

  return success(res, {
    totalTests,
    completed,
    pending,
    critical,
    normal,
    abnormal,
  });
};

// ====================================
// EXPORTS
// ====================================
module.exports = {
  create,
  list,
  pending,
  critical,
  getOne,
  update,
  destroy,
  stats,
};
