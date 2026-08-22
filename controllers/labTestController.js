const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { resolvePatient } = require('../utils/patientFamily');
const { clinicToday, clinicClockTime } = require('../utils/clinicTime');
const db = require('../models');
const { generateLabTestNumber, generateRequisitionNumber } = require('../utils/generateId');

const { LabTest, Patient, User } = db;

// Attribution prefix by role — doctors read "Dr. X"; nurses/others read plain.
// (The old code hardcoded "Dr." on every order, which mislabels a nurse-raised
// request the moment nurses can raise them.)
const displayName = (user) => {
  if (!user) return null;
  const full = `${user.firstName} ${user.lastName}`.trim();
  return user.role === 'doctor' ? `Dr. ${full}` : full;
};

// The clinician performing an action (e.g. a cancellation), for attribution.
// Returns { name, role } — name is role-aware ("Dr. …" for doctors) to match how
// orderedBy is displayed, so the activity log groups a person consistently.
const actorInfo = async (userId) => {
  const u = await User.findByPk(userId, { attributes: ['firstName', 'lastName', 'role'] });
  return u ? { name: displayName(u), role: u.role } : { name: null, role: null };
};

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
    // Role-aware author display + the raw role so the UI can colour/label it.
    orderedBy: displayName(lt.orderedBy),
    orderedByRole: lt.orderedBy?.role || null,
    // The doctor a nurse-raised request is for (always shown "Dr. …").
    onBehalfOfDoctor: lt.onBehalfOfDoctor
      ? `Dr. ${lt.onBehalfOfDoctor.firstName} ${lt.onBehalfOfDoctor.lastName}`.trim()
      : null,
    onBehalfOfDoctorId: lt.onBehalfOfDoctorId || null,
    requisitionNumber: lt.requisitionNumber || null,
    supersedesRequisition: lt.supersedesRequisition || null,
    price: lt.price != null ? Number(lt.price) : null,
    packageName: lt.packageName || null,
    packageRate: lt.packageRate != null ? Number(lt.packageRate) : null,
    cancelledBy: lt.cancelledBy || null,
    cancelledByRole: lt.cancelledByRole || null,
    cancelledAt: lt.cancelledAt || null,
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
    createdAt: lt.createdAt,
  };

  // For pending tests view, include patient demographics
  if (includePatientDetails && lt.Patient) {
    formatted.age = computeAge(lt.Patient.dateOfBirth);
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
    attributes: ['uhid', 'firstName', 'lastName', 'dateOfBirth', 'gender'],
  },
  {
    model: User,
    as: 'orderedBy',  // This matches the alias in the model relationship
    attributes: ['firstName', 'lastName', 'role'],
  },
  {
    model: User,
    as: 'onBehalfOfDoctor',
    attributes: ['firstName', 'lastName', 'role'],
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
  const { uhid, testType, sampleType, priority, notes, price, onBehalfOfDoctorId } = req.body;

  const family = await resolvePatient(uhid);
  if (!family) return error(res, `Patient ${uhid} not found`, 404);
  if (family.isDeactivated) return error(res, 'This patient profile is inactive. No new lab tests can be ordered.', 403);

  // Step 2: Generate unique test number + a requisition number (a single test is
  // still a one-test requisition, so it groups and prints like any other).
  const testNumber = await generateLabTestNumber(LabTest);
  const requisitionNumber = await generateRequisitionNumber(LabTest);

  // Step 3: Date and time as the clinic experiences them — the pair has to
  // agree. This was a UTC date beside a server-local time.
  const now = new Date();
  const orderedDate = clinicToday(now);            // YYYY-MM-DD
  const orderedTime = clinicClockTime({}, now);    // "10:30 AM"

  // Step 4: Create the lab test
  // CRITICAL: PatientId must be PascalCase (auto-generated FK naming convention)
  const labTest = await LabTest.create({
    testNumber,
    requisitionNumber,
    PatientId: family.patient.id,  // PascalCase FK
    testType,
    sampleType,
    priority: priority || 'Routine',  // Default to Routine if not specified
    orderedById: req.user.id,  // From JWT token (author — doctor OR nurse)
    onBehalfOfDoctorId: onBehalfOfDoctorId || null,
    price: price != null ? price : null,
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
 * POST /api/lab-tests/request
 * Create a lab REQUEST — one or more tests submitted together as a single
 * requisition. This is what the shared request form (doctor consultation +
 * nursing tab) calls.
 *
 * Authorization: doctor, nurse (attribution is stamped from the JWT).
 *
 * Body:
 *   uhid                  patient UHID (required)
 *   priority              'Routine' | 'Urgent' | 'STAT' (default Routine)
 *   notes                 special instructions for the lab (optional)
 *   onBehalfOfDoctorId    REQUIRED when the author is a nurse; the doctor the
 *                         request is for. Ignored for doctor authors.
 *   supersedesRequisition when reissuing: the requisition being replaced — its
 *                         still-open rows are soft-cancelled in the same call.
 *   tests: [{ testType, sampleType, price?, packageName?, packageRate? }]  (>=1)
 */
const createRequest = async (req, res) => {
  const {
    uhid, priority = 'Routine', notes = null,
    onBehalfOfDoctorId = null, supersedesRequisition = null, tests,
  } = req.body;

  if (!uhid) return error(res, 'Patient UHID is required', 400);
  if (!Array.isArray(tests) || tests.length === 0) {
    return error(res, 'A request must include at least one test', 400);
  }
  if (tests.length > 100) return error(res, 'Too many tests in one request', 400);

  const family = await resolvePatient(uhid);
  if (!family) return error(res, `Patient ${uhid} not found`, 404);
  if (family.isDeactivated) return error(res, 'This patient profile is inactive. No new lab tests can be ordered.', 403);

  // A nurse must say which doctor the labs are for. Doctors raise their own.
  const isDoctor = req.user.role === 'doctor';
  if (!isDoctor && !onBehalfOfDoctorId) {
    return error(res, 'Select the doctor you are requesting these labs on behalf of', 400);
  }
  const onBehalfId = isDoctor ? null : onBehalfOfDoctorId;

  // Validate every test up front so we don't half-create a request.
  for (const t of tests) {
    if (!t || !t.testType) return error(res, 'Each test needs a testType', 400);
  }

  const requisitionNumber = await generateRequisitionNumber(LabTest);
  const now = new Date();
  const orderedDate = clinicToday(now);
  const orderedTime = clinicClockTime({}, now);

  // Create rows ONE AT A TIME: generateLabTestNumber reads the current max test
  // number, so each row must be persisted before the next is numbered. A bulk
  // build gave every row the same LAB-YYYY-N and tripped the unique index.
  for (const t of tests) {
    // eslint-disable-next-line no-await-in-loop
    const testNumber = await generateLabTestNumber(LabTest);
    // eslint-disable-next-line no-await-in-loop
    await LabTest.create({
      testNumber,
      requisitionNumber,
      PatientId: family.patient.id,
      testType: t.testType,
      sampleType: t.sampleType || null,
      priority: priority || 'Routine',
      orderedById: req.user.id,
      onBehalfOfDoctorId: onBehalfId,
      price: t.price != null ? t.price : null,
      packageName: t.packageName || null,
      packageRate: t.packageRate != null ? t.packageRate : null,
      supersedesRequisition: supersedesRequisition || null,
      orderedDate,
      orderedTime,
      status: 'Pending',
      notes,
    });
  }

  // Cancel & reissue: soft-cancel the still-open rows of the replaced requisition
  // (merge-aware — same patient family only). The cancelled rows stay on record.
  if (supersedesRequisition) {
    const actor = await actorInfo(req.user.id);
    await LabTest.update(
      { status: 'Cancelled', cancelledBy: actor.name, cancelledByRole: actor.role, cancelledAt: new Date() },
      {
        where: {
          requisitionNumber: supersedesRequisition,
          PatientId: { [Op.in]: family.patientIds },
          status: { [Op.in]: ['Pending', 'Sample Collected'] },
        },
      }
    );
  }

  const created = await LabTest.findAll({
    where: { requisitionNumber, PatientId: { [Op.in]: family.patientIds } },
    include: labTestIncludes,
    order: [['id', 'ASC']],
  });

  return success(res, {
    requisitionNumber,
    labTests: created.map((lt) => formatLabTest(lt)),
  }, 201);
};

/**
 * PUT /api/lab-tests/request/:requisitionNumber
 * Edit a request IN PLACE while it is still fully editable — i.e. every one of
 * its rows is still 'Pending' (the lab has not started on it). Once the lab
 * marks any row Sample Collected / In Progress the request locks and the client
 * must cancel & reissue instead.
 *
 * Reconciles the test set: removed pending tests are dropped, new ones added,
 * and priority / notes / onBehalfOfDoctorId are updated on every row so the
 * whole requisition stays consistent.
 *
 * Authorization: doctor, nurse.
 */
const updateRequest = async (req, res) => {
  const { requisitionNumber } = req.params;
  const { uhid, priority, notes, onBehalfOfDoctorId, tests } = req.body;

  if (!uhid) return error(res, 'Patient UHID is required', 400);
  if (!Array.isArray(tests) || tests.length === 0) {
    return error(res, 'A request must include at least one test', 400);
  }

  const family = await resolvePatient(uhid);
  if (!family) return error(res, 'Patient not found', 404);
  if (family.isDeactivated) return error(res, 'This patient profile is inactive.', 403);

  const existing = await LabTest.findAll({
    where: { requisitionNumber, PatientId: { [Op.in]: family.patientIds } },
  });
  if (existing.length === 0) return error(res, 'Request not found', 404);

  // Editable only while nothing has been acted on. Any row past Pending locks it.
  const locked = existing.some((t) => t.status !== 'Pending');
  if (locked) {
    return error(res, 'This request can no longer be edited — the lab has started on it. Cancel and reissue instead.', 409);
  }

  const isDoctor = req.user.role === 'doctor';
  if (!isDoctor && !onBehalfOfDoctorId) {
    return error(res, 'Select the doctor you are requesting these labs on behalf of', 400);
  }
  const onBehalfId = isDoctor ? null : onBehalfOfDoctorId;

  const now = new Date();
  const orderedDate = clinicToday(now);
  const orderedTime = clinicClockTime({}, now);

  const wantByType = new Map(tests.filter((t) => t && t.testType).map((t) => [t.testType, t]));
  const haveByType = new Map(existing.map((t) => [t.testType, t]));

  // Drop pending rows no longer wanted. These were never sent to the lab (all
  // Pending), so this is editing a draft, not cancelling a live order.
  const toRemove = existing.filter((t) => !wantByType.has(t.testType));
  for (const row of toRemove) {
    // eslint-disable-next-line no-await-in-loop
    await row.destroy();
  }

  // Update the rows we are keeping (shared request fields + per-row package/price).
  for (const [type, t] of wantByType) {
    const row = haveByType.get(type);
    if (!row) continue;
    // eslint-disable-next-line no-await-in-loop
    await row.update({
      sampleType: t.sampleType ?? row.sampleType,
      priority: priority || row.priority,
      notes: notes !== undefined ? notes : row.notes,
      onBehalfOfDoctorId: onBehalfId,
      price: t.price != null ? t.price : row.price,
      packageName: t.packageName || null,
      packageRate: t.packageRate != null ? t.packageRate : null,
    });
  }

  // Add newly-ticked tests as fresh rows on the same requisition.
  const toAdd = [...wantByType.entries()].filter(([type]) => !haveByType.has(type));
  for (const [, t] of toAdd) {
    // eslint-disable-next-line no-await-in-loop
    const testNumber = await generateLabTestNumber(LabTest);
    // eslint-disable-next-line no-await-in-loop
    await LabTest.create({
      testNumber,
      requisitionNumber,
      PatientId: family.patient.id,
      testType: t.testType,
      sampleType: t.sampleType || null,
      priority: priority || 'Routine',
      orderedById: req.user.id,
      onBehalfOfDoctorId: onBehalfId,
      price: t.price != null ? t.price : null,
      packageName: t.packageName || null,
      packageRate: t.packageRate != null ? t.packageRate : null,
      orderedDate,
      orderedTime,
      status: 'Pending',
      notes: notes ?? null,
    });
  }

  const updated = await LabTest.findAll({
    where: { requisitionNumber, PatientId: { [Op.in]: family.patientIds } },
    include: labTestIncludes,
    order: [['id', 'ASC']],
  });

  return success(res, {
    requisitionNumber,
    labTests: updated.map((lt) => formatLabTest(lt)),
  });
};

/**
 * PUT /api/lab-tests/request/:requisitionNumber/cancel
 * Soft-cancel every still-open row of a requisition (status → 'Cancelled').
 * Completed/in-progress rows are left as-is (the work is already done). The
 * records stay for the audit trail.
 *
 * Authorization: doctor, nurse, admin.
 */
const cancelRequest = async (req, res) => {
  const { requisitionNumber } = req.params;
  const { uhid } = req.body;

  if (!uhid) return error(res, 'Patient UHID is required', 400);
  const family = await resolvePatient(uhid);
  if (!family) return error(res, 'Patient not found', 404);

  const actor = await actorInfo(req.user.id);
  const [count] = await LabTest.update(
    { status: 'Cancelled', cancelledBy: actor.name, cancelledByRole: actor.role, cancelledAt: new Date() },
    {
      where: {
        requisitionNumber,
        PatientId: { [Op.in]: family.patientIds },
        status: { [Op.in]: ['Pending', 'Sample Collected'] },
      },
    }
  );

  if (count === 0) return error(res, 'Nothing to cancel — the request is already completed or does not exist', 404);
  return success(res, { requisitionNumber, cancelled: count });
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

  // If filtering by patient UHID, resolve the family and filter by PatientId directly
  if (uhid) {
    const family = await resolvePatient(uhid);
    if (!family) return error(res, 'Patient not found', 404);
    where.PatientId = { [Op.in]: family.patientIds };
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
  createRequest,
  updateRequest,
  cancelRequest,
  list,
  pending,
  critical,
  getOne,
  update,
  destroy,
  stats,
};
