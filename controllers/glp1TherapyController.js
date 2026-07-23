const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { resolvePatient } = require('../utils/patientFamily');
const { evaluateSafetyScreen, buildStoredScreen } = require('../utils/glp1Safety');
const {
  validateSchedule, weeksSince, stepForWeek,
  buildCustomSchedule, reviewWeeksForSchedule,
} = require('../utils/glp1Schedule');
const { buildWeeklySummary } = require('../utils/glp1Summary');
// One formatter, many consumers — /full and /api/glp1-reviews must not drift.
const { formatReview, reviewIncludes } = require('./glp1ReviewController');
const { formatAdministration, administrationIncludes } = require('./glp1AdministrationController');
const db = require('../models');

const {
  sequelize, Glp1Therapy, Glp1Medication, Glp1Review, Glp1Administration, Patient, User,
} = db;

// The standard monitoring schedule. Doctors add weeks per patient on top of this.
const DEFAULT_REVIEW_WEEKS = [4, 8, 12, 24, 36, 52];

// A course that is Active or Paused is still the patient's current course.
const LIVE_STATUSES = ['Active', 'Paused'];

// ====================================
// HELPER FUNCTIONS
// ====================================

const therapyIncludes = [
  { model: Patient,        attributes: ['uhid', 'firstName', 'lastName', 'gender', 'dateOfBirth'] },
  { model: Glp1Medication, attributes: ['id', 'genericName', 'brandName', 'drugClass', 'route', 'strengths'] },
  { model: User, as: 'doctor',         attributes: ['firstName', 'lastName'] },
  { model: User, as: 'stoppedByUser',  attributes: ['firstName', 'lastName'] },
  {
    model: Glp1Therapy,
    as: 'switchedFrom',
    attributes: ['id', 'startDate', 'stoppedAt'],
    include: [{ model: Glp1Medication, attributes: ['genericName'] }],
  },
];

const doctorName = (user) => (user ? `Dr. ${user.firstName} ${user.lastName}` : null);

/**
 * Formats a therapy for the API response.
 * currentWeek and currentStep are derived, never stored — storing them would go
 * stale the moment the clock moved.
 */
const formatTherapy = (therapy) => {
  const t = therapy.dataValues || therapy;
  const schedule = t.doseSchedule || [];

  /**
   * Week numbering is relative to the start of TREATMENT, not to the start of
   * our record of it. A patient who transferred in already 52 weeks into
   * therapy has a ladder beginning at week 52, and startDate is the day we
   * picked them up. Counting from startDate alone would put them at week 0
   * while their ladder sits at 52 — the two would never meet, and no dose step
   * would ever be current.
   */
  const startWeek = schedule[0]?.fromWeek ?? 0;
  const elapsed = t.status === 'Active' ? weeksSince(t.startDate) : null;
  const currentWeek = elapsed === null ? null : startWeek + elapsed;

  return {
    id:              t.id,
    uhid:            t.Patient?.uhid || null,
    patientName:     t.Patient ? `${t.Patient.firstName} ${t.Patient.lastName}` : null,
    medication:      t.Glp1Medication
      ? {
          id:          t.Glp1Medication.id,
          genericName: t.Glp1Medication.genericName,
          brandName:   t.Glp1Medication.brandName,
          drugClass:   t.Glp1Medication.drugClass,
          route:       t.Glp1Medication.route,
          strengths:   t.Glp1Medication.strengths || [],
        }
      : null,
    doctorName:      doctorName(t.doctor),
    indication:      t.indication,
    startDate:       t.startDate,
    startingDose:    t.startingDose,
    targetDose:      t.targetDose,
    otherConditions: t.otherConditions,
    baseline:        t.baseline,
    safetyScreen:    t.safetyScreen,
    doseSchedule:    schedule,
    reviewWeeks:     t.reviewWeeks || DEFAULT_REVIEW_WEEKS,
    regimenType:     t.regimenType || 'standard',
    currentWeek,
    currentStep:     stepForWeek(schedule, currentWeek),
    status:          t.status,
    stopReason:      t.stopReason,
    stoppedByName:   doctorName(t.stoppedByUser),
    stoppedAt:       t.stoppedAt,
    // Present when this course replaced another agent — lets the tool show the
    // switch and the date it happened
    switchedFrom: t.switchedFrom
      ? {
          therapyId:   t.switchedFrom.id,
          genericName: t.switchedFrom.Glp1Medication?.genericName || null,
          startedOn:   t.switchedFrom.startDate,
          switchedOn:  t.switchedFrom.stoppedAt,
        }
      : null,
    switchReason:    t.switchReason,
    createdAt:       t.createdAt,
  };
};

