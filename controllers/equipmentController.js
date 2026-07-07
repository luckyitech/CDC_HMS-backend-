const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { encrypt, decrypt } = require('../utils/crypto');
const auditLog = require('../utils/equipmentAudit');
const { resolvePatient } = require('../utils/patientFamily');
const db = require('../models');
const sequelize = require('../config/database');

const { Patient, MedicalEquipment, EquipmentHistory, EquipmentAuditLog, User } = db;

// ====================================
// VALIDATION
// ====================================

const validateEquipmentData = (data) => {
  const { startDate, warrantyStartDate, warrantyEndDate } = data;

  const start        = new Date(startDate);
  const warrantyStart = new Date(warrantyStartDate);
  const warrantyEnd  = new Date(warrantyEndDate);
  const now          = new Date();

  if (warrantyEnd <= warrantyStart) {
    return 'Warranty end date must be after warranty start date';
  }
  if (start > now) {
    return 'Start date cannot be in the future';
  }
  return null;
};

// ====================================
// HELPERS
// ====================================

// Formats a User include for name resolution.
const userInclude = (foreignKey, as) => ({
  model: User,
  as,
  attributes: ['firstName', 'lastName'],
  foreignKey,
});

// Resolves a user include to a display name string.
const userName = (userObj) =>
  userObj ? `${userObj.firstName} ${userObj.lastName}` : null;

// Extracts and encrypts CareLink fields from request body (pump only).
const extractCareLinkData = (body, deviceType) => {
  if (deviceType !== 'pump') return {};
  return {
    careLinkCountry:  body.careLinkCountry  || null,
    careLinkEmail:    body.careLinkEmail    || null,
    careLinkPassword: body.careLinkPassword ? encrypt(body.careLinkPassword) : null,
  };
};

// Decrypts CareLink password in a plain data object (mutates a copy).
const decryptCareLink = (data) => {
  if (!data) return data;
  return {
    ...data,
    careLinkPassword: data.careLinkPassword ? decrypt(data.careLinkPassword) : null,
  };
};

