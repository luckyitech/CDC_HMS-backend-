const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const db = require('../models');

const { PhysicalExamination, Patient, User } = db;

// ====================================
// HELPER FUNCTIONS
// ====================================

/**
 * Extracts checked items and notes from a section data object.
 * Returns a human-readable text summary for the TEXT column.
 */
const deriveSectionText = (sectionData) => {
  if (!sectionData || typeof sectionData !== 'object') return null;

  const parts = [];

  // Collect checked items (boolean true values)
  const checked = Object.entries(sectionData)
    .filter(([key, val]) => val === true && key !== 'notes')
    .map(([key]) => key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim());

  if (checked.length > 0) {
    parts.push(checked.join(', '));
  }

  // Include notes if present
  if (sectionData.notes) {
    parts.push(sectionData.notes);
  }

  return parts.length > 0 ? parts.join('. ') : null;
};

/**
 * Extracts vital signs into a readable text summary.
 */
const deriveVitalsText = (vitals) => {
  if (!vitals || typeof vitals !== 'object') return null;
  const parts = [];
  if (vitals.bp) parts.push(`BP: ${vitals.bp} mmHg`);
  if (vitals.hr) parts.push(`HR: ${vitals.hr} bpm`);
  if (vitals.rr) parts.push(`RR: ${vitals.rr}/min`);
  if (vitals.temp) parts.push(`Temp: ${vitals.temp}°C`);
  if (vitals.spo2) parts.push(`SpO2: ${vitals.spo2}%`);
  if (vitals.bmi) parts.push(`BMI: ${vitals.bmi}`);
  if (vitals.rbs) parts.push(`RBS: ${vitals.rbs} mmol/L`);
  if (vitals.hba1c) parts.push(`HbA1c: ${vitals.hba1c}%`);
  return parts.length > 0 ? parts.join(', ') : null;
};

/**
 * Formats a single physical examination for the API response.
 * Returns the JSON `data` column (structured form data) for frontend form reloading.
 */
const formatPhysicalExam = (exam) => {
  const e = exam.dataValues || exam;

  return {
    id: e.id,
    uhid: e.Patient?.uhid || null,
    patientName: e.Patient
      ? `${e.Patient.firstName} ${e.Patient.lastName}`
      : null,
    doctorName: e.doctor
      ? `Dr. ${e.doctor.firstName} ${e.doctor.lastName}`
      : null,
    date: e.date,
    time: e.time,
    examFindings: e.examFindings,
    // Return structured JSON data for frontend form reloading
    data: e.data || {
      generalAppearance: e.generalAppearance,
      cardiovascular: e.cardiovascular,
      respiratory: e.respiratory,
      gastrointestinal: e.gastrointestinal,
      neurological: e.neurological,
      musculoskeletal: e.musculoskeletal,
      skin: e.skin,
    },
    lastModified: e.lastModified,
  };
};

/**
 * Reusable "include" configuration for Sequelize queries.
 * Joins the Patient and Doctor tables.
 */
const physicalExamIncludes = [
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
 * POST /api/physical-exams
 * Creates a new physical examination
 *
 * Authorization: Only doctors can create physical exams
 *
 * Request body expects:
 * - uhid: Patient UHID
 * - generalAppearance: General appearance notes
 * - cardiovascular: Cardiovascular system findings
 * - respiratory: Respiratory system findings
 * - gastrointestinal: GI system findings
 * - neurological: Neurological findings
 * - musculoskeletal: Musculoskeletal findings
 * - skin: Skin findings
 * - examFindings: Overall summary/findings
 *
 * Controller auto-sets:
 * - date: Current date
 * - time: Current time
 * - doctorId: From JWT token
 */
const create = async (req, res) => {
  const {
    uhid,
    generalAppearance,
    cardiovascular,
    respiratory,
    gastrointestinal,
    neurological,
    musculoskeletal,
    skin,
    examFindings,
    data,
  } = req.body;

  // Step 1: Find the patient by UHID
  const patient = await Patient.findOne({ where: { uhid } });
  if (!patient) {
    return error(res, `Patient ${uhid} not found`, 404);
  }

  // Step 2: Get current date and time
  const now = new Date();
  const date = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const time = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }); // "14:30:00"

  // Step 3: Derive TEXT column values from structured data if not provided directly
  let derivedGeneral = generalAppearance;
  let derivedCardio = cardiovascular;
  let derivedResp = respiratory;
  let derivedGI = gastrointestinal;
  let derivedNeuro = neurological;
  let derivedMSK = musculoskeletal;
  let derivedSkin = skin;
  let derivedFindings = examFindings;

  if (data && typeof data === 'object') {
    if (!derivedGeneral) derivedGeneral = deriveSectionText(data.general);
    if (!derivedCardio) derivedCardio = deriveSectionText(data.cardiovascular);
    if (!derivedResp) derivedResp = deriveSectionText(data.respiratory);
    if (!derivedGI) derivedGI = deriveSectionText(data.gastrointestinal);
    if (!derivedNeuro) derivedNeuro = deriveSectionText(data.neurological);
    if (!derivedMSK) derivedMSK = deriveSectionText(data.musculoskeletal);
    if (!derivedSkin) derivedSkin = deriveSectionText(data.diabeticFoot);
    if (!derivedFindings) derivedFindings = deriveVitalsText(data.vitalSigns);
  }

  // Step 4: Create the physical examination
  // CRITICAL: PatientId must be PascalCase (auto-generated FK naming convention)
  const physicalExam = await PhysicalExamination.create({
    PatientId: patient.id,  // PascalCase FK
    generalAppearance: derivedGeneral,
    cardiovascular: derivedCardio,
    respiratory: derivedResp,
    gastrointestinal: derivedGI,
    neurological: derivedNeuro,
    musculoskeletal: derivedMSK,
    skin: derivedSkin,
    examFindings: derivedFindings,
    data,
    doctorId: req.user.id,  // From JWT token
    date,
    time,
  });

  // Step 4: Re-fetch with relationships to get complete data
  const full = await PhysicalExamination.findByPk(physicalExam.id, {
    include: physicalExamIncludes,
  });

  return success(res, formatPhysicalExam(full), 201);
};

