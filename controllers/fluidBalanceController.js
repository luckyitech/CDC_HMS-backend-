const { success, error } = require('../utils/response');
const db = require('../models');

const { FluidBalanceEntry, Admission, User } = db;

exports.create = async (req, res) => {
  try {
    const { admissionId, direction, type, volumeMl } = req.body;
    const admission = await Admission.findByPk(admissionId);
    if (!admission) return error(res, 'Admission not found', 404);
    if (!direction || volumeMl == null) return error(res, 'direction and volumeMl are required', 400);
    const entry = await FluidBalanceEntry.create({
      AdmissionId: admission.id,
      PatientId: admission.PatientId,
      recordedAt: req.body.recordedAt || new Date(),
      recordedById: req.user.id,
      direction,
      type: type || null,
      volumeMl,
      notes: req.body.notes || null,
    });
    return success(res, entry, 201);
  } catch (err) {
    console.error('FluidBalance.create error:', err);
    return error(res, 'Failed to record fluid entry', 500);
  }
};

exports.list = async (req, res) => {
  try {
    const { admissionId } = req.query;
    if (!admissionId) return error(res, 'admissionId is required', 400);
    const entries = await FluidBalanceEntry.findAll({
      where: { AdmissionId: admissionId, status: 'active' },
      include: [{ model: User, as: 'recordedByUser', attributes: ['firstName', 'lastName'] }],
      order: [['recordedAt', 'DESC']],
    });
    const intake = entries.filter((e) => e.direction === 'Intake').reduce((s, e) => s + e.volumeMl, 0);
    const output = entries.filter((e) => e.direction === 'Output').reduce((s, e) => s + e.volumeMl, 0);
    return success(res, { entries, totals: { intake, output, balance: intake - output } });
  } catch (err) {
    console.error('FluidBalance.list error:', err);
    return error(res, 'Failed to load fluid balance', 500);
  }
};
