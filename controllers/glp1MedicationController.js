const { success, error } = require('../utils/response');
const { buildDefaultSchedule, validateSchedule } = require('../utils/glp1Schedule');
const db = require('../models');

const { Glp1Medication, Glp1Therapy, User } = db;

// ====================================
// HELPER FUNCTIONS
// ====================================

const formatMedication = (med) => {
  const m = med.dataValues || med;
  return {
    id:                    m.id,
    genericName:           m.genericName,
    brandName:             m.brandName,
    drugClass:             m.drugClass,
    route:                 m.route,
    strengths:             m.strengths || [],
    defaultSchedule:       m.defaultSchedule || [],
    defaultTitrationWeeks: m.defaultTitrationWeeks,
    isActive:              m.isActive,
    addedByName:           m.addedByUser
      ? `${m.addedByUser.firstName} ${m.addedByUser.lastName}`
      : null,
  };
};

const medicationIncludes = [
  { model: User, as: 'addedByUser', attributes: ['firstName', 'lastName'] },
];

// Strengths arrive as a list of numbers; anything else is a data-entry mistake
// that would break the dose ladder further down.
const normaliseStrengths = (strengths) => {
  if (!Array.isArray(strengths)) return null;

  const cleaned = strengths
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);

  return cleaned.length ? [...new Set(cleaned)] : null;
};

// ====================================
// CONTROLLER ACTIONS
// ====================================

/**
 * GET /api/glp1-medications
 * Lists the clinic formulary — this is what drives the medication tabs.
 *
 * Query parameters:
 * - active: 'true' (default) returns only active agents, 'false' returns all
 *
 * Authorization: doctor, admin
 */
const list = async (req, res) => {
  try {
    const { active = 'true' } = req.query;

    const where = {};
    if (active !== 'false') where.isActive = true;

    const medications = await Glp1Medication.findAll({
      where,
      include: medicationIncludes,
      order: [['genericName', 'ASC']],
    });

    return success(res, { medications: medications.map(formatMedication) });
  } catch (err) {
    console.error('Glp1Medication.list error:', err);
    return error(res, 'Failed to retrieve GLP-1 medications', 500);
  }
};

/**
 * POST /api/glp1-medications
 * Adds an agent to the clinic formulary. It becomes a tab for every patient.
 *
 * Authorization: admin only — a formulary edit changes every patient's options.
 *
 * Request body:
 * - genericName (required), brandName, drugClass, route
 * - strengths: [2.5, 5, 7.5]
 * - defaultTitrationWeeks: weeks per step, default 4
 * - defaultSchedule: optional explicit ladder; generated from strengths if omitted
 *
 * Controller auto-sets:
 * - addedBy: from JWT token
 */
const create = async (req, res) => {
  try {
    const {
      genericName, brandName, drugClass, route,
      strengths, defaultTitrationWeeks, defaultSchedule,
    } = req.body;

    const name = String(genericName).trim();

    // Case-insensitive duplicate check. The unique index is case-insensitive on
    // this MySQL collation, but catching it here gives a readable message.
    const existing = await Glp1Medication.findOne({ where: { genericName: name } });
    if (existing) {
      return error(res, `${existing.genericName} is already in the formulary`, 409);
    }

    const cleanStrengths = normaliseStrengths(strengths);
    if (!cleanStrengths) {
      return error(res, 'At least one available strength is required', 400);
    }

    const titrationWeeks = Number(defaultTitrationWeeks) > 0
      ? Math.floor(Number(defaultTitrationWeeks))
      : 4;

    // An explicit ladder wins; otherwise generate one from the strengths.
    let schedule;
    if (defaultSchedule !== undefined) {
      const check = validateSchedule(defaultSchedule);
      if (!check.ok) return error(res, check.message, 400);
      schedule = check.schedule;
    } else {
      schedule = buildDefaultSchedule(cleanStrengths, titrationWeeks);
    }

    const medication = await Glp1Medication.create({
      genericName:           name,
      brandName:             brandName ? String(brandName).trim() : null,
      drugClass:             drugClass ? String(drugClass).trim() : null,
      route:                 route ? String(route).trim() : null,
      strengths:             cleanStrengths,
      defaultSchedule:       schedule,
      defaultTitrationWeeks: titrationWeeks,
      isActive:              true,
      addedBy:               req.user.id,   // From JWT token
    });

    const full = await Glp1Medication.findByPk(medication.id, { include: medicationIncludes });

    return success(res, formatMedication(full), 201);
  } catch (err) {
    console.error('Glp1Medication.create error:', err);
    return error(res, 'Failed to add GLP-1 medication', 500);
  }
};

