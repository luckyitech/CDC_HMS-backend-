const { Op } = require('sequelize');
const { PatientDiagnosis, TreatmentPlan, User } = require('../models');
const { success, error } = require('../utils/response');

/**
 * Patient diagnoses — tracked list on the consultation summary panel.
 * All routes sit behind findPatient middleware (merge-aware):
 *   reads span the whole merge family; writes go to the family head.
 * Clinical record: no hard deletes — "remove" retires (status='resolved').
 */

const format = (d) => ({
  id: d.id,
  diagnosis: d.diagnosis,
  code: d.code || null,
  status: d.status,
  diagnosedAt: d.diagnosedAt,
  resolvedAt: d.resolvedAt,
  addedBy: d.addedBy ? `Dr. ${d.addedBy.firstName} ${d.addedBy.lastName}` : null,
  resolvedBy: d.resolvedBy ? `Dr. ${d.resolvedBy.firstName} ${d.resolvedBy.lastName}` : null,
});

// Parse TreatmentPlan.diagnosis — JSON array of {code, description} or legacy plain string
// (mirrors parseDiagnoses in the frontend's DiagnosisInput).
const parsePlanDiagnoses = (diagnosis) => {
  if (!diagnosis) return [];
  try {
    const parsed = JSON.parse(diagnosis);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* legacy plain string */ }
  return [{ code: '', description: String(diagnosis) }];
};

// Always-import: backfill the tracked list from treatment-plan diagnoses.
// Idempotent — a diagnosis already present (any status, case-insensitive) is skipped,
// so retiring an imported diagnosis sticks. Attribution + date come from the plan.
const syncFromTreatmentPlans = async (req) => {
  const plans = await TreatmentPlan.findAll({
    where: { PatientId: { [Op.in]: req.patientIds } },
    attributes: ['diagnosis', 'date', 'doctorId', 'createdAt'],
    order: [['createdAt', 'ASC']], // oldest first → earliest mention sets diagnosedAt
  });
  if (!plans.length) return;

  const existing = await PatientDiagnosis.findAll({
    where: { PatientId: { [Op.in]: req.patientIds } },
    attributes: ['diagnosis'],
  });
  const seen = new Set(existing.map((d) => d.diagnosis.trim().toLowerCase()));

  for (const plan of plans) {
    for (const { code, description } of parsePlanDiagnoses(plan.diagnosis)) {
      const desc = String(description || '').trim();
      if (!desc || desc.length > 255) continue;
      const key = desc.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      await PatientDiagnosis.create({
        diagnosis: desc,
        code: String(code || '').trim() || null,
        diagnosedAt: plan.date ? new Date(plan.date) : plan.createdAt,
        PatientId: req.patient.id,
        addedById: plan.doctorId || null,
      });
    }
  }
};

// GET /api/patients/:uhid/diagnoses
const list = async (req, res) => {
  try {
    // Treatment plans remain writable for now — keep the tracked list in sync on every read.
    try {
      await syncFromTreatmentPlans(req);
    } catch (syncErr) {
      console.error('PatientDiagnosis.sync error:', syncErr); // non-fatal — still return the list
    }

    const rows = await PatientDiagnosis.findAll({
      where: { PatientId: { [Op.in]: req.patientIds } },
      include: [
        { model: User, as: 'addedBy',    attributes: ['firstName', 'lastName'] },
        { model: User, as: 'resolvedBy', attributes: ['firstName', 'lastName'] },
      ],
      order: [['status', 'ASC'], ['diagnosedAt', 'DESC']], // active first, newest first
    });
    return success(res, { diagnoses: rows.map(format) });
  } catch (err) {
    console.error('PatientDiagnosis.list error:', err);
    return error(res, 'Failed to fetch diagnoses', 500);
  }
};

// POST /api/patients/:uhid/diagnoses   body: { diagnosis, diagnosedAt? }
const create = async (req, res) => {
  try {
    if (req.isDeactivated) {
      return res.status(403).json({ success: false, message: 'This patient profile is inactive. No changes are allowed.' });
    }
    const diagnosis = String(req.body.diagnosis || '').trim();
    if (!diagnosis) return error(res, 'Diagnosis is required.', 400);
    if (diagnosis.length > 255) return error(res, 'Diagnosis must be under 255 characters.', 400);

    // Avoid duplicate ACTIVE entries of the same diagnosis (case-insensitive)
    const existing = await PatientDiagnosis.findOne({
      where: {
        PatientId: { [Op.in]: req.patientIds },
        status: 'active',
        diagnosis: { [Op.like]: diagnosis },
      },
    });
    if (existing) return error(res, 'This diagnosis is already active for the patient.', 409);

    const row = await PatientDiagnosis.create({
      diagnosis,
      code: String(req.body.code || '').trim() || null,
      diagnosedAt: req.body.diagnosedAt ? new Date(req.body.diagnosedAt) : new Date(),
      PatientId: req.patient.id,
      addedById: req.user.id,
    });
    const full = await PatientDiagnosis.findByPk(row.id, {
      include: [{ model: User, as: 'addedBy', attributes: ['firstName', 'lastName'] }],
    });
    return success(res, format(full), 201);
  } catch (err) {
    console.error('PatientDiagnosis.create error:', err);
    return error(res, 'Failed to add diagnosis', 500);
  }
};

// PATCH /api/patients/:uhid/diagnoses/:id/resolve — retire (never delete)
// PATCH /api/patients/:uhid/diagnoses/:id/reactivate — undo a mistaken retire
const setStatus = (nextStatus) => async (req, res) => {
  try {
    if (req.isDeactivated) {
      return res.status(403).json({ success: false, message: 'This patient profile is inactive. No changes are allowed.' });
    }
    const row = await PatientDiagnosis.findOne({
      where: { id: req.params.id, PatientId: { [Op.in]: req.patientIds } },
    });
    if (!row) return error(res, 'Diagnosis not found', 404);
    if (row.status === nextStatus) return error(res, `Diagnosis is already ${nextStatus}.`, 400);

    await row.update(
      nextStatus === 'resolved'
        ? { status: 'resolved', resolvedAt: new Date(), resolvedById: req.user.id }
        : { status: 'active', resolvedAt: null, resolvedById: null }
    );
    const full = await PatientDiagnosis.findByPk(row.id, {
      include: [
        { model: User, as: 'addedBy',    attributes: ['firstName', 'lastName'] },
        { model: User, as: 'resolvedBy', attributes: ['firstName', 'lastName'] },
      ],
    });
    return success(res, format(full));
  } catch (err) {
    console.error(`PatientDiagnosis.${nextStatus} error:`, err);
    return error(res, 'Failed to update diagnosis', 500);
  }
};

module.exports = { list, create, resolve: setStatus('resolved'), reactivate: setStatus('active') };
