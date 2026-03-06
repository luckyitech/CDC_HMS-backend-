const { success, error } = require('../utils/response');
const db = require('../models');
const sequelize = require('../config/database');

const { Patient, MedicalEquipment, EquipmentHistory, User } = db;

// ====================================
// HELPER FUNCTIONS
// ====================================

/**
 * Validates equipment business logic (dates, etc.)
 */
const validateEquipmentData = (data) => {
  const { startDate, warrantyStartDate, warrantyEndDate } = data;

  const start = new Date(startDate);
  const warrantyStart = new Date(warrantyStartDate);
  const warrantyEnd = new Date(warrantyEndDate);
  const now = new Date();
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(now.getFullYear() - 1);

  // Warranty end must be after warranty start
  if (warrantyEnd <= warrantyStart) {
    return 'Warranty end date must be after warranty start date';
  }

  // Start date should be reasonable (not more than 1 year in the past, not in the future)
  if (start > now) {
    return 'Start date cannot be in the future';
  }
  if (start < oneYearAgo) {
    return 'Start date cannot be more than 1 year in the past';
  }

  return null; // No errors
};

/**
 * Formats equipment data for the response.
 * Returns the exact shape required by the frontend.
 */
const formatEquipmentResponse = async (patientId) => {
  // Find active pump and transmitter for this patient
  const activePump = await MedicalEquipment.findOne({
    where: {
      PatientId: patientId,
      deviceType: 'pump',
      isActive: true,
    },
    include: [
      {
        model: User,
        as: 'addedByUser',
        attributes: ['firstName', 'lastName'],
      },
      {
        model: User,
        as: 'updatedByUser',
        attributes: ['firstName', 'lastName'],
      },
    ],
  });

  const activeTransmitter = await MedicalEquipment.findOne({
    where: {
      PatientId: patientId,
      deviceType: 'transmitter',
      isActive: true,
    },
    include: [
      {
        model: User,
        as: 'addedByUser',
        attributes: ['firstName', 'lastName'],
      },
      {
        model: User,
        as: 'updatedByUser',
        attributes: ['firstName', 'lastName'],
      },
    ],
  });

  // Get equipment history
  const history = await EquipmentHistory.findAll({
    where: { PatientId: patientId },
    include: [
      {
        model: User,
        as: 'archivedByUser',
        attributes: ['firstName', 'lastName'],
      },
    ],
    order: [['archivedDate', 'DESC']],
  });

  // Format pump data
  const pumpData = activePump
    ? {
        id: activePump.id,
        type: activePump.type,
        serialNo: activePump.serialNo,
        model: activePump.model,
        manufacturer: activePump.manufacturer,
        startDate: activePump.startDate,
        warrantyStartDate: activePump.warrantyStartDate,
        warrantyEndDate: activePump.warrantyEndDate,
        addedBy: activePump.addedByUser
          ? `${activePump.addedByUser.firstName} ${activePump.addedByUser.lastName}`
          : null,
        addedDate: activePump.addedDate,
        lastUpdatedBy: activePump.updatedByUser
          ? `${activePump.updatedByUser.firstName} ${activePump.updatedByUser.lastName}`
          : null,
        lastUpdatedDate: activePump.lastUpdatedDate,
      }
    : null;

  // Format transmitter data
  const transmitterData = activeTransmitter
    ? {
        id: activeTransmitter.id,
        hasTransmitter: true,
        type: activeTransmitter.type,
        serialNo: activeTransmitter.serialNo,
        startDate: activeTransmitter.startDate,
        warrantyStartDate: activeTransmitter.warrantyStartDate,
        warrantyEndDate: activeTransmitter.warrantyEndDate,
        addedBy: activeTransmitter.addedByUser
          ? `${activeTransmitter.addedByUser.firstName} ${activeTransmitter.addedByUser.lastName}`
          : null,
        addedDate: activeTransmitter.addedDate,
        lastUpdatedBy: activeTransmitter.updatedByUser
          ? `${activeTransmitter.updatedByUser.firstName} ${activeTransmitter.updatedByUser.lastName}`
          : null,
        lastUpdatedDate: activeTransmitter.lastUpdatedDate,
      }
    : {
        hasTransmitter: false,
        type: null,
        serialNo: null,
        startDate: null,
        warrantyStartDate: null,
        warrantyEndDate: null,
        addedBy: null,
        addedDate: null,
        lastUpdatedBy: null,
        lastUpdatedDate: null,
      };

  // Format history
  const historyData = history.map((item) => ({
    id: item.id,
    deviceType: item.deviceType,
    serialNo: item.serialNo,
    model: item.model,
    manufacturer: item.manufacturer,
    startDate: item.startDate,
    endDate: item.endDate,
    reason: item.reason,
    warrantyStartDate: item.warrantyStartDate,
    warrantyEndDate: item.warrantyEndDate,
    archivedBy: item.archivedByUser
      ? `${item.archivedByUser.firstName} ${item.archivedByUser.lastName}`
      : null,
    archivedDate: item.archivedDate,
  }));

  // Return the exact shape expected by frontend
  return {
    insulinPump: {
      hasPump: !!activePump,
      current: pumpData,
      transmitter: transmitterData,
      history: historyData,
    },
  };
};

