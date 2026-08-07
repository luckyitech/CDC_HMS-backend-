const { success, error } = require('../utils/response');
const db = require('../models');

const { DischargeSummary, WardRoundNote, ConsultationNote, InpatientMedicationOrder, Admission, Patient, User } = db;

// ====================================
// AUTO-GENERATE a draft by aggregating the admission's doctor notes.
// This is the SEAM: today it's a deterministic aggregation; the planned AI
// report generator drops in here (same input -> richer draft) with no change to
// the review/sign flow. The doctor always reviews and signs.
// ====================================
const buildDraft = async (admission) => {
  const notes = await WardRoundNote.findAll({
    where: { AdmissionId: admission.id, status: ['active', 'amended'] },
    order: [['roundDateTime', 'ASC']],
  });

  const course = notes.map((n) => {
    const d = new Date(n.roundDateTime).toLocaleString();
    const parts = [n.subjective, n.objective, n.assessment, n.plan].filter(Boolean).join(' — ');
    return `[${d}] ${parts}`;
  }).join('\n');

  const meds = await InpatientMedicationOrder.findAll({
    where: { AdmissionId: admission.id },
  });
  const dischargeMeds = meds
    .filter((m) => m.status === 'Active')
    .map((m) => ({ drug: m.drugName, dose: m.dose, route: m.route, schedule: m.frequencyLabel }));

  const lastAssessment = [...notes].reverse().find((n) => n.assessment);

  return {
    finalDiagnoses: admission.provisionalDiagnosis || (lastAssessment ? lastAssessment.assessment : ''),
    proceduresDone: '',
    hospitalCourse: course || 'No ward-round notes recorded.',
    dischargeMeds,
    followUpPlan: notes.length ? (notes[notes.length - 1].plan || '') : '',
    conditionAtDischarge: 'Improved',
    dischargeType: 'Routine',
    generatedBy: 'auto',
  };
};

// POST /api/discharge-summaries/generate  { admissionId }
exports.generate = async (req, res) => {
  try {
    const admission = await Admission.findByPk(req.body.admissionId);
    if (!admission) return error(res, 'Admission not found', 404);
    const draft = await buildDraft(admission);
    return success(res, draft);
  } catch (err) {
    console.error('DischargeSummary.generate error:', err);
    return error(res, 'Failed to generate draft', 500);
  }
};

// POST /api/discharge-summaries — create/save a draft (usually from generate)
exports.create = async (req, res) => {
  try {
    const { admissionId } = req.body;
    const admission = await Admission.findByPk(admissionId);
    if (!admission) return error(res, 'Admission not found', 404);

    // One per admission
    let summary = await DischargeSummary.findOne({ where: { AdmissionId: admission.id } });
    const payload = {
      AdmissionId: admission.id,
      PatientId: admission.PatientId,
      finalDiagnoses: req.body.finalDiagnoses || null,
      proceduresDone: req.body.proceduresDone || null,
      hospitalCourse: req.body.hospitalCourse || null,
      dischargeMeds: req.body.dischargeMeds || null,
      followUpPlan: req.body.followUpPlan || null,
      conditionAtDischarge: req.body.conditionAtDischarge || null,
      dischargeType: req.body.dischargeType || 'Routine',
      generatedBy: req.body.generatedBy || 'manual',
      status: 'draft',
    };
    if (summary) summary = await summary.update(payload);
    else summary = await DischargeSummary.create(payload);
    return success(res, summary, 201);
  } catch (err) {
    console.error('DischargeSummary.create error:', err);
    return error(res, 'Failed to save discharge summary', 500);
  }
};

// PUT /api/discharge-summaries/:id — edit draft or sign
exports.update = async (req, res) => {
  try {
    const summary = await DischargeSummary.findByPk(req.params.id);
    if (!summary) return error(res, 'Discharge summary not found', 404);
    if (summary.status === 'signed') return error(res, 'Summary is already signed', 409);

    const patch = {
      finalDiagnoses: req.body.finalDiagnoses ?? summary.finalDiagnoses,
      proceduresDone: req.body.proceduresDone ?? summary.proceduresDone,
      hospitalCourse: req.body.hospitalCourse ?? summary.hospitalCourse,
      dischargeMeds: req.body.dischargeMeds ?? summary.dischargeMeds,
      followUpPlan: req.body.followUpPlan ?? summary.followUpPlan,
      conditionAtDischarge: req.body.conditionAtDischarge ?? summary.conditionAtDischarge,
      dischargeType: req.body.dischargeType ?? summary.dischargeType,
    };
    if (req.body.sign === true) {
      patch.status = 'signed';
      patch.signedById = req.user.id;
      patch.signedAt = new Date();
    }
    await summary.update(patch);
    return success(res, summary);
  } catch (err) {
    console.error('DischargeSummary.update error:', err);
    return error(res, 'Failed to update discharge summary', 500);
  }
};

// GET /api/discharge-summaries?admissionId=
exports.getByAdmission = async (req, res) => {
  try {
    const { admissionId } = req.query;
    if (!admissionId) return error(res, 'admissionId is required', 400);
    const summary = await DischargeSummary.findOne({
      where: { AdmissionId: admissionId },
      include: [{ model: User, as: 'signedByUser', attributes: ['firstName', 'lastName'] }],
    });
    return success(res, summary);
  } catch (err) {
    console.error('DischargeSummary.getByAdmission error:', err);
    return error(res, 'Failed to load discharge summary', 500);
  }
};
