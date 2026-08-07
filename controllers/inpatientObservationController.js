const { success, error } = require('../utils/response');
const { broadcast } = require('../utils/sseManager');
const news2 = require('../utils/news2');
const db = require('../models');

const { InpatientObservation, Admission, Patient, User } = db;

const includes = [
  { model: User, as: 'recordedByUser', attributes: ['firstName', 'lastName'] },
];

// POST /api/inpatient/observations
exports.create = async (req, res) => {
  try {
    const { admissionId } = req.body;
    const admission = await Admission.findByPk(admissionId);
    if (!admission) return error(res, 'Admission not found', 404);

    const params = {
      respRate: req.body.respRate, spo2: req.body.spo2, onOxygen: req.body.onOxygen,
      systolicBP: req.body.systolicBP, diastolicBP: req.body.diastolicBP,
      heartRate: req.body.heartRate, temperature: req.body.temperature,
      consciousness: req.body.consciousness, rbs: req.body.rbs, painScore: req.body.painScore,
    };
    const { total, breakdown, escalation } = news2.score(params);

    const obs = await InpatientObservation.create({
      AdmissionId: admission.id,
      PatientId: admission.PatientId,   // denormalised, canonical
      recordedAt: req.body.recordedAt || new Date(),
      recordedById: req.user.id,
      ...params,
      newsScore: total,
      newsBreakdown: breakdown,
      escalation,
      notes: req.body.notes || null,
    });

    broadcast('board_updated');
    return success(res, obs, 201);
  } catch (err) {
    console.error('InpatientObservation.create error:', err);
    return error(res, 'Failed to record observation', 500);
  }
};

// GET /api/inpatient/observations?admissionId=
exports.list = async (req, res) => {
  try {
    const { admissionId } = req.query;
    if (!admissionId) return error(res, 'admissionId is required', 400);
    const rows = await InpatientObservation.findAll({
      where: { AdmissionId: admissionId, status: ['active', 'amended'] },
      include: includes,
      order: [['recordedAt', 'DESC']],
    });
    return success(res, rows);
  } catch (err) {
    console.error('InpatientObservation.list error:', err);
    return error(res, 'Failed to load observations', 500);
  }
};

// PUT /api/inpatient/observations/:id — amend (never destroy). Keeps original
// values in newsBreakdown.previous and re-scores from the corrected params.
exports.amend = async (req, res) => {
  try {
    const obs = await InpatientObservation.findByPk(req.params.id);
    if (!obs) return error(res, 'Observation not found', 404);

    const previous = { values: obs.toJSON(), amendedAt: new Date() };
    const params = {
      respRate: req.body.respRate ?? obs.respRate,
      spo2: req.body.spo2 ?? obs.spo2,
      onOxygen: req.body.onOxygen ?? obs.onOxygen,
      systolicBP: req.body.systolicBP ?? obs.systolicBP,
      diastolicBP: req.body.diastolicBP ?? obs.diastolicBP,
      heartRate: req.body.heartRate ?? obs.heartRate,
      temperature: req.body.temperature ?? obs.temperature,
      consciousness: req.body.consciousness ?? obs.consciousness,
      rbs: req.body.rbs ?? obs.rbs,
      painScore: req.body.painScore ?? obs.painScore,
    };
    const { total, breakdown, escalation } = news2.score(params);

    await obs.update({
      ...params,
      notes: req.body.notes ?? obs.notes,
      newsScore: total,
      newsBreakdown: { ...breakdown, previous },
      escalation,
      status: 'amended',
      amendedById: req.user.id,
      amendedAt: new Date(),
    });

    broadcast('board_updated');
    return success(res, obs);
  } catch (err) {
    console.error('InpatientObservation.amend error:', err);
    return error(res, 'Failed to amend observation', 500);
  }
};