// ====================================
// CONTROLLER ACTIONS
// ====================================

/**
 * GET /api/patients/:uhid/equipment
 * Gets current equipment for a patient
 *
 * Authorization: Doctor, Staff
 */
const getCurrent = async (req, res) => {
  const { uhid } = req.params;

  try {
    // Find patient
    const patient = await Patient.findOne({ where: { uhid } });
    if (!patient) {
      return error(res, 'Patient not found', 404);
    }

    const equipmentData = await formatEquipmentResponse(patient.id);
    return success(res, equipmentData);
  } catch (err) {
    console.error('Equipment GET error:', err.message);
    return error(res, 'Failed to retrieve equipment information. Please try again.', 500);
  }
};

/**
 * POST /api/patients/:uhid/equipment
 * Adds new equipment (pump or transmitter)
 *
 * Authorization: Doctor, Staff
 *
 * Request body:
 * - deviceType: 'pump' | 'transmitter'
 * - type: 'new' | 'replacement' | 'loaner'
 * - serialNo: string
 * - model: string (for pump)
 * - manufacturer: string (for pump)
 * - startDate: YYYY-MM-DD
 * - warrantyStartDate: YYYY-MM-DD
 * - warrantyEndDate: YYYY-MM-DD
 */
const add = async (req, res) => {
  const { uhid } = req.params;
  const {
    deviceType,
    type,
    serialNo,
    model,
    manufacturer,
    startDate,
    warrantyStartDate,
    warrantyEndDate,
  } = req.body;

  try {
    // Validate business logic
    const validationError = validateEquipmentData({ startDate, warrantyStartDate, warrantyEndDate });
    if (validationError) {
      return error(res, validationError, 400);
    }

    // Find patient
    const patient = await Patient.findOne({ where: { uhid } });
    if (!patient) {
      return error(res, 'Patient not found', 404);
    }

    // Check if there's already an active device of this type
    const existingActive = await MedicalEquipment.findOne({
      where: {
        PatientId: patient.id,
        deviceType,
        isActive: true,
      },
    });

    if (existingActive) {
      return error(
        res,
        `Patient already has an active ${deviceType}. Use replace endpoint instead.`,
        400
      );
    }

    // Create equipment
    const equipment = await MedicalEquipment.create({
      PatientId: patient.id,
      deviceType,
      type,
      serialNo,
      model: model || null,
      manufacturer: manufacturer || null,
      startDate,
      warrantyStartDate,
      warrantyEndDate,
      isActive: true,
      addedBy: req.user.id,
      addedDate: new Date(),
    });

    // Return full equipment response
    const equipmentData = await formatEquipmentResponse(patient.id);
    return success(res, equipmentData, 201);
  } catch (err) {
    console.error('Equipment ADD error:', err.message);
    return error(res, 'Failed to add equipment. Please try again.', 500);
  }
};

/**
 * PUT /api/patients/:uhid/equipment/:id
 * Updates equipment details
 *
 * Authorization: Doctor, Staff
 */
const update = async (req, res) => {
  const { uhid, id } = req.params;
  const updates = req.body;

  try {
    // Find patient
    const patient = await Patient.findOne({ where: { uhid } });
    if (!patient) {
      return error(res, 'Patient not found', 404);
    }

    // Find equipment
    const equipment = await MedicalEquipment.findOne({
      where: {
        id,
        PatientId: patient.id,
        isActive: true,
      },
    });

    if (!equipment) {
      return error(res, 'Equipment not found or already inactive', 404);
    }

    // Update allowed fields
    const allowedFields = [
      'type',
      'serialNo',
      'model',
      'manufacturer',
      'startDate',
      'warrantyStartDate',
      'warrantyEndDate',
    ];

    const updateData = {};
    allowedFields.forEach((field) => {
      if (updates[field] !== undefined) {
        updateData[field] = updates[field];
      }
    });

    // Track who updated
    updateData.lastUpdatedBy = req.user.id;
    updateData.lastUpdatedDate = new Date();

    await equipment.update(updateData);

    // Return full equipment response
    const equipmentData = await formatEquipmentResponse(patient.id);
    return success(res, equipmentData);
  } catch (err) {
    console.error('Equipment UPDATE error:', err.message);
    return error(res, 'Failed to update equipment. Please try again.', 500);
  }
};