/**
 * Loads a therapy for a write, applying the merge-aware rules that every
 * controller touching patient data has to apply.
 *
 * Returns { therapy } or { err: { message, code } } — never both.
 */
const loadTherapyForWrite = async (id) => {
  const therapy = await Glp1Therapy.findByPk(id, { include: therapyIncludes });
  if (!therapy) return { err: { message: `GLP-1 therapy with ID ${id} not found`, code: 404 } };

  if (!therapy.Patient) {
    return { err: { message: 'This therapy is not linked to a patient record', code: 409 } };
  }

  const family = await resolvePatient(therapy.Patient.uhid);
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
 * GET /api/glp1-therapies?uhid=
 * Lists a patient's GLP-1 courses, newest first.
 *
 * Query parameters:
 * - uhid: Patient UHID (REQUIRED)
 * - status: filter, e.g. 'Active'
 *
 * Authorization: doctor, staff (staff read-only, matching consultation notes)
 */
const list = async (req, res) => {
  try {
    const { uhid, status } = req.query;

    if (!uhid) return error(res, 'Patient UHID is required', 400);

    const family = await resolvePatient(uhid);
    if (!family) return error(res, `Patient ${uhid} not found`, 404);

    // Merge-aware read: a patient whose duplicate was merged keeps a full history
    const where = { PatientId: { [Op.in]: family.patientIds } };
    if (status) where.status = status;

    const therapies = await Glp1Therapy.findAll({
      where,
      include: therapyIncludes,
      order: [['startDate', 'DESC'], ['id', 'DESC']],
    });

    return success(res, { therapies: therapies.map(formatTherapy) });
  } catch (err) {
    console.error('Glp1Therapy.list error:', err);
    return error(res, 'Failed to retrieve GLP-1 therapies', 500);
  }
};

/**
 * GET /api/glp1-therapies/:id/full
 * One call returning everything the Tools accordion needs to open: the therapy,
 * its medication, and every review with its side effects.
 *
 * Deliberately a single request — the rate limiter allows 100 requests per 15
 * minutes per IP, and a doctor opening several patients in a clinic session
 * would otherwise burn through it.
 *
 * Returns the therapy, every active review with its side effects, and the weekly
 * side-effect summary that sits above the entry grid.
 *
 * Authorization: doctor, staff
 */
const getFull = async (req, res) => {
  try {
    const { id } = req.params;

    const therapy = await Glp1Therapy.findByPk(id, { include: therapyIncludes });
    if (!therapy) return error(res, `GLP-1 therapy with ID ${id} not found`, 404);

    const reviews = await Glp1Review.findAll({
      where: { Glp1TherapyId: therapy.id, status: 'active' },
      include: reviewIncludes,
      order: [['weekNumber', 'ASC']],
    });

    const administrations = await Glp1Administration.findAll({
      where: { Glp1TherapyId: therapy.id },
      include: administrationIncludes,
      order: [['weekNumber', 'ASC']],
    });

    const formattedReviews = reviews.map(formatReview);

    return success(res, {
      therapy:         formatTherapy(therapy),
      reviews:         formattedReviews,
      administrations: administrations.map(formatAdministration),
      summary:         buildWeeklySummary(therapy, formattedReviews),
    });
  } catch (err) {
    console.error('Glp1Therapy.getFull error:', err);
    return error(res, 'Failed to retrieve GLP-1 therapy', 500);
  }
};

/**
 * POST /api/glp1-therapies
 * Starts a patient on a GLP-1 / GIP agonist.
 *
 * Authorization: doctors only
 *
 * Request body expects:
 * - uhid, medicationId, startDate
 * - indication: 'T2DM' | 'Obesity' | 'Both'
 * - startingDose, targetDose, otherConditions, baseline
 * - safetyScreen: REQUIRED — see utils/glp1Safety
 * - doseSchedule: optional; copied from the formulary default if omitted
 *
 * Controller auto-sets:
 * - PatientId from the resolved family, doctorId from the JWT
 *
 * Returns 422 when the safety screen is incomplete or a positive finding has no
 * override reason. That is the hard gate — a course cannot be recorded silently.
 */
const create = async (req, res) => {
  try {
    const {
      uhid, medicationId, indication, startDate,
      startingDose, targetDose, otherConditions,
      baseline, safetyScreen, doseSchedule, reviewWeeks,
    } = req.body;

    const family = await resolvePatient(uhid);
    if (!family) return error(res, `Patient ${uhid} not found`, 404);
    if (family.isDeactivated) {
      return error(res, 'This patient profile is inactive. No new therapy can be started.', 403);
    }

    const medication = await Glp1Medication.findByPk(medicationId);
    if (!medication) return error(res, `GLP-1 medication with ID ${medicationId} not found`, 404);
    if (!medication.isActive) {
      return error(res, `${medication.genericName} has been retired from the formulary`, 400);
    }

    // One live course per agent per patient. A second one would make "current
    // dose" ambiguous on the tool and in the record.
    const existing = await Glp1Therapy.findOne({
      where: {
        PatientId:        { [Op.in]: family.patientIds },
        Glp1MedicationId: medication.id,
        status:           { [Op.in]: LIVE_STATUSES },
      },
    });
    if (existing) {
      return error(
        res,
        `This patient already has a ${existing.status.toLowerCase()} course of ${medication.genericName}. ` +
        'Stop it before starting a new one.',
        409
      );
    }

    // --- The hard gate ---
    const evaluation = evaluateSafetyScreen(safetyScreen, family.patient);
    if (!evaluation.ok) return error(res, evaluation.message, evaluation.status);

    const isCustom = req.body.regimenType === 'custom';

    // Patient-scoped copy of the ladder. Editing it later never touches the
    // clinic default on the formulary row.
    //
    // A custom regimen may arrive either as rungs ({ dose, weeks }) which we
    // build into a contiguous ladder, or as a fully-formed doseSchedule.
    let schedule;
    if (isCustom && Array.isArray(req.body.rungs) && req.body.rungs.length) {
      schedule = buildCustomSchedule(req.body.rungs, req.body.startWeek ?? 0);
    } else if (doseSchedule !== undefined) {
      schedule = doseSchedule;
    } else {
      schedule = medication.defaultSchedule || [];
    }

    const check = validateSchedule(schedule);
    if (!check.ok) return error(res, check.message, 400);
    schedule = check.schedule;

    // Explicit weeks win. Otherwise a custom ladder derives its own review
    // points from its dose changes, because the standard 4/8/12 pattern no
    // longer lines up with anything for a patient on a bespoke titration.
    const weeks = Array.isArray(reviewWeeks) && reviewWeeks.length
      ? [...new Set(reviewWeeks.map(Number).filter((w) => Number.isInteger(w) && w >= 0))].sort((a, b) => a - b)
      : isCustom
        ? reviewWeeksForSchedule(schedule)
        : DEFAULT_REVIEW_WEEKS;

    const therapy = await Glp1Therapy.create({
      PatientId:        family.patient.id,          // PascalCase FK
      Glp1MedicationId: medication.id,              // PascalCase FK
      doctorId:         req.user.id,                // From JWT token
      indication:       indication || 'T2DM',
      startDate,
      startingDose:     startingDose ?? null,
      targetDose:       targetDose ?? null,
      otherConditions:  otherConditions ?? null,
      baseline:         baseline ?? null,
      safetyScreen:     buildStoredScreen(safetyScreen, evaluation, req.user.id),
      doseSchedule:     schedule,
      reviewWeeks:      weeks,
      regimenType:      isCustom ? 'custom' : 'standard',
      status:           'Active',
    });

    const full = await Glp1Therapy.findByPk(therapy.id, { include: therapyIncludes });

    return success(res, formatTherapy(full), 201);
  } catch (err) {
    console.error('Glp1Therapy.create error:', err);
    return error(res, 'Failed to start GLP-1 therapy', 500);
  }
};

/**
 * PUT /api/glp1-therapies/:id
 * Updates a course — target dose, indication, other conditions, baseline.
 *
 * Authorization: any doctor, not only the prescriber. A patient may be seen by
 * whichever doctor is on that day, and continuity of care matters more here than
 * authorship does. The prescriber on the record never changes.
 *
 * A stopped or completed course is read-only; reopen it by starting a new one.
 */
const update = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      indication, startDate, startingDose, targetDose,
      otherConditions, baseline, status,
    } = req.body;

    const loaded = await loadTherapyForWrite(id);
    if (loaded.err) return error(res, loaded.err.message, loaded.err.code);

    const { therapy } = loaded;

    if (!LIVE_STATUSES.includes(therapy.status)) {
      return error(res, `This course is ${therapy.status.toLowerCase()} and can no longer be edited`, 403);
    }

    if (indication !== undefined)      therapy.indication      = indication;
    if (startDate !== undefined)       therapy.startDate       = startDate;
    if (startingDose !== undefined)    therapy.startingDose    = startingDose;
    if (targetDose !== undefined)      therapy.targetDose      = targetDose;
    if (otherConditions !== undefined) therapy.otherConditions = otherConditions;
    if (baseline !== undefined)        therapy.baseline        = baseline;

    // Stopping goes through /stop, which requires a reason.
    if (status !== undefined) {
      if (!LIVE_STATUSES.includes(status) && status !== 'Completed') {
        return error(res, 'Status can be set to Active, Paused or Completed. Use /stop to stop a course.', 400);
      }
      therapy.status = status;
    }

    await therapy.save();

    const full = await Glp1Therapy.findByPk(id, { include: therapyIncludes });

    return success(res, formatTherapy(full));
  } catch (err) {
    console.error('Glp1Therapy.update error:', err);
    return error(res, 'Failed to update GLP-1 therapy', 500);
  }
};