// Builds the full equipment response shape expected by the frontend.
// patientIds is an array — includes merged patients for read operations.
const formatEquipmentResponse = async (patientIds) => {
  const patientFilter = { PatientId: { [Op.in]: patientIds } };

  const [activePump, activeTransmitter] = await Promise.all([
    MedicalEquipment.findOne({
      where: { ...patientFilter, deviceType: 'pump', isActive: true },
      include: [
        userInclude('addedBy', 'addedByUser'),
        userInclude('lastUpdatedBy', 'updatedByUser'),
      ],
    }),
    MedicalEquipment.findOne({
      where: { ...patientFilter, deviceType: 'transmitter', isActive: true },
      include: [
        userInclude('addedBy', 'addedByUser'),
        userInclude('lastUpdatedBy', 'updatedByUser'),
      ],
    }),
  ]);

  const history = await EquipmentHistory.findAll({
    where: patientFilter,
    include: [
      userInclude('addedBy',    'historyAddedByUser'),
      userInclude('archivedBy', 'archivedByUser'),
    ],
    order: [['archivedDate', 'DESC']],
  });

  const pumpData = activePump
    ? decryptCareLink({
        id:                  activePump.id,
        type:                activePump.type,
        serialNo:            activePump.serialNo,
        model:               activePump.model,
        manufacturer:        activePump.manufacturer,
        startDate:           activePump.startDate,
        warrantyStartDate:   activePump.warrantyStartDate,
        warrantyEndDate:     activePump.warrantyEndDate,
        careLinkCountry:     activePump.careLinkCountry,
        careLinkEmail:       activePump.careLinkEmail,
        careLinkPassword:    activePump.careLinkPassword,
        addedBy:             userName(activePump.addedByUser),
        addedDate:           activePump.addedDate,
        lastUpdatedBy:       userName(activePump.updatedByUser),
        lastUpdatedDate:     activePump.lastUpdatedDate,
      })
    : null;

  const transmitterData = activeTransmitter
    ? {
        id:                activeTransmitter.id,
        hasTransmitter:    true,
        type:              activeTransmitter.type,
        serialNo:          activeTransmitter.serialNo,
        startDate:         activeTransmitter.startDate,
        warrantyStartDate: activeTransmitter.warrantyStartDate,
        warrantyEndDate:   activeTransmitter.warrantyEndDate,
        addedBy:           userName(activeTransmitter.addedByUser),
        addedDate:         activeTransmitter.addedDate,
        lastUpdatedBy:     userName(activeTransmitter.updatedByUser),
        lastUpdatedDate:   activeTransmitter.lastUpdatedDate,
      }
    : {
        hasTransmitter:    false,
        type:              null,
        serialNo:          null,
        startDate:         null,
        warrantyStartDate: null,
        warrantyEndDate:   null,
        addedBy:           null,
        addedDate:         null,
        lastUpdatedBy:     null,
        lastUpdatedDate:   null,
      };

  const historyData = history.map((item) => ({
    id:                item.id,
    deviceType:        item.deviceType,
    type:              item.type,
    serialNo:          item.serialNo,
    model:             item.model,
    manufacturer:      item.manufacturer,
    startDate:         item.startDate,
    endDate:           item.endDate,
    reason:            item.reason,
    warrantyStartDate: item.warrantyStartDate,
    warrantyEndDate:   item.warrantyEndDate,
    careLinkCountry:   item.careLinkCountry,
    careLinkEmail:     item.careLinkEmail,
    addedBy:           userName(item.historyAddedByUser),
    addedDate:         item.addedDate,
    archivedBy:        userName(item.archivedByUser),
    archivedDate:      item.archivedDate,
  }));

  return {
    insulinPump: {
      hasPump:     !!activePump,
      current:     pumpData,
      transmitter: transmitterData,
      history:     historyData,
    },
  };
};

// ====================================
// CONTROLLER ACTIONS
// ====================================

// GET /api/patients/:uhid/equipment
const getCurrent = async (req, res) => {
  const { uhid } = req.params;
  try {
    const family = await resolvePatient(uhid);
    if (!family) return error(res, 'Patient not found', 404);

    return success(res, await formatEquipmentResponse(family.patientIds));
  } catch (err) {
    console.error('Equipment GET error:', err.message);
    return error(res, 'Failed to retrieve equipment information. Please try again.', 500);
  }
};

// POST /api/patients/:uhid/equipment
const add = async (req, res) => {
  const { uhid } = req.params;
  const { deviceType, type, serialNo, model, manufacturer, startDate, warrantyStartDate, warrantyEndDate } = req.body;

  try {
    const validationError = validateEquipmentData({ startDate, warrantyStartDate, warrantyEndDate });
    if (validationError) return error(res, validationError, 400);

    const family = await resolvePatient(uhid);
    if (!family) return error(res, 'Patient not found', 404);
    if (family.isDeactivated) return error(res, 'This patient profile is inactive. No new equipment can be added.', 403);

    const { patient, patientIds } = family;

    const existingActive = await MedicalEquipment.findOne({
      where: { PatientId: { [Op.in]: patientIds }, deviceType, isActive: true },
    });
    if (existingActive) {
      return error(res, `Patient already has an active ${deviceType}. Use replace endpoint instead.`, 400);
    }

    const careLinkData = extractCareLinkData(req.body, deviceType);

    const equipment = await MedicalEquipment.create({
      PatientId: patient.id,
      deviceType,
      type,
      serialNo,
      model:        model || null,
      manufacturer: manufacturer || null,
      startDate,
      warrantyStartDate,
      warrantyEndDate,
      ...careLinkData,
      isActive:  true,
      addedBy:   req.user.id,
      addedDate: new Date(),
    });

    await auditLog.recordAdd(patient.id, equipment.id, deviceType, { serialNo }, req.user.id);

    return success(res, await formatEquipmentResponse(patientIds), 201);
  } catch (err) {
    console.error('Equipment ADD error:', err.message);
    return error(res, 'Failed to add equipment. Please try again.', 500);
  }
};

