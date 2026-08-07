const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { broadcast } = require('../utils/sseManager');
const { scheduleByCode, DRUG_ROUNDS } = require('../constants/drugSchedules');
const db = require('../models');

const { InpatientMedicationOrder, MedicationAdministration, Admission, User } = db;

// ====================================
// ORDERS
// ====================================
exports.createOrder = async (req, res) => {
  try {
    const { admissionId, drugName, dose, route, scheduleCode, isPRN, isStat } = req.body;
    const admission = await Admission.findByPk(admissionId);
    if (!admission) return error(res, 'Admission not found', 404);
    if (!drugName || !dose) return error(res, 'drugName and dose are required', 400);

    // Resolve round times from the SHARED schedule source; freeze them on the order.
    const sched = scheduleCode ? scheduleByCode(scheduleCode) : null;
    const scheduleTimes = isPRN || isStat ? [] : (sched ? sched.times : []);

    const order = await InpatientMedicationOrder.create({
      AdmissionId: admission.id,
      PatientId: admission.PatientId,
      catalogItemId: req.body.catalogItemId || null,
      drugName, dose,
      route: route || 'PO',
      scheduleCode: scheduleCode || null,
      scheduleTimes,
      frequencyLabel: sched ? sched.label : (req.body.frequencyLabel || null),
      isPRN: !!isPRN,
      prnIndication: req.body.prnIndication || null,
      isStat: !!isStat,
      statTime: req.body.statTime || null,
      startDateTime: req.body.startDateTime || new Date(),
      stopDateTime: req.body.stopDateTime || null,
      prescribedById: req.user.id,
      status: 'Active',
    });

    broadcast('board_updated');
    return success(res, order, 201);
  } catch (err) {
    console.error('MAR.createOrder error:', err);
    return error(res, 'Failed to create medication order', 500);
  }
};

exports.listOrders = async (req, res) => {
  try {
    const { admissionId } = req.query;
    if (!admissionId) return error(res, 'admissionId is required', 400);
    const orders = await InpatientMedicationOrder.findAll({
      where: { AdmissionId: admissionId },
      include: [{ model: User, as: 'prescribedByUser', attributes: ['firstName', 'lastName'] }],
      order: [['createdAt', 'DESC']],
    });
    return success(res, orders);
  } catch (err) {
    console.error('MAR.listOrders error:', err);
    return error(res, 'Failed to load medication orders', 500);
  }
};

exports.updateOrder = async (req, res) => {
  try {
    const order = await InpatientMedicationOrder.findByPk(req.params.id);
    if (!order) return error(res, 'Order not found', 404);
    const { status, stopReason } = req.body;
    const patch = {};
    if (status) {
      patch.status = status;
      if (status === 'Stopped') {
        patch.stoppedById = req.user.id;
        patch.stopReason = stopReason || null;
        patch.stopDateTime = new Date();
      }
    }
    // Allow re-scheduling via a new scheduleCode
    if (req.body.scheduleCode) {
      const sched = scheduleByCode(req.body.scheduleCode);
      patch.scheduleCode = req.body.scheduleCode;
      patch.scheduleTimes = order.isPRN || order.isStat ? [] : (sched ? sched.times : order.scheduleTimes);
      patch.frequencyLabel = sched ? sched.label : order.frequencyLabel;
    }
    if (req.body.dose) patch.dose = req.body.dose;
    await order.update(patch);
    broadcast('board_updated');
    return success(res, order);
  } catch (err) {
    console.error('MAR.updateOrder error:', err);
    return error(res, 'Failed to update order', 500);
  }
};