/**
 * PATCH /api/glp1-therapies/:id/schedule
 * Replaces the patient's dose ladder — this is how steps are added, edited and
 * removed. The client sends the whole ladder; the server validates it as a
 * whole, because a step is only meaningful next to its neighbours.
 *
 * Authorization: doctors
 */
const updateSchedule = async (req, res) => {
  try {
    const { id } = req.params;
    const { doseSchedule } = req.body;

    const loaded = await loadTherapyForWrite(id);
    if (loaded.err) return error(res, loaded.err.message, loaded.err.code);

    const { therapy } = loaded;

    if (!LIVE_STATUSES.includes(therapy.status)) {
      return error(res, `This course is ${therapy.status.toLowerCase()} and its schedule can no longer be edited`, 403);
    }

    const check = validateSchedule(doseSchedule);
    if (!check.ok) return error(res, check.message, 400);

    therapy.doseSchedule = check.schedule;

    // On a custom regimen the review schedule follows the dose schedule —
    // changing when the patient steps up changes when they need reviewing.
    // Weeks with a review already recorded are kept, so re-planning never
    // hides a visit that happened.
    if (therapy.regimenType === 'custom') {
      const recorded = await Glp1Review.findAll({
        where: { Glp1TherapyId: therapy.id, status: 'active' },
        attributes: ['weekNumber'],
      });
      therapy.reviewWeeks = [...new Set([
        ...reviewWeeksForSchedule(check.schedule),
        ...recorded.map((r) => r.weekNumber),
      ])].sort((a, b) => a - b);
    }

    await therapy.save();

    const full = await Glp1Therapy.findByPk(id, { include: therapyIncludes });

    return success(res, formatTherapy(full));
  } catch (err) {
    console.error('Glp1Therapy.updateSchedule error:', err);
    return error(res, 'Failed to update dose schedule', 500);
  }
};