/**
 * POST /api/patients/:uhid/equipment/:id/replace
 * Replaces equipment (archives old, creates new)
 *
 * Authorization: Doctor, Staff
 *
 * Request body:
 * - deviceType: 'pump' | 'transmitter'
 * - reason: string (why replacing)
 * - type: 'new' | 'replacement' | 'loaner'
 * - serialNo: string
 * - model: string (for pump)
 * - manufacturer: string (for pump)
 * - startDate: YYYY-MM-DD
 * - warrantyStartDate: YYYY-MM-DD
 * - warrantyEndDate: YYYY-MM-DD
 */
const replace = async (req, res) => {
  const { uhid, id } = req.params;
  const {
    deviceType,
    reason,
    type,
    serialNo,
    model,
    manufacturer,
    startDate,
    warrantyStartDate,
    warrantyEndDate,
  } = req.body;

  let transaction;
  try {
    // Validate business logic
    const validationError = validateEquipmentData({ startDate, warrantyStartDate, warrantyEndDate });
    if (validationError) {
      return error(res, validationError, 400);
    }

    // Find patient
    const patient = await Patient.findOne({ where: { uhid } });
    if (!patient) {
      return error(res, 'Patient not found', 404);
    }

    // Find current equipment
    const oldEquipment = await MedicalEquipment.findOne({
      where: {
        id,
        PatientId: patient.id,
        isActive: true,
      },
    });

    if (!oldEquipment) {
      return error(res, 'Equipment not found or already inactive', 404);
    }

    // Verify deviceType matches
    if (oldEquipment.deviceType !== deviceType) {
      return error(
        res,
        `Device type mismatch. This equipment is a ${oldEquipment.deviceType}, not a ${deviceType}`,
        400
      );
    }

    // Start database transaction - ensures all operations succeed or all fail
    transaction = await sequelize.transaction();

    // Archive old equipment to history
    await EquipmentHistory.create({
      PatientId: patient.id,
      deviceType: oldEquipment.deviceType,
      serialNo: oldEquipment.serialNo,
      model: oldEquipment.model,
      manufacturer: oldEquipment.manufacturer,
      startDate: oldEquipment.startDate,
      endDate: new Date(),
      reason,
      warrantyStartDate: oldEquipment.warrantyStartDate,
      warrantyEndDate: oldEquipment.warrantyEndDate,
      archivedBy: req.user.id,
      archivedDate: new Date(),
    }, { transaction });

    // Deactivate old equipment
    await oldEquipment.update({ isActive: false }, { transaction });

    // Create new equipment
    await MedicalEquipment.create({
      PatientId: patient.id,
      deviceType,
      type,
      serialNo,
      model: model || null,
      manufacturer: manufacturer || null,
      startDate,
      warrantyStartDate,
      warrantyEndDate,
      isActive: true,
      addedBy: req.user.id,
      addedDate: new Date(),
    }, { transaction });

    // Commit transaction
    await transaction.commit();

    // Return full equipment response
    const equipmentData = await formatEquipmentResponse(patient.id);
    return success(res, equipmentData);
  } catch (err) {
    // Rollback transaction on error
    if (transaction) await transaction.rollback();
    console.error('Equipment REPLACE error:', err.message);
    return error(res, 'Failed to replace equipment. Please try again.', 500);
  }
};

/**
 * GET /api/patients/:uhid/equipment/history
 * Gets full equipment history
 *
 * Authorization: Doctor, Staff
 */
const getHistory = async (req, res) => {
  const { uhid } = req.params;

  try {
    // Find patient
    const patient = await Patient.findOne({ where: { uhid } });
    if (!patient) {
      return error(res, 'Patient not found', 404);
    }

    // Get history
    const history = await EquipmentHistory.findAll({
      where: { PatientId: patient.id },
      include: [
        {
          model: User,
          as: 'archivedByUser',
          attributes: ['firstName', 'lastName'],
        },
      ],
      order: [['archivedDate', 'DESC']],
    });

    const historyData = history.map((item) => ({
      id: item.id,
      deviceType: item.deviceType,
      serialNo: item.serialNo,
      model: item.model,
      manufacturer: item.manufacturer,
      startDate: item.startDate,
      endDate: item.endDate,
      reason: item.reason,
      warrantyStartDate: item.warrantyStartDate,
      warrantyEndDate: item.warrantyEndDate,
      archivedBy: item.archivedByUser
        ? `${item.archivedByUser.firstName} ${item.archivedByUser.lastName}`
        : null,
      archivedDate: item.archivedDate,
    }));

    return success(res, { history: historyData });
  } catch (err) {
    console.error('Equipment HISTORY error:', err.message);
    return error(res, 'Failed to retrieve equipment history. Please try again.', 500);
  }
};

// EXPORTS

module.exports = {
  getCurrent,
  add,
  update,
  replace,
  getHistory,
};
