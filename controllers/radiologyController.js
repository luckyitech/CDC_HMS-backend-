const { success, error } = require('../utils/response');
const db = require('../models');

const { RadiologyOrder, Admission, Patient, User } = db;

exports.create = async (req, res) => {
  try {
    const { admissionId, modality, region, clinicalDetails, priority } = req.body;
    const admission = await Admission.findByPk(admissionId);
    if (!admission) return error(res, 'Admission not found', 404);
    if (!region) return error(res, 'region is required', 400);
    const order = await RadiologyOrder.create({
      AdmissionId: admission.id,
      PatientId: admission.PatientId,
      modality: modality || 'XRay',
      region,
      clinicalDetails: clinicalDetails || null,
      priority: priority || 'Routine',
      orderedById: req.user.id,
      status: 'Ordered',
    });
    return success(res, order, 201);
  } catch (err) {
    console.error('Radiology.create error:', err);
    return error(res, 'Failed to create radiology order', 500);
  }
};

exports.list = async (req, res) => {
  try {
    const where = {};
    if (req.query.admissionId) where.AdmissionId = req.query.admissionId;
    if (req.query.status) where.status = req.query.status;
    const orders = await RadiologyOrder.findAll({
      where,
      include: [
        { model: Patient, attributes: ['uhid', 'firstName', 'lastName'] },
        { model: User, as: 'orderedByUser', attributes: ['firstName', 'lastName'] },
      ],
      order: [['createdAt', 'DESC']],
    });
    return success(res, orders);
  } catch (err) {
    console.error('Radiology.list error:', err);
    return error(res, 'Failed to load radiology orders', 500);
  }
};

// Radiographer files a report
exports.report = async (req, res) => {
  try {
    const order = await RadiologyOrder.findByPk(req.params.id);
    if (!order) return error(res, 'Order not found', 404);
    await order.update({
      reportText: req.body.reportText ?? order.reportText,
      documentId: req.body.documentId ?? order.documentId,
      status: req.body.status || 'Reported',
      reportedById: req.user.id,
      reportedAt: new Date(),
    });
    return success(res, order);
  } catch (err) {
    console.error('Radiology.report error:', err);
    return error(res, 'Failed to file report', 500);
  }
};