/**
 * POST /api/glp1-therapies/:id/review-weeks
 * Adds a monitoring week for this patient — week 6 for someone struggling with
 * nausea, say. Does not change the clinic default.
 *
 * Body: { week: 6 }
 *
 * Authorization: doctors
 */
const addReviewWeek = async (req, res) => {
  try {
    const { id } = req.params;
    const { week } = req.body;

    const loaded = await loadTherapyForWrite(id);
    if (loaded.err) return error(res, loaded.err.message, loaded.err.code);

    const { therapy } = loaded;

    const weekNumber = Number(week);
    if (!Number.isInteger(weekNumber) || weekNumber <= 0) {
      return error(res, 'Review week must be a whole number greater than zero', 400);
    }

    const weeks = Array.isArray(therapy.reviewWeeks) ? [...therapy.reviewWeeks] : [...DEFAULT_REVIEW_WEEKS];

    if (weeks.includes(weekNumber)) {
      return error(res, `Week ${weekNumber} is already on this patient's review schedule`, 409);
    }

    weeks.push(weekNumber);
    weeks.sort((a, b) => a - b);

    therapy.reviewWeeks = weeks;
    await therapy.save();

    const full = await Glp1Therapy.findByPk(id, { include: therapyIncludes });

    return success(res, formatTherapy(full));
  } catch (err) {
    console.error('Glp1Therapy.addReviewWeek error:', err);
    return error(res, 'Failed to add review week', 500);
  }
};

