const { success, error } = require('../utils/response');
const { accrueBedDays } = require('../utils/inpatientBilling');
const db = require('../models');

const { InpatientCharge, Admission, Ward, User } = db;

// GET /api/inpatient/billing?admissionId= — running account for the stay
exports.getAccount = async (req, res) => {
  try {
    const { admissionId } = req.query;
    if (!admissionId) return error(res, 'admissionId is required', 400);
    const charges = await InpatientCharge.findAll({
      where: { AdmissionId: admissionId, status: 'active' },
      include: [{ model: User, as: 'addedByUser', attributes: ['firstName', 'lastName'] }],
      order: [['chargeDate', 'ASC']],
    });
    const total = charges.reduce((s, c) => s + (c.amount || 0), 0);
    const byCategory = charges.reduce((acc, c) => {
      acc[c.category] = (acc[c.category] || 0) + (c.amount || 0);
      return acc;
    }, {});
    return success(res, { charges, total, byCategory });
  } catch (err) {
    console.error('InpatientBilling.getAccount error:', err);
    return error(res, 'Failed to load inpatient account', 500);
  }
};

// POST /api/inpatient/billing — add an ad-hoc charge
exports.addCharge = async (req, res) => {
  try {
    const { admissionId, category, description, quantity, unitAmount } = req.body;
    const admission = await Admission.findByPk(admissionId);
    if (!admission) return error(res, 'Admission not found', 404);
    if (!description) return error(res, 'description is required', 400);
    const qty = quantity || 1;
    const unit = unitAmount || 0;
    const charge = await InpatientCharge.create({
      AdmissionId: admission.id,
      PatientId: admission.PatientId,
      chargeDate: req.body.chargeDate || new Date(),
      category: category || 'Other',
      description,
      quantity: qty,
      unitAmount: unit,
      amount: qty * unit,
      addedById: req.user.id,
    });
    return success(res, charge, 201);
  } catch (err) {
    console.error('InpatientBilling.addCharge error:', err);
    return error(res, 'Failed to add charge', 500);
  }
};

// POST /api/inpatient/billing/accrue-beddays — post bed-days up to now (per midnight)
exports.accrue = async (req, res) => {
  try {
    const admission = await Admission.findByPk(req.body.admissionId);
    if (!admission) return error(res, 'Admission not found', 404);
    // Rate: explicit override, else the ward's configured bed-day rate.
    let rate = req.body.unitAmount;
    if (rate == null && admission.WardId) {
      const ward = await Ward.findByPk(admission.WardId);
      rate = ward ? ward.ratePerDay : 0;
    }
    const charge = await accrueBedDays(admission, new Date(), req.user.id, undefined, rate || 0);
    return success(res, charge || { message: 'No new bed-days to post' });
  } catch (err) {
    console.error('InpatientBilling.accrue error:', err);
    return error(res, 'Failed to accrue bed-days', 500);
  }
};
