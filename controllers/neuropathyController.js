const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { resolvePatient } = require('../utils/patientFamily');
const { clinicToday } = require('../utils/clinicTime');
const {
  FEET, SITES, MODALITIES, gradeValue, averageReadings, monoSummary,
} = require('../constants/neuropathy');
const db = require('../models');

const { NeuropathyStudy, NeuropathyReading, Patient, User } = db;

// Neuropathy Studio — controller.
//
// A study is created as a Draft against a UHID (picked first in the portal, so
// every study is patient-linked from the start), readings are upserted while
// it is a Draft, then `complete` computes the per-foot averages + grades
// SERVER-SIDE from the stored readings and locks the study. Cancel is a
// soft-delete with attribution; nothing is ever destroy()'d.

// ====================================
// HELPER FUNCTIONS
// ====================================

const studyIncludes = [
  { model: Patient, attributes: ['uhid', 'firstName', 'lastName', 'gender', 'dateOfBirth'] },
  { model: User, as: 'performedBy', attributes: ['firstName', 'lastName', 'role'] },
  { model: User, as: 'cancelledBy', attributes: ['firstName', 'lastName', 'role'] },
];

const num = (v) => (v === null || v === undefined ? null : Number(v));

const clinicianName = (u) => (u ? `${u.role === 'doctor' ? 'Dr. ' : ''}${u.firstName} ${u.lastName}` : null);

