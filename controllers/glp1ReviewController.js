const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { resolvePatient } = require('../utils/patientFamily');
const { doseStepForReview, weeksSince } = require('../utils/glp1Schedule');
const db = require('../models');

const {
  sequelize, Glp1Review, Glp1SideEffect, Glp1SideEffectCatalog,
  Glp1Therapy, Patient, User,
} = db;

const SEVERITIES = ['none', 'mild', 'moderate', 'severe'];

// Reviews can only be recorded against a course that is still running.
const LIVE_STATUSES = ['Active', 'Paused'];

// ====================================
// HELPER FUNCTIONS
// ====================================

// "Dr." only for doctors — a nurse recording a visit should not be titled one.
const clinicianName = (user) => {
  if (!user) return null;
  const prefix = user.role === 'doctor' ? 'Dr. ' : '';
  return `${prefix}${user.firstName} ${user.lastName}`;
};

const reviewIncludes = [
  { model: User, as: 'doctor',        attributes: ['firstName', 'lastName', 'role'] },
  { model: User, as: 'amendedByUser', attributes: ['firstName', 'lastName'] },
  { model: Glp1SideEffect },
];

/**
 * Formats a review for the API response.
 *
 * clinicianName, not doctorName: a monitoring visit is filled in by whoever sees
 * the patient, and at this clinic that is often a nurse. The underlying column
 * is still doctorId — renaming it would be a migration on live data for a label.
 *
 * The author never changes; amendedByName appears alongside when someone has
 * since corrected the entry.
 */
const formatReview = (review) => {
  const r = review.dataValues || review;
  return {
    id:                 r.id,
    therapyId:          r.Glp1TherapyId,
    weekNumber:         r.weekNumber,
    reviewDate:         r.reviewDate,
    weight:             r.weight,
    bmi:                r.bmi,
    waistCircumference: r.waistCircumference,
    bp:                 r.bp,
    heartRate:          r.heartRate,
    fpg:                r.fpg,
    hba1c:              r.hba1c,
    doseAtReview:       r.doseAtReview,
    adherence:          r.adherence,
    actionPlan:         r.actionPlan,
    clinicianName:      clinicianName(r.doctor),
    clinicianRole:      r.doctor?.role || null,
    amendedByName:      clinicianName(r.amendedByUser),
    amendedAt:          r.amendedAt,
    amendmentReason:    r.amendmentReason,
    status:             r.status,
    createdAt:          r.createdAt,
    sideEffects: (r.Glp1SideEffects || [])
      .map((se) => ({
        id:        se.id,
        symptomId: se.symptomId,
        symptom:   se.symptomName,
        severity:  se.severity,
        note:      se.note,
        source:    se.source,
      }))
      .sort((a, b) => a.symptom.localeCompare(b.symptom)),
  };
};

/**
 * Validates the side effects payload against the clinic symptom catalogue.
 * Returns { ok, message, entries } with entries ready to write.
 *
 * symptomName is snapshotted from the catalogue, not taken from the client, so a
 * later rename of a catalogue entry leaves historical reviews reading as written.
 */
const prepareSideEffects = async (sideEffects) => {
  if (sideEffects === undefined) return { ok: true, entries: null };

  if (!Array.isArray(sideEffects)) {
    return { ok: false, message: 'Side effects must be an array' };
  }
  if (!sideEffects.length) return { ok: true, entries: [] };

  const ids = [];
  for (const se of sideEffects) {
    if (!se || typeof se !== 'object') return { ok: false, message: 'Each side effect must be an object' };

    const symptomId = Number(se.symptomId);
    if (!Number.isInteger(symptomId) || symptomId <= 0) {
      return { ok: false, message: 'Each side effect needs a symptomId from the catalogue' };
    }
    if (!SEVERITIES.includes(se.severity)) {
      return { ok: false, message: `Severity must be one of: ${SEVERITIES.join(', ')}` };
    }
    if (ids.includes(symptomId)) {
      return { ok: false, message: 'The same symptom was graded twice in one review' };
    }
    ids.push(symptomId);
  }

  const catalogue = await Glp1SideEffectCatalog.findAll({ where: { id: { [Op.in]: ids } } });
  const byId = new Map(catalogue.map((c) => [c.id, c]));

  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) {
    return { ok: false, message: `Unknown symptom id: ${missing.join(', ')}` };
  }

  const retired = ids.filter((id) => !byId.get(id).isActive);
  if (retired.length) {
    return {
      ok: false,
      message: `These symptoms have been retired from the catalogue: ${retired.map((id) => byId.get(id).name).join(', ')}`,
    };
  }

  const entries = sideEffects.map((se) => {
    const symptomId = Number(se.symptomId);
    return {
      symptomId,
      symptomName: byId.get(symptomId).name,   // snapshot, not client-supplied
      severity:    se.severity,
      note:        typeof se.note === 'string' && se.note.trim() ? se.note.trim() : null,
      source:      'doctor',
    };
  });

  return { ok: true, entries };
};

