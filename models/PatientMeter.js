const { defineModel, DataTypes } = require('../utils/defineModel');

// Which home glucose meter belongs to which patient — the multi-patient safety
// spine of the meter import.
//
// A meter identifies itself only by serial (from its advertised name; the DIS
// serial characteristic is blocked in Web Bluetooth). So the serial is the one
// signal that a download might be going to the wrong person: a household
// sharing one meter, or a meter handed on to a relative. The import refuses
// to file readings for a serial that is Active on a different patient until a
// nurse either re-assigns it (the old link is Retired, and the patient is
// asked since when they have used it — `usedFromDate` — so only their own
// readings import) or marks it `shared` with a reason. Both are recorded
// here, never silently.
//
// Also the per-meter sync bookkeeping: the highest sequence number already
// imported (so the next download asks the meter only for newer records), the
// clock drift seen at the last download, and whether a nurse set the meter's
// clock at the visit.

const PatientMeter = defineModel('PatientMeter', {
  // PatientId — added by Patient.hasMany(PatientMeter)
  // linkedById / retiredById — belongsTo(User, { as })

  deviceSerial:  { type: DataTypes.STRING(64), allowNull: false },
  deviceModel:   { type: DataTypes.STRING(64), defaultValue: null },
  deviceModelId: { type: DataTypes.STRING(32), defaultValue: null },
  firmware:      { type: DataTypes.STRING(32), defaultValue: null },

  status:        { type: DataTypes.ENUM('Active', 'Retired'), allowNull: false, defaultValue: 'Active' },
  shared:        { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

  firstLinkedAt: { type: DataTypes.DATE, allowNull: false },
  linkReason:    { type: DataTypes.STRING(255), defaultValue: null },
  // "Since when has this patient used this meter?" — import files only
  // records dated on/after it; null = all. Required on re-assignment.
  usedFromDate:  { type: DataTypes.DATEONLY, defaultValue: null },
  retiredAt:     { type: DataTypes.DATE, defaultValue: null },
  retireReason:  { type: DataTypes.STRING(255), defaultValue: null },

  lastSequenceNumber: { type: DataTypes.INTEGER, defaultValue: null },
  lastSyncAt:         { type: DataTypes.DATE, defaultValue: null },
  lastClockDeltaSec:  { type: DataTypes.INTEGER, defaultValue: null },
  clockCorrectedAt:   { type: DataTypes.DATE, defaultValue: null },
}, {
  indexes: [
    { fields: ['PatientId'], name: 'patient_meters_patient_id' },
    { fields: ['deviceSerial', 'status'], name: 'patient_meters_serial_status' },
  ],
});

module.exports = PatientMeter;