/**
 * PUT /api/glp1-medications/:id
 * Updates a formulary entry.
 *
 * Authorization: admin only
 *
 * Note: changing defaultSchedule affects only courses started AFTER the change.
 * Existing patients hold their own copy on the therapy row and are untouched.
 */
const update = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      genericName, brandName, drugClass, route,
      strengths, defaultTitrationWeeks, defaultSchedule, isActive,
    } = req.body;

    const medication = await Glp1Medication.findByPk(id);
    if (!medication) return error(res, `GLP-1 medication with ID ${id} not found`, 404);

    if (genericName !== undefined) {
      const name = String(genericName).trim();
      const clash = await Glp1Medication.findOne({ where: { genericName: name } });
      if (clash && clash.id !== medication.id) {
        return error(res, `${clash.genericName} is already in the formulary`, 409);
      }
      medication.genericName = name;
    }

    if (brandName !== undefined) medication.brandName = brandName ? String(brandName).trim() : null;
    if (drugClass !== undefined) medication.drugClass = drugClass ? String(drugClass).trim() : null;
    if (route !== undefined)     medication.route     = route ? String(route).trim() : null;

    if (strengths !== undefined) {
      const cleanStrengths = normaliseStrengths(strengths);
      if (!cleanStrengths) return error(res, 'At least one available strength is required', 400);
      medication.strengths = cleanStrengths;
    }

    if (defaultTitrationWeeks !== undefined) {
      const weeks = Number(defaultTitrationWeeks);
      if (!Number.isInteger(weeks) || weeks <= 0) {
        return error(res, 'Default titration interval must be a whole number of weeks', 400);
      }
      medication.defaultTitrationWeeks = weeks;
    }

    if (defaultSchedule !== undefined) {
      const check = validateSchedule(defaultSchedule);
      if (!check.ok) return error(res, check.message, 400);
      medication.defaultSchedule = check.schedule;
    }

    if (isActive !== undefined) medication.isActive = Boolean(isActive);

    await medication.save();

    const full = await Glp1Medication.findByPk(id, { include: medicationIncludes });

    return success(res, formatMedication(full));
  } catch (err) {
    console.error('Glp1Medication.update error:', err);
    return error(res, 'Failed to update GLP-1 medication', 500);
  }
};

/**
 * DELETE /api/glp1-medications/:id
 * Retires an agent from the formulary. It stops appearing as a tab for new
 * courses; patients already on it keep their therapy and their history.
 *
 * Authorization: admin only
 *
 * This never destroys the row — therapies reference it.
 */
const retire = async (req, res) => {
  try {
    const { id } = req.params;

    const medication = await Glp1Medication.findByPk(id);
    if (!medication) return error(res, `GLP-1 medication with ID ${id} not found`, 404);

    if (!medication.isActive) {
      return success(res, { message: `${medication.genericName} is already retired` });
    }

    const activeCourses = await Glp1Therapy.count({
      where: { Glp1MedicationId: medication.id, status: 'Active' },
    });

    medication.isActive = false;
    await medication.save();

    return success(res, {
      message: `${medication.genericName} retired from the formulary`,
      activeCourses,     // so the UI can warn: patients still on this agent
    });
  } catch (err) {
    console.error('Glp1Medication.retire error:', err);
    return error(res, 'Failed to retire GLP-1 medication', 500);
  }
};

// ====================================
// EXPORTS
// ====================================
module.exports = {
  list,
  create,
  update,
  retire,
};