/**
 * Loads a review and applies the merge-aware access rules.
 * Returns { review, therapy } or { err: { message, code } }.
 */
const loadReviewForWrite = async (id) => {
  const review = await Glp1Review.findByPk(id, {
    include: [
      ...reviewIncludes,
      { model: Glp1Therapy, include: [{ model: Patient, attributes: ['uhid'] }] },
    ],
  });

  if (!review) return { err: { message: `GLP-1 review with ID ${id} not found`, code: 404 } };
  if (review.status === 'deleted') {
    return { err: { message: 'This review has been removed from the record', code: 410 } };
  }

  const uhid = review.Glp1Therapy?.Patient?.uhid;
  if (!uhid) return { err: { message: 'This review is not linked to a patient record', code: 409 } };

  const family = await resolvePatient(uhid);
  if (!family) return { err: { message: 'Patient not found', code: 404 } };
  if (family.isDeactivated) {
    return { err: { message: 'This patient profile is inactive. No changes can be recorded.', code: 403 } };
  }

  return { review, therapy: review.Glp1Therapy, family };
};

const reload = async (id) => {
  const full = await Glp1Review.findByPk(id, { include: reviewIncludes });
  return formatReview(full);
};

// ====================================
// CONTROLLER ACTIONS
// ====================================

/**
 * GET /api/glp1-reviews
 * Lists monitoring reviews.
 *
 * Query parameters — one of:
 * - therapyId: reviews for a single course
 * - uhid: every review for a patient, across courses (merge-aware)
 *
 * Removed reviews are excluded unless includeDeleted=true.
 *
 * Authorization: doctor, staff
 */
const list = async (req, res) => {
  try {
    const { therapyId, uhid, includeDeleted } = req.query;

    if (!therapyId && !uhid) {
      return error(res, 'Either a therapyId or a patient UHID is required', 400);
    }

    const where = {};
    if (includeDeleted !== 'true') where.status = 'active';

    if (therapyId) {
      where.Glp1TherapyId = therapyId;
    } else {
      const family = await resolvePatient(uhid);
      if (!family) return error(res, `Patient ${uhid} not found`, 404);
      // Merge-aware read
      where.PatientId = { [Op.in]: family.patientIds };
    }

    const reviews = await Glp1Review.findAll({
      where,
      include: reviewIncludes,
      order: [['weekNumber', 'ASC'], ['id', 'ASC']],
    });

    return success(res, { reviews: reviews.map(formatReview) });
  } catch (err) {
    console.error('Glp1Review.list error:', err);
    return error(res, 'Failed to retrieve GLP-1 reviews', 500);
  }
};

/**
 * POST /api/glp1-reviews
 * Records a monitoring visit.
 *
 * Authorization: doctors only
 *
 * Request body expects:
 * - therapyId, weekNumber, reviewDate (required)
 * - weight, bmi, waistCircumference, bp, heartRate, fpg, hba1c
 * - doseAtReview: what they were actually on; derived from the ladder if omitted
 * - adherence, actionPlan
 * - sideEffects: [{ symptomId, severity, note }]
 *
 * Controller auto-sets:
 * - doctorId from the JWT — this is the Doctor column, and it locks with the entry
 * - PatientId denormalised from the therapy, for merge-aware reads
 *
 * The review and its side effects are written in one transaction: a review with
 * half its gradings recorded would be worse than no review at all.
 */