// PUT /api/patients/:uhid/equipment/:id
const update = async (req, res) => {
  const { uhid, id } = req.params;

  const ALLOWED_FIELDS = [
    'type', 'serialNo', 'model', 'manufacturer',
    'startDate', 'warrantyStartDate', 'warrantyEndDate',
    'careLinkCountry', 'careLinkEmail', 'careLinkPassword',
  ];

  try {
    const family = await resolvePatient(uhid);
    if (!family) return error(res, 'Patient not found', 404);
    if (family.isDeactivated) return error(res, 'This patient profile is inactive. Equipment cannot be modified.', 403);

    const { patient, patientIds } = family;

    const equipment = await MedicalEquipment.findOne({
      where: { id, PatientId: { [Op.in]: patientIds }, isActive: true },
    });
    if (!equipment) return error(res, 'Equipment not found or already inactive', 404);

    const updateData = {};
    ALLOWED_FIELDS.forEach((field) => {
      if (req.body[field] !== undefined) {
        updateData[field] = field === 'careLinkPassword'
          ? encrypt(req.body[field])
          : req.body[field];
      }
    });
    updateData.lastUpdatedBy   = req.user.id;
    updateData.lastUpdatedDate = new Date();

    const oldData = {};
    ALLOWED_FIELDS.forEach((field) => { oldData[field] = equipment[field]; });

    await equipment.update(updateData);

    await auditLog.recordEdit(
      patient.id, equipment.id, equipment.deviceType,
      oldData, updateData, req.user.id,
    );

    return success(res, await formatEquipmentResponse(patientIds));
  } catch (err) {
    console.error('Equipment UPDATE error:', err.message);
    return error(res, 'Failed to update equipment. Please try again.', 500);
  }
};

// POST /api/patients/:uhid/equipment/:id/replace
const replace = async (req, res) => {
  const { uhid, id } = req.params;
  const { deviceType, reason, type, serialNo, model, manufacturer, startDate, warrantyStartDate, warrantyEndDate } = req.body;

  let transaction;
  try {
    const validationError = validateEquipmentData({ startDate, warrantyStartDate, warrantyEndDate });
    if (validationError) return error(res, validationError, 400);

    const family = await resolvePatient(uhid);
    if (!family) return error(res, 'Patient not found', 404);
    if (family.isDeactivated) return error(res, 'This patient profile is inactive. Equipment cannot be replaced.', 403);

    const { patient, patientIds } = family;

    const oldEquipment = await MedicalEquipment.findOne({
      where: { id, PatientId: { [Op.in]: patientIds }, isActive: true },
    });
    if (!oldEquipment) return error(res, 'Equipment not found or already inactive', 404);

    if (oldEquipment.deviceType !== deviceType) {
      return error(res, `Device type mismatch. This equipment is a ${oldEquipment.deviceType}, not a ${deviceType}`, 400);
    }

    transaction = await sequelize.transaction();

    await EquipmentHistory.create({
      PatientId:          patient.id,
      MedicalEquipmentId: oldEquipment.id,
      deviceType:         oldEquipment.deviceType,
      type:               oldEquipment.type,
      serialNo:           oldEquipment.serialNo,
      model:              oldEquipment.model,
      manufacturer:       oldEquipment.manufacturer,
      startDate:          oldEquipment.startDate,
      endDate:            new Date(),
      reason,
      warrantyStartDate:  oldEquipment.warrantyStartDate,
      warrantyEndDate:    oldEquipment.warrantyEndDate,
      careLinkCountry:    oldEquipment.careLinkCountry,
      careLinkEmail:      oldEquipment.careLinkEmail,
      careLinkPassword:   oldEquipment.careLinkPassword,
      addedBy:            oldEquipment.addedBy,
      addedDate:          oldEquipment.addedDate,
      archivedBy:         req.user.id,
      archivedDate:       new Date(),
    }, { transaction });

    await oldEquipment.update({ isActive: false }, { transaction });

    const careLinkData = extractCareLinkData(req.body, deviceType);

    const newEquipment = await MedicalEquipment.create({
      PatientId: patient.id,
      deviceType,
      type,
      serialNo,
      model:        model || null,
      manufacturer: manufacturer || null,
      startDate,
      warrantyStartDate,
      warrantyEndDate,
      ...careLinkData,
      isActive:  true,
      addedBy:   req.user.id,
      addedDate: new Date(),
    }, { transaction });

    await transaction.commit();

    await auditLog.recordReplace(
      patient.id, newEquipment.id, deviceType,
      oldEquipment.serialNo, serialNo, reason, req.user.id,
    );

    return success(res, await formatEquipmentResponse(patientIds));
  } catch (err) {
    if (transaction) await transaction.rollback();
    console.error('Equipment REPLACE error:', err.message);
    return error(res, 'Failed to replace equipment. Please try again.', 500);
  }
};