/**
 * POST /api/glp1-therapies/:id/stop
 * Stops a course. There is deliberately no delete endpoint — a medication a
 * patient actually took stays in the record.
 *
 * Body: { reason }  — required
 *
 * Authorization: doctors
 */
const stop = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const loaded = await loadTherapyForWrite(id);
    if (loaded.err) return error(res, loaded.err.message, loaded.err.code);

    const { therapy } = loaded;

    if (therapy.status === 'Stopped') {
      return error(res, 'This course has already been stopped', 409);
    }

    const stopReason = typeof reason === 'string' ? reason.trim() : '';
    if (!stopReason) return error(res, 'A reason is required to stop a course', 400);

    therapy.status     = 'Stopped';
    therapy.stopReason = stopReason;
    therapy.stoppedBy  = req.user.id;    // From JWT token
    therapy.stoppedAt  = new Date();

    await therapy.save();

    const full = await Glp1Therapy.findByPk(id, { include: therapyIncludes });

    return success(res, formatTherapy(full));
  } catch (err) {
    console.error('Glp1Therapy.stop error:', err);
    return error(res, 'Failed to stop GLP-1 therapy', 500);
  }
};

/**
 * POST /api/glp1-therapies/:id/switch
 * Moves a patient from one agent to another — semaglutide to tirzepatide, say.
 *
 * Authorization: doctors only. Choosing the agent is a prescribing decision.
 *
 * Body:
 * - medicationId (required) — the agent being switched TO
 * - reason (required)       — why
 * - startDate, startingDose, targetDose, doseSchedule
 *
 * The old course is stopped and the new one records what it replaced, so each
 * agent keeps its own ladder, reviews and injection history. Both happen in one
 * transaction: a patient left stopped on one drug and not started on the other
 * would read as having no therapy at all.
 *
 * The safety screen is carried across rather than re-answered — it was about the
 * patient, not the molecule, and re-asking would invite rubber-stamping. The new
 * course records that it was inherited.
 */
