const { success, error } = require('../utils/response');
const db = require('../models');

const { Glp1SideEffectCatalog, Glp1SideEffect, User } = db;

// ====================================
// HELPER FUNCTIONS
// ====================================

const formatSymptom = (symptom) => {
  const s = symptom.dataValues || symptom;
  return {
    id:          s.id,
    name:        s.name,
    isActive:    s.isActive,
    sortOrder:   s.sortOrder,
    addedByName: s.addedByUser ? `${s.addedByUser.firstName} ${s.addedByUser.lastName}` : null,
  };
};

const symptomIncludes = [
  { model: User, as: 'addedByUser', attributes: ['firstName', 'lastName'] },
];

// ====================================
// CONTROLLER ACTIONS
// ====================================

/**
 * GET /api/glp1-symptoms
 * The clinic symptom catalogue — the rows offered in the side effects tracker.
 *
 * Query parameters:
 * - active: 'true' (default) hides retired symptoms
 *
 * Authorization: doctor, staff
 */
const list = async (req, res) => {
  try {
    const { active = 'true' } = req.query;

    const where = {};
    if (active !== 'false') where.isActive = true;

    const symptoms = await Glp1SideEffectCatalog.findAll({
      where,
      include: symptomIncludes,
      order: [['sortOrder', 'ASC'], ['name', 'ASC']],
    });

    return success(res, { symptoms: symptoms.map(formatSymptom) });
  } catch (err) {
    console.error('Glp1Symptom.list error:', err);
    return error(res, 'Failed to retrieve symptom catalogue', 500);
  }
};

/**
 * POST /api/glp1-symptoms
 * Adds a symptom to the catalogue. It becomes available for every patient.
 *
 * Authorization: doctor, admin. Unlike the formulary — which is admin-only
 * because it changes which drugs can be prescribed — "Add symptom" sits inside
 * the doctor's tracker and only widens what can be recorded.
 *
 * Controller auto-sets:
 * - addedBy from the JWT
 * - sortOrder to the end of the list, so seeded symptoms keep their order
 */
const create = async (req, res) => {
  try {
    const { name } = req.body;

    const clean = String(name).trim();

    const existing = await Glp1SideEffectCatalog.findOne({ where: { name: clean } });
    if (existing) {
      // Re-activating a retired symptom is kinder than refusing outright — the
      // doctor asked for it by name and it already exists.
      if (!existing.isActive) {
        existing.isActive = true;
        await existing.save();
        return success(res, formatSymptom(existing));
      }
      return error(res, `${existing.name} is already in the symptom list`, 409);
    }

    const highest = await Glp1SideEffectCatalog.max('sortOrder');
    const sortOrder = (Number.isFinite(highest) ? highest : 0) + 10;

    const symptom = await Glp1SideEffectCatalog.create({
      name:      clean,
      isActive:  true,
      sortOrder,
      addedBy:   req.user.id,   // From JWT token
    });

    const full = await Glp1SideEffectCatalog.findByPk(symptom.id, { include: symptomIncludes });

    return success(res, formatSymptom(full), 201);
  } catch (err) {
    console.error('Glp1Symptom.create error:', err);
    return error(res, 'Failed to add symptom', 500);
  }
};

/**
 * DELETE /api/glp1-symptoms/:id
 * Retires a symptom. It stops being offered for new reviews; every review that
 * already recorded it keeps its grading and its wording.
 *
 * Authorization: admin only. Adding a symptom widens what can be recorded and is
 * safe; removing one narrows it for the whole clinic.
 */
const retire = async (req, res) => {
  try {
    const { id } = req.params;

    const symptom = await Glp1SideEffectCatalog.findByPk(id);
    if (!symptom) return error(res, `Symptom with ID ${id} not found`, 404);

    if (!symptom.isActive) {
      return success(res, { message: `${symptom.name} is already retired` });
    }

    const timesRecorded = await Glp1SideEffect.count({ where: { symptomId: symptom.id } });

    symptom.isActive = false;
    await symptom.save();

    return success(res, {
      message: `${symptom.name} retired from the symptom list`,
      timesRecorded,   // so the UI can say how much history references it
    });
  } catch (err) {
    console.error('Glp1Symptom.retire error:', err);
    return error(res, 'Failed to retire symptom', 500);
  }
};

// ====================================
// EXPORTS
// ====================================
module.exports = {
  list,
  create,
  retire,
};