// ====================================
// DUE-LIST — generated on demand from active orders + shared round times
// GET /api/inpatient/mar/due?admissionId=&round=06:00&date=YYYY-MM-DD
// ====================================
exports.dueList = async (req, res) => {
  try {
    const { admissionId, round } = req.query;
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    if (!admissionId) return error(res, 'admissionId is required', 400);
    if (round && !DRUG_ROUNDS.includes(round)) return error(res, 'Invalid round time', 400);

    const dayStart = new Date(`${date}T00:00:00`);
    const dayEnd = new Date(`${date}T23:59:59`);

    const orders = await InpatientMedicationOrder.findAll({
      where: {
        AdmissionId: admissionId,
        status: 'Active',
        isPRN: false,
        isStat: false,
        startDateTime: { [Op.lte]: dayEnd },
        [Op.or]: [{ stopDateTime: null }, { stopDateTime: { [Op.gte]: dayStart } }],
      },
    });

    const rounds = round ? [round] : DRUG_ROUNDS;
    const items = [];
    for (const order of orders) {
      const times = Array.isArray(order.scheduleTimes) ? order.scheduleTimes : [];
      for (const rt of rounds) {
        if (!times.includes(rt)) continue;
        const admin = await MedicationAdministration.findOne({
          where: { InpatientMedicationOrderId: order.id, scheduledDate: date, roundLabel: rt },
        });
        items.push({
          orderId: order.id,
          drugName: order.drugName,
          dose: order.dose,
          route: order.route,
          round: rt,
          scheduledDate: date,
          status: admin ? admin.status : 'Due',
          administrationId: admin ? admin.id : null,
        });
      }
    }
    items.sort((a, b) => (a.round < b.round ? -1 : 1));
    return success(res, items);
  } catch (err) {
    console.error('MAR.dueList error:', err);
    return error(res, 'Failed to build due list', 500);
  }
};

// POST /api/inpatient/mar/administer — nurse signs a dose (upsert)
exports.administer = async (req, res) => {
  try {
    const { orderId, scheduledDate, roundLabel, status, reason, witnessedById, notes } = req.body;
    if (!orderId || !scheduledDate || !status) {
      return error(res, 'orderId, scheduledDate and status are required', 400);
    }
    if (!['Given', 'Held', 'Refused', 'Omitted', 'NotAvailable'].includes(status)) {
      return error(res, 'Invalid administration status', 400);
    }
    if (status !== 'Given' && !reason) {
      return error(res, 'A reason is required when a dose is not given', 400);
    }

    const order = await InpatientMedicationOrder.findByPk(orderId);
    if (!order) return error(res, 'Order not found', 404);

    const now = new Date();
    const existing = await MedicationAdministration.findOne({
      where: { InpatientMedicationOrderId: orderId, scheduledDate, roundLabel: roundLabel || null },
    });

    const payload = {
      InpatientMedicationOrderId: order.id,
      AdmissionId: order.AdmissionId,
      PatientId: order.PatientId,
      scheduledDate,
      roundLabel: roundLabel || null,
      status,
      administeredAt: now,
      administeredById: req.user.id,
      witnessedById: witnessedById || null,
      reasonIfNotGiven: status === 'Given' ? null : reason,
      notes: notes || null,
    };

    let row;
    if (existing) row = await existing.update(payload);
    else row = await MedicationAdministration.create(payload);

    broadcast('board_updated');
    return success(res, row, existing ? 200 : 201);
  } catch (err) {
    console.error('MAR.administer error:', err);
    return error(res, 'Failed to record administration', 500);
  }
};

// GET /api/inpatient/mar/history?admissionId=
exports.history = async (req, res) => {
  try {
    const { admissionId } = req.query;
    if (!admissionId) return error(res, 'admissionId is required', 400);
    const rows = await MedicationAdministration.findAll({
      where: { AdmissionId: admissionId },
      include: [
        { model: InpatientMedicationOrder, attributes: ['drugName', 'dose', 'route'] },
        { model: User, as: 'administeredByUser', attributes: ['firstName', 'lastName'] },
      ],
      order: [['scheduledDate', 'DESC'], ['roundLabel', 'ASC']],
    });
    return success(res, rows);
  } catch (err) {
    console.error('MAR.history error:', err);
    return error(res, 'Failed to load MAR history', 500);
  }
};
