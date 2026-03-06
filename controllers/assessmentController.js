const { success, error } = require('../utils/response');
const db = require('../models');

const { InitialAssessment, Patient, User } = db;

// ====================================
// HELPER FUNCTIONS
// ====================================

/**
 * Formats a single initial assessment for the API response.
 */
const formatAssessment = (assessment) => {
  const a = assessment.dataValues || assessment;
  return {
    id: a.id,
    uhid: a.Patient?.uhid || null,
    patientName: a.Patient
      ? `${a.Patient.firstName} ${a.Patient.lastName}`
      : null,
    doctorName: a.doctor
      ? `Dr. ${a.doctor.firstName} ${a.doctor.lastName}`
      : null,
    date: a.date,
    time: a.time,
    hpi: a.hpi,
    ros: a.ros,
    pastMedicalHistory: a.pastMedicalHistory,
    familyHistory: a.familyHistory,
    socialHistory: a.socialHistory,
    data: a.data,
  };
};

/**
 * Reusable "include" configuration for Sequelize queries.
 */
const assessmentIncludes = [
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
 * POST /api/assessments
 * Creates a new initial assessment
 *
 * Authorization: Only doctors
 *
 * Request body expects:
 * - uhid: Patient UHID
 * - hpi: History of Present Illness
 * - ros: Review of Systems
 * - pastMedicalHistory: Past medical history
 * - familyHistory: Family history
 * - socialHistory: Social history
 *
 * Controller auto-sets:
 * - date: Current date
 * - time: Current time
 * - doctorId: From JWT token
 */
const create = async (req, res) => {
  const { uhid, hpi, ros, pastMedicalHistory, familyHistory, socialHistory, data } = req.body;

  // Find the patient by UHID
  const patient = await Patient.findOne({ where: { uhid } });
  if (!patient) {
    return error(res, `Patient ${uhid} not found`, 404);
  }

  // Initial assessment is a one-time evaluation — prevent duplicates
  const existing = await InitialAssessment.findOne({ where: { PatientId: patient.id } });
  if (existing) {
    return error(res, 'Initial assessment already exists for this patient. It can only be done once.', 409);
  }

  // Get current date and time
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const time = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

  // Extract TEXT column values from the structured data object if not provided directly
  let derivedHpi = hpi;
  let derivedRos = ros;
  let derivedPastMedical = pastMedicalHistory;
  let derivedFamily = familyHistory;
  let derivedSocial = socialHistory;

  if (data && typeof data === 'object') {
    // HPI: build from presenting complaints checkboxes
    if (!derivedHpi) {
      const complaints = [];
      if (data.weightLoss) complaints.push('Weight Loss');
      if (data.visualDisturbances) complaints.push('Visual Disturbances');
      if (data.increasedThirst) complaints.push('Increased Thirst (Polydipsia)');
      if (data.fatigue) complaints.push('Fatigue');
      if (data.nocturia) complaints.push('Nocturia');
      if (data.paresthesia) complaints.push('Paresthesia');
      if (data.dizziness) complaints.push('Dizziness');
      if (data.legCramps) complaints.push('Leg Cramps');
      if (data.constipation) complaints.push('Constipation');
      if (data.diarrhea) complaints.push('Diarrhea');
      if (data.decreasedLibido) complaints.push('Decreased Libido');
      if (data.otherComplaints) complaints.push(data.otherComplaints);
      if (complaints.length > 0) derivedHpi = complaints.join(', ');
    }

    // ROS: build from diabetic complications screening
    if (!derivedRos) {
      const complications = [];
      if (data.retinopathy) complications.push(`Retinopathy: ${data.retinopathy}`);
      if (data.cerebrovascularDisease) complications.push(`Cerebrovascular Disease: ${data.cerebrovascularDisease}`);
      if (data.cardiovascularDisease) complications.push(`Cardiovascular Disease: ${data.cardiovascularDisease}`);
      if (data.nephropathy) complications.push(`Nephropathy: ${data.nephropathy}`);
      if (data.neuropathyPeripheral) complications.push(`Neuropathy (Peripheral): ${data.neuropathyPeripheral}`);
      if (data.neuropathyAutonomic) complications.push(`Neuropathy (Autonomic): ${data.neuropathyAutonomic}`);
      if (complications.length > 0) derivedRos = complications.join('; ');
    }

    // Family History: direct field from data
    if (!derivedFamily && data.familyHistory) {
      derivedFamily = data.familyHistory;
    }

    // Social History: compose from individual social history fields
    if (!derivedSocial) {
      const social = [];
      if (data.alcoholIntake) social.push(`Alcohol: ${data.alcoholIntake}`);
      if (data.cigaretteSmoking) social.push(`Smoking: ${data.cigaretteSmoking}`);
      if (data.dietType) social.push(`Diet: ${data.dietType}`);
      if (data.exercisePlan) social.push(`Exercise: ${data.exercisePlan}`);
      if (data.substanceUse) social.push(`Substance Use: ${data.substanceUse}`);
      if (social.length > 0) derivedSocial = social.join('; ');
    }
  }

  // Create the assessment
  const assessment = await InitialAssessment.create({
    PatientId: patient.id,  // PascalCase FK
    hpi: derivedHpi,
    ros: derivedRos,
    pastMedicalHistory: derivedPastMedical,
    familyHistory: derivedFamily,
    socialHistory: derivedSocial,
    data,
    doctorId: req.user.id,  // From JWT token
    date,
    time,
  });

  // Re-fetch with relationships
  const full = await InitialAssessment.findByPk(assessment.id, {
    include: assessmentIncludes,
  });

  return success(res, formatAssessment(full), 201);
};

/**
 * GET /api/assessments
 * Lists initial assessments for a specific patient
 *
 * Query parameters:
 * - uhid: Patient UHID (REQUIRED)
 * - page: Page number (default 1)
 * - limit: Items per page (default 20)
 */
const list = async (req, res) => {
  const { uhid, page = 1, limit = 20 } = req.query;

  // uhid is REQUIRED
  if (!uhid) {
    return error(res, 'Patient UHID is required', 400);
  }

  const offset = (parseInt(page) - 1) * parseInt(limit);

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

  const { count, rows } = await InitialAssessment.findAndCountAll({
    include: includes,
    order: [['date', 'DESC'], ['time', 'DESC']],
    offset,
    limit: parseInt(limit),
    distinct: true,
  });

  const assessments = rows.map(formatAssessment);

  return success(res, {
    assessments,
    pagination: {
      total: count,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(count / parseInt(limit)),
    },
  });
};

/**
 * GET /api/assessments/:id
 * Gets a single initial assessment by ID
 */
const getOne = async (req, res) => {
  const assessment = await InitialAssessment.findByPk(req.params.id, {
    include: assessmentIncludes,
  });

  if (!assessment) return error(res, 'Initial assessment not found', 404);

  return success(res, formatAssessment(assessment));
};

/**
 * PUT /api/assessments/:id
 * Updates an initial assessment
 *
 * Authorization: Only doctors
 */
const update = async (req, res) => {
  const assessment = await InitialAssessment.findByPk(req.params.id);

  if (!assessment) return error(res, 'Initial assessment not found', 404);

  // Update with request body data
  await assessment.update(req.body);

  // Re-fetch with relationships
  const updated = await InitialAssessment.findByPk(assessment.id, {
    include: assessmentIncludes,
  });

  return success(res, formatAssessment(updated));
};

/**
 * DELETE /api/assessments/:id
 * Deletes an initial assessment
 *
 * Authorization: Doctors and admins only
 */
const destroy = async (req, res) => {
  const assessment = await InitialAssessment.findByPk(req.params.id);

  if (!assessment) return error(res, 'Initial assessment not found', 404);

  await assessment.destroy();

  return success(res, { message: 'Initial assessment deleted successfully' });
};

// ====================================
// EXPORTS
// ====================================
module.exports = {
  create,
  list,
  getOne,
  update,
  destroy,
};