const create = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const {
      therapyId, weekNumber, reviewDate,
      weight, bmi, waistCircumference, bp, heartRate, fpg, hba1c,
      doseAtReview, adherence, actionPlan, sideEffects,
    } = req.body;

    const therapy = await Glp1Therapy.findByPk(therapyId, {
      include: [{ model: Patient, attributes: ['uhid'] }],
    });

    if (!therapy) {
      await transaction.rollback();
      return error(res, `GLP-1 therapy with ID ${therapyId} not found`, 404);
    }

    if (!LIVE_STATUSES.includes(therapy.status)) {
      await transaction.rollback();
      return error(res, `This course is ${therapy.status.toLowerCase()} — no further reviews can be recorded`, 403);
    }

    const family = await resolvePatient(therapy.Patient?.uhid);
    if (!family) {
      await transaction.rollback();
      return error(res, 'Patient not found', 404);
    }
    if (family.isDeactivated) {
      await transaction.rollback();
      return error(res, 'This patient profile is inactive. No new reviews can be recorded.', 403);
    }

    // The simplified Kardex is a running, additive log — many entries can fall in
    // the same week (a nurse injection and a doctor review the same week, say), so
    // there is no one-per-week constraint. weekNumber is informational: the whole
    // weeks between the course start and this entry's date. Derived here when the
    // client leaves it out, so the log never asks anyone to count weeks by hand.
    const entryWeek =
      weekNumber === undefined || weekNumber === null || weekNumber === ''
        ? (weeksSince(therapy.startDate, reviewDate ? new Date(`${String(reviewDate).slice(0, 10)}T12:00:00`) : undefined) ?? 0)
        : Number(weekNumber);

    const prepared = await prepareSideEffects(sideEffects);
    if (!prepared.ok) {
      await transaction.rollback();
      return error(res, prepared.message, 400);
    }

    // Fall back to the dose this review is reporting on — the one taken during
    // the interval leading up to it, not the step being started today.
    const scheduledStep = doseStepForReview(therapy.doseSchedule || [], entryWeek);
    const dose = doseAtReview ?? (scheduledStep ? scheduledStep.dose : null);

    const review = await Glp1Review.create({
      Glp1TherapyId:      therapy.id,
      PatientId:          family.patient.id,   // PascalCase FK, denormalised
      doctorId:           req.user.id,         // From JWT token — the Clinician column
      weekNumber:         entryWeek,
      reviewDate,
      weight:             weight ?? null,
      bmi:                bmi ?? null,
      waistCircumference: waistCircumference ?? null,
      bp:                 bp ?? null,
      heartRate:          heartRate ?? null,
      fpg:                fpg ?? null,
      hba1c:              hba1c ?? null,
      doseAtReview:       dose,
      adherence:          adherence ?? null,
      actionPlan:         actionPlan ?? null,
      status:             'active',
    }, { transaction });

    if (prepared.entries && prepared.entries.length) {
      await Glp1SideEffect.bulkCreate(
        prepared.entries.map((e) => ({
          ...e,
          Glp1ReviewId:  review.id,
          Glp1TherapyId: therapy.id,   // denormalised, so course-wide queries need no join
        })),
        { transaction }
      );
    }

    await transaction.commit();

    return success(res, await reload(review.id), 201);
  } catch (err) {
    await transaction.rollback();
    console.error('Glp1Review.create error:', err);
    return error(res, 'Failed to record GLP-1 review', 500);
  }
};

/**
 * PUT /api/glp1-reviews/:id
 * Amends a review.
 *
 * Authorization: doctors. Any doctor may amend, not only the author — the
 * original author stays on the record in doctorName, and the amendment records a
 * second name beside it.
 *
 * amendmentReason is required on every amendment, including on the day the
 * review was written. A medication record should say why it changed.
 *
 * Supplying sideEffects replaces the whole set for this review. Previous
 * gradings are not retained, the same way a previous weight is not — the trail
 * records that the row changed and why, not a field-level history.
 */