const switchMedication = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.params;
    const { medicationId, reason, startDate, startingDose, targetDose, doseSchedule } = req.body;

    const loaded = await loadTherapyForWrite(id);
    if (loaded.err) {
      await transaction.rollback();
      return error(res, loaded.err.message, loaded.err.code);
    }

    const { therapy, family } = loaded;

    if (!LIVE_STATUSES.includes(therapy.status)) {
      await transaction.rollback();
      return error(res, `This course is ${therapy.status.toLowerCase()} — start a new course instead`, 403);
    }

    const medication = await Glp1Medication.findByPk(medicationId);
    if (!medication) {
      await transaction.rollback();
      return error(res, `GLP-1 medication with ID ${medicationId} not found`, 404);
    }
    if (!medication.isActive) {
      await transaction.rollback();
      return error(res, `${medication.genericName} has been retired from the formulary`, 400);
    }
    if (medication.id === therapy.Glp1MedicationId) {
      await transaction.rollback();
      return error(res, 'The patient is already on this agent', 409);
    }

    const switchReason = typeof reason === 'string' ? reason.trim() : '';
    if (!switchReason) {
      await transaction.rollback();
      return error(res, 'A reason is required to switch agents', 400);
    }

    let schedule;
    if (doseSchedule !== undefined) {
      const check = validateSchedule(doseSchedule);
      if (!check.ok) {
        await transaction.rollback();
        return error(res, check.message, 400);
      }
      schedule = check.schedule;
    } else {
      schedule = medication.defaultSchedule || [];
    }

    const switchDate = startDate || new Date().toISOString().slice(0, 10);

    // 1. Stop the old course
    therapy.status     = 'Stopped';
    therapy.stopReason = `Switched to ${medication.genericName} — ${switchReason}`;
    therapy.stoppedBy  = req.user.id;
    therapy.stoppedAt  = new Date();
    await therapy.save({ transaction });

    // 2. Start the new one, linked back
    const started = await Glp1Therapy.create({
      PatientId:             family.patient.id,
      Glp1MedicationId:      medication.id,
      doctorId:              req.user.id,
      indication:            therapy.indication,
      startDate:             switchDate,
      startingDose:          startingDose ?? null,
      targetDose:            targetDose ?? null,
      otherConditions:       therapy.otherConditions,
      baseline:              therapy.baseline,
      // Carried across from the course being replaced, marked as inherited
      safetyScreen: {
        ...(therapy.safetyScreen || {}),
        carriedFromTherapyId: therapy.id,
        carriedAt:            new Date().toISOString(),
      },
      doseSchedule:          schedule,
      reviewWeeks:           therapy.reviewWeeks || DEFAULT_REVIEW_WEEKS,
      regimenType:           therapy.regimenType || 'standard',
      status:                'Active',
      switchedFromTherapyId: therapy.id,
      switchReason,
    }, { transaction });

    await transaction.commit();

    const full = await Glp1Therapy.findByPk(started.id, { include: therapyIncludes });

    return success(res, formatTherapy(full), 201);
  } catch (err) {
    await transaction.rollback();
    console.error('Glp1Therapy.switchMedication error:', err);
    return error(res, 'Failed to switch GLP-1 agent', 500);
  }
};

// ====================================
// EXPORTS
// ====================================
module.exports = {
  list,
  getFull,
  create,
  update,
  updateSchedule,
  addReviewWeek,
  stop,
  switchMedication,
  DEFAULT_REVIEW_WEEKS,
};