const formatStudy = (study, { withReadings = false } = {}) => {
  const s = study.dataValues || study;
  const out = {
    id: s.id,
    uhid: s.Patient?.uhid || null,
    patientName: s.Patient ? `${s.Patient.firstName} ${s.Patient.lastName}` : null,
    patientGender: s.Patient?.gender || null,
    patientDateOfBirth: s.Patient?.dateOfBirth || null,
    studyDate: s.studyDate,
    protocol: s.protocol,
    status: s.status,
    referral: s.referral,
    performedById: s.performedById,
    performedByName: clinicianName(s.performedBy),
    summary: {
      right: {
        vpt:  { avg: num(s.rightVptAvg),  grade: s.rightVptGrade },
        hot:  { avg: num(s.rightHotAvg),  grade: s.rightHotGrade },
        cold: { avg: num(s.rightColdAvg), grade: s.rightColdGrade },
        mono: { tested: s.rightMonoTested, insensate: s.rightMonoInsensate },
      },
      left: {
        vpt:  { avg: num(s.leftVptAvg),  grade: s.leftVptGrade },
        hot:  { avg: num(s.leftHotAvg),  grade: s.leftHotGrade },
        cold: { avg: num(s.leftColdAvg), grade: s.leftColdGrade },
        mono: { tested: s.leftMonoTested, insensate: s.leftMonoInsensate },
      },
    },
    remarks: s.remarks,
    impression: s.impression,
    completedAt: s.completedAt,
    cancelledAt: s.cancelledAt,
    cancelledByName: clinicianName(s.cancelledBy),
    cancelReason: s.cancelReason,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
  if (withReadings) {
    out.readings = (s.NeuropathyReadings || []).map((r) => ({
      foot: r.foot, site: r.site, modality: r.modality, value: num(r.value), omitted: !!r.omitted,
    }));
  }
  return out;
};

/** Load a study the caller may act on; returns [study] or [null, res-error-sent]. */
const loadStudy = async (id, res, { includeReadings = false } = {}) => {
  const include = includeReadings ? [...studyIncludes, { model: NeuropathyReading }] : studyIncludes;
  const study = await NeuropathyStudy.findByPk(id, { include });
  if (!study) { error(res, 'Neuropathy study not found', 404); return null; }
  return study;
};

/** Compute per-foot summaries from a study's readings (the authoritative grading). */
const computeSummary = (readings) => {
  const pick = (foot, modality) => readings
    .filter((r) => r.foot === foot && r.modality === modality && !r.omitted)
    .map((r) => num(r.value));
  const out = {};
  for (const [foot, prefix] of [['R', 'right'], ['L', 'left']]) {
    for (const [modality, key] of [['VPT', 'Vpt'], ['HOT', 'Hot'], ['COLD', 'Cold']]) {
      const avg = averageReadings(modality, pick(foot, modality));
      out[`${prefix}${key}Avg`]   = avg;
      out[`${prefix}${key}Grade`] = gradeValue(modality, avg);
    }
    const m = monoSummary(pick(foot, 'MONO'));
    out[`${prefix}MonoTested`]    = m.tested || null;
    out[`${prefix}MonoInsensate`] = m.tested ? m.insensate : null;
  }
  return out;
};

// ====================================
// CONTROLLER ACTIONS
// ====================================

/**
 * POST /api/neuropathy
 * Create a Draft study for a patient.
 * Body: { uhid, studyDate?, referral? }   Attribution: performedById from JWT.
 */
const create = async (req, res) => {
  try {
    const { uhid, studyDate, referral } = req.body;

    const family = await resolvePatient(uhid);
    if (!family) return error(res, `Patient ${uhid} not found`, 404);
    if (family.isDeactivated) return error(res, 'This patient profile is inactive. No new studies can be created.', 403);

    const study = await NeuropathyStudy.create({
      PatientId: family.patient.id,
      performedById: req.user.id,
      studyDate: studyDate || clinicToday(),
      protocol: 'plantar',
      status: 'Draft',
      referral: referral || null,
    });

    const full = await NeuropathyStudy.findByPk(study.id, { include: studyIncludes });
    return success(res, formatStudy(full), 201);
  } catch (err) {
    console.error('NeuropathyStudy.create error:', err);
    return error(res, 'Failed to create neuropathy study', 500);
  }
};

/**
 * PUT /api/neuropathy/:id/readings
 * Upsert a batch of site readings on a Draft study.
 * Body: { readings: [{ foot, site, modality, value, omitted? }] }
 */
const saveReadings = async (req, res) => {
  try {
    const study = await loadStudy(req.params.id, res);
    if (!study) return;
    if (study.status !== 'Draft') return error(res, `Study is ${study.status} and can no longer be edited.`, 409);

    const { readings } = req.body;
    if (!Array.isArray(readings) || !readings.length) return error(res, 'readings must be a non-empty array', 400);

    for (const r of readings) {
      if (!FEET.includes(r.foot)) return error(res, `Invalid foot "${r.foot}"`, 400);
      if (!SITES.includes(r.site)) return error(res, `Invalid site "${r.site}"`, 400);
      if (!MODALITIES.includes(r.modality)) return error(res, `Invalid modality "${r.modality}"`, 400);
      const omitted = !!r.omitted;
      const value = omitted || r.value === null || r.value === undefined || r.value === '' ? null : Number(r.value);
      if (value !== null && Number.isNaN(value)) return error(res, `Invalid value for ${r.foot}/${r.site}/${r.modality}`, 400);
      if (value !== null && r.modality === 'MONO' && ![0, 1].includes(value)) return error(res, 'MONO value must be 0 (not felt) or 1 (felt)', 400);
      if (value !== null && r.modality === 'VPT' && (value < 0 || value > 50)) return error(res, 'VPT must be 0–50 volts', 400);
      if (value !== null && (r.modality === 'HOT' || r.modality === 'COLD') && (value < 0 || value > 50)) return error(res, 'Thermal readings must be 0–50 °C', 400);

      const [row, created] = await NeuropathyReading.findOrCreate({
        where: { NeuropathyStudyId: study.id, foot: r.foot, site: r.site, modality: r.modality },
        defaults: { value, omitted },
      });
      if (!created) await row.update({ value, omitted });
    }

    const full = await loadStudy(study.id, res, { includeReadings: true });
    return success(res, formatStudy(full, { withReadings: true }));
  } catch (err) {
    console.error('NeuropathyStudy.saveReadings error:', err);
    return error(res, 'Failed to save readings', 500);
  }
};

/**
 * PUT /api/neuropathy/:id/complete
 * Grade the study server-side from its readings and lock it.
 * Body: { remarks?, impression? }
 */
const complete = async (req, res) => {
  try {
    const study = await loadStudy(req.params.id, res, { includeReadings: true });
    if (!study) return;
    if (study.status !== 'Draft') return error(res, `Study is already ${study.status}.`, 409);

    const readings = study.NeuropathyReadings || [];
    const hasData = readings.some((r) => !r.omitted && r.value !== null && r.value !== undefined);
    if (!hasData) return error(res, 'Record at least one reading before completing the study.', 400);

    const { remarks, impression } = req.body;
    await study.update({
      ...computeSummary(readings),
      remarks: remarks ?? study.remarks,
      impression: impression ?? study.impression,
      status: 'Completed',
      completedAt: new Date(),
    });

    const full = await loadStudy(study.id, res, { includeReadings: true });
    return success(res, formatStudy(full, { withReadings: true }));
  } catch (err) {
    console.error('NeuropathyStudy.complete error:', err);
    return error(res, 'Failed to complete study', 500);
  }
};

/**
 * GET /api/neuropathy?uhid=…&includeCancelled=1&limit=…
 * With uhid: that patient's studies (merge-aware). Without: recent studies
 * for the portal worklist.
 */
const list = async (req, res) => {
  try {
    const { uhid, includeCancelled } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const where = {};

    if (uhid) {
      const family = await resolvePatient(uhid);
      if (!family) return error(res, `Patient ${uhid} not found`, 404);
      where.PatientId = { [Op.in]: family.patientIds };
    }
    if (!includeCancelled) where.status = { [Op.ne]: 'Cancelled' };

    const studies = await NeuropathyStudy.findAll({
      where,
      include: studyIncludes,
      order: [['studyDate', 'DESC'], ['createdAt', 'DESC']],
      limit,
    });
    return success(res, studies.map((s) => formatStudy(s)));
  } catch (err) {
    console.error('NeuropathyStudy.list error:', err);
    return error(res, 'Failed to fetch neuropathy studies', 500);
  }
};

/** GET /api/neuropathy/:id — full study with readings. */
const getById = async (req, res) => {
  try {
    const study = await loadStudy(req.params.id, res, { includeReadings: true });
    if (!study) return;
    return success(res, formatStudy(study, { withReadings: true }));
  } catch (err) {
    console.error('NeuropathyStudy.getById error:', err);
    return error(res, 'Failed to fetch neuropathy study', 500);
  }
};

/**
 * PUT /api/neuropathy/:id/cancel — soft-delete with attribution.
 * Body: { reason? }
 */
const cancel = async (req, res) => {
  try {
    const study = await loadStudy(req.params.id, res);
    if (!study) return;
    if (study.status === 'Cancelled') return error(res, 'Study is already cancelled.', 409);

    await study.update({
      status: 'Cancelled',
      cancelledById: req.user.id,
      cancelledAt: new Date(),
      cancelReason: req.body.reason || null,
    });
    const full = await loadStudy(study.id, res);
    return success(res, formatStudy(full));
  } catch (err) {
    console.error('NeuropathyStudy.cancel error:', err);
    return error(res, 'Failed to cancel study', 500);
  }
};

module.exports = { create, saveReadings, complete, list, getById, cancel };