const amend = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.params;
    const {
      amendmentReason,
      reviewDate, weight, bmi, waistCircumference, bp, heartRate, fpg, hba1c,
      doseAtReview, adherence, actionPlan, sideEffects,
    } = req.body;

    const loaded = await loadReviewForWrite(id);
    if (loaded.err) {
      await transaction.rollback();
      return error(res, loaded.err.message, loaded.err.code);
    }

    const { review } = loaded;

    const reason = typeof amendmentReason === 'string' ? amendmentReason.trim() : '';
    if (!reason) {
      await transaction.rollback();
      return error(res, 'A reason is required to amend a review', 400);
    }

    const prepared = await prepareSideEffects(sideEffects);
    if (!prepared.ok) {
      await transaction.rollback();
      return error(res, prepared.message, 400);
    }

    if (reviewDate !== undefined)         review.reviewDate         = reviewDate;
    if (weight !== undefined)             review.weight             = weight;
    if (bmi !== undefined)                review.bmi                = bmi;
    if (waistCircumference !== undefined) review.waistCircumference = waistCircumference;
    if (bp !== undefined)                 review.bp                 = bp;
    if (heartRate !== undefined)          review.heartRate          = heartRate;
    if (fpg !== undefined)                review.fpg                = fpg;
    if (hba1c !== undefined)              review.hba1c              = hba1c;
    if (doseAtReview !== undefined)       review.doseAtReview       = doseAtReview;
    if (adherence !== undefined)          review.adherence          = adherence;
    if (actionPlan !== undefined)         review.actionPlan         = actionPlan;

    // The author is never overwritten.
    review.amendedBy       = req.user.id;   // From JWT token
    review.amendedAt       = new Date();
    review.amendmentReason = reason;

    await review.save({ transaction });

    if (prepared.entries !== null) {
      await Glp1SideEffect.destroy({ where: { Glp1ReviewId: review.id }, transaction });

      if (prepared.entries.length) {
        await Glp1SideEffect.bulkCreate(
          prepared.entries.map((e) => ({
            ...e,
            Glp1ReviewId:  review.id,
            Glp1TherapyId: review.Glp1TherapyId,
          })),
          { transaction }
        );
      }
    }

    await transaction.commit();

    return success(res, await reload(review.id));
  } catch (err) {
    await transaction.rollback();
    console.error('Glp1Review.amend error:', err);
    return error(res, 'Failed to amend GLP-1 review', 500);
  }
};

/**
 * DELETE /api/glp1-reviews/:id
 * Removes a review from the record — soft delete only. The row stays, flips to
 * status 'deleted', and the week becomes free for a corrected entry.
 *
 * Authorization: doctors and admins. A reason is required and is kept in the
 * amendment trail, which carries the reason for the most recent change to the
 * row whether that was a correction or a removal.
 */
const remove = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const loaded = await loadReviewForWrite(id);
    if (loaded.err) return error(res, loaded.err.message, loaded.err.code);

    const { review } = loaded;

    const removalReason = typeof reason === 'string' ? reason.trim() : '';
    if (!removalReason) return error(res, 'A reason is required to remove a review', 400);

    review.status          = 'deleted';
    review.deletedBy       = req.user.id;   // From JWT token
    review.deletedAt       = new Date();
    review.amendedBy       = req.user.id;
    review.amendedAt       = new Date();
    review.amendmentReason = removalReason;

    await review.save();

    return success(res, {
      message: `Week ${review.weekNumber} review removed from the record`,
      id: review.id,
    });
  } catch (err) {
    console.error('Glp1Review.remove error:', err);
    return error(res, 'Failed to remove GLP-1 review', 500);
  }
};

// ====================================
// EXPORTS
// ====================================
module.exports = {
  list,
  create,
  amend,
  remove,
  // Shared with glp1TherapyController so /full and /glp1-reviews return the
  // identical shape — one formatter, many consumers.
  formatReview,
  reviewIncludes,
  SEVERITIES,
};
