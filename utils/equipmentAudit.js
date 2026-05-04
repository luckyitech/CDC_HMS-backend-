const db = require('../models');

const { EquipmentAuditLog } = db;

const SENSITIVE_FIELDS = new Set(['careLinkPassword']);
const DATE_FIELDS      = new Set(['startDate', 'warrantyStartDate', 'warrantyEndDate']);

const formatValue = (field, value) => {
  if (value === null || value === undefined) return null;
  if (SENSITIVE_FIELDS.has(field)) return '[hidden]';
  if (DATE_FIELDS.has(field)) {
    const d = new Date(value);
    return isNaN(d.getTime()) ? String(value) : d.toISOString().split('T')[0];
  }
  return String(value);
};

// Record a single "add" event — one log entry covering the whole device.
const recordAdd = async (patientId, equipmentId, deviceType, newData, changedBy) => {
  await EquipmentAuditLog.create({
    PatientId:   patientId,
    equipmentId,
    action:      'add',
    deviceType,
    field:       null,
    oldValue:    null,
    newValue:    null,
    summary:     `${deviceType} added (serial: ${newData.serialNo})`,
    changedBy,
    changedAt:   new Date(),
  });
};

// Record a "replace" event — one log entry covering the whole replacement.
const recordReplace = async (patientId, equipmentId, deviceType, oldSerial, newSerial, reason, changedBy) => {
  await EquipmentAuditLog.create({
    PatientId:   patientId,
    equipmentId,
    action:      'replace',
    deviceType,
    field:       null,
    oldValue:    oldSerial,
    newValue:    newSerial,
    summary:     `${deviceType} replaced. Reason: ${reason || 'not specified'}`,
    changedBy,
    changedAt:   new Date(),
  });
};

// Record edit events — one log entry per changed field.
// oldData and newData are plain objects with the field values before and after.
// Fields listed in SKIP_FIELDS are internal and not worth auditing.
const SKIP_FIELDS = new Set(['lastUpdatedBy', 'lastUpdatedDate', 'isActive', 'addedBy', 'addedDate']);

const recordEdit = async (patientId, equipmentId, deviceType, oldData, newData, changedBy) => {
  const entries = [];

  for (const field of Object.keys(newData)) {
    if (SKIP_FIELDS.has(field)) continue;

    const oldVal = oldData[field] ?? null;
    const newVal = newData[field] ?? null;

    // For sensitive fields compare existence, not value.
    const changed = SENSITIVE_FIELDS.has(field)
      ? Boolean(oldVal) !== Boolean(newVal) || (oldVal && newVal && oldVal !== newVal)
      : String(oldVal) !== String(newVal);

    if (!changed) continue;

    entries.push({
      PatientId:   patientId,
      equipmentId,
      action:      'edit',
      deviceType,
      field,
      oldValue:    formatValue(field, oldVal),
      newValue:    formatValue(field, newVal),
      summary:     null,
      changedBy,
      changedAt:   new Date(),
    });
  }

  if (entries.length > 0) {
    await EquipmentAuditLog.bulkCreate(entries);
  }
};

module.exports = { recordAdd, recordEdit, recordReplace };