// GET /api/patients/:uhid/equipment/history
const getHistory = async (req, res) => {
  const { uhid } = req.params;
  try {
    const family = await resolvePatient(uhid);
    if (!family) return error(res, 'Patient not found', 404);

    const history = await EquipmentHistory.findAll({
      where: { PatientId: { [Op.in]: family.patientIds } },
      include: [
        userInclude('addedBy',    'historyAddedByUser'),
        userInclude('archivedBy', 'archivedByUser'),
      ],
      order: [['archivedDate', 'DESC']],
    });

    const historyData = history.map((item) => ({
      id:                item.id,
      deviceType:        item.deviceType,
      type:              item.type,
      serialNo:          item.serialNo,
      model:             item.model,
      manufacturer:      item.manufacturer,
      startDate:         item.startDate,
      endDate:           item.endDate,
      reason:            item.reason,
      warrantyStartDate: item.warrantyStartDate,
      warrantyEndDate:   item.warrantyEndDate,
      careLinkCountry:   item.careLinkCountry,
      careLinkEmail:     item.careLinkEmail,
      addedBy:           userName(item.historyAddedByUser),
      addedDate:         item.addedDate,
      archivedBy:        userName(item.archivedByUser),
      archivedDate:      item.archivedDate,
    }));

    return success(res, { history: historyData });
  } catch (err) {
    console.error('Equipment HISTORY error:', err.message);
    return error(res, 'Failed to retrieve equipment history. Please try again.', 500);
  }
};

// GET /api/patients/:uhid/equipment/audit-log
const getAuditLog = async (req, res) => {
  const { uhid } = req.params;
  try {
    const family = await resolvePatient(uhid);
    if (!family) return error(res, 'Patient not found', 404);

    const logs = await EquipmentAuditLog.findAll({
      where: { PatientId: { [Op.in]: family.patientIds } },
      include: [userInclude('changedBy', 'changedByUser')],
      order: [['changedAt', 'DESC']],
    });

    const logData = logs.map((entry) => ({
      id:         entry.id,
      action:     entry.action,
      deviceType: entry.deviceType,
      field:      entry.field,
      oldValue:   entry.oldValue,
      newValue:   entry.newValue,
      summary:    entry.summary,
      changedBy:  userName(entry.changedByUser),
      changedAt:  entry.changedAt,
    }));

    return success(res, { auditLog: logData });
  } catch (err) {
    console.error('Equipment AUDIT LOG error:', err.message);
    return error(res, 'Failed to retrieve audit log. Please try again.', 500);
  }
};

module.exports = { getCurrent, add, update, replace, getHistory, getAuditLog };