/**
 * GET /api/physical-exams
 * Lists physical examinations for a specific patient with optional search
 *
 * Query parameters:
 * - uhid: Patient UHID (REQUIRED)
 * - search: Search term (optional) - searches across:
 *   - date
 *   - doctorName
 *   - examFindings
 *   - All body system fields (generalAppearance, cardiovascular, etc.)
 * - page: Page number (default 1)
 * - limit: Items per page (default 20)
 *
 * Search is case-insensitive and uses LIKE with wildcards.
 */
const list = async (req, res) => {
  const { uhid, search, page = 1, limit = 20 } = req.query;

  // uhid is REQUIRED for this endpoint
  if (!uhid) {
    return error(res, 'Patient UHID is required', 400);
  }

  // Calculate pagination offset
  const offset = (parseInt(page) - 1) * parseInt(limit);

  // Build the WHERE clause for search
  // If search is provided, we need to search across multiple fields
  const where = {};
  if (search) {
    // Search across all relevant TEXT fields
    // Note: Don't search date field with LIKE - it causes Sequelize parsing errors
    where[Op.or] = [
      { examFindings: { [Op.like]: `%${search}%` } },
      { generalAppearance: { [Op.like]: `%${search}%` } },
      { cardiovascular: { [Op.like]: `%${search}%` } },
      { respiratory: { [Op.like]: `%${search}%` } },
      { gastrointestinal: { [Op.like]: `%${search}%` } },
      { neurological: { [Op.like]: `%${search}%` } },
      { musculoskeletal: { [Op.like]: `%${search}%` } },
      { skin: { [Op.like]: `%${search}%` } },
    ];
  }

  // Build includes with patient filter
  const includes = [
    {
      model: Patient,
      attributes: ['uhid', 'firstName', 'lastName'],
      where: { uhid },  // Filter by patient UHID
      required: true,   // INNER JOIN
    },
    {
      model: User,
      as: 'doctor',
      attributes: ['firstName', 'lastName'],
      // Doctor name search is complex with JOINs - keep it simple for now
      // Search only searches the main physical exam fields
    },
  ];

  // Fetch physical examinations with count
  const { count, rows } = await PhysicalExamination.findAndCountAll({
    where,
    include: includes,
    order: [['date', 'DESC'], ['time', 'DESC']],  // Newest first
    offset,
    limit: parseInt(limit),
    distinct: true,
  });

  // Format all physical examinations
  const physicalExams = rows.map(formatPhysicalExam);

  return success(res, {
    physicalExams,
    pagination: {
      total: count,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(count / parseInt(limit)),
    },
  });
};

/**
 * GET /api/physical-exams/:id
 * Gets a single physical examination by ID
 */
const getOne = async (req, res) => {
  const physicalExam = await PhysicalExamination.findByPk(req.params.id, {
    include: physicalExamIncludes,
  });

  if (!physicalExam) return error(res, 'Physical examination not found', 404);

  return success(res, formatPhysicalExam(physicalExam));
};

/**
 * PUT /api/physical-exams/:id
 * Updates a physical examination
 *
 * Request body can include any of the body system fields or examFindings.
 * Also sets lastModified to current timestamp.
 *
 * Authorization: Only doctors
 */
const update = async (req, res) => {
  const physicalExam = await PhysicalExamination.findByPk(req.params.id);

  if (!physicalExam) return error(res, 'Physical examination not found', 404);

  // Get current timestamp for lastModified
  const lastModified = new Date().toISOString();

  // Derive TEXT columns from structured data if provided
  const { data } = req.body;
  const derived = {};
  if (data && typeof data === 'object') {
    derived.generalAppearance = deriveSectionText(data.general) || undefined;
    derived.cardiovascular = deriveSectionText(data.cardiovascular) || undefined;
    derived.respiratory = deriveSectionText(data.respiratory) || undefined;
    derived.gastrointestinal = deriveSectionText(data.gastrointestinal) || undefined;
    derived.neurological = deriveSectionText(data.neurological) || undefined;
    derived.musculoskeletal = deriveSectionText(data.musculoskeletal) || undefined;
    derived.skin = deriveSectionText(data.diabeticFoot) || undefined;
    derived.examFindings = deriveVitalsText(data.vitalSigns) || undefined;
  }

  // Update the physical exam with request body data plus derived fields
  await physicalExam.update({
    ...req.body,
    ...derived,
    lastModified,
  });

  // Re-fetch with relationships for the response
  const updated = await PhysicalExamination.findByPk(physicalExam.id, {
    include: physicalExamIncludes,
  });

  return success(res, formatPhysicalExam(updated));
};

/**
 * DELETE /api/physical-exams/:id
 * Deletes a physical examination
 *
 * Note: In production, consider soft-delete for audit trail
 *
 * Authorization: Doctors and admins only
 */
const destroy = async (req, res) => {
  const physicalExam = await PhysicalExamination.findByPk(req.params.id);

  if (!physicalExam) return error(res, 'Physical examination not found', 404);

  await physicalExam.destroy();

  return success(res, { message: 'Physical examination deleted successfully' });
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
