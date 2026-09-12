const { defineModel, DataTypes } = require('../utils/defineModel');

// One record read from a home glucose meter over Bluetooth (Bluetooth SIG
// Glucose Profile — the Accu-Chek Instant for release 1). Normalised: every
// field is a real column so the clinic can report on it in SQL (A5).
//
// Identity is (deviceSerial, sequenceNumber) — the meter numbers its own
// records — which makes a repeat download idempotent and lets a client ask
// for "everything after the last one I have". Never hard-deleted: a reading
// the clinician rejects is status → 'Excluded' with who and why, and it stays
// visible, struck through, in the readings table.
//
// TIME. `measuredAt` is the meter's own wall-clock time and has no timezone
// (the meter has none). It is stored as a naive DATETIME and NEVER converted
// or corrected — even when the meter's clock is known to be wrong, the record
// says what the meter said; the drift is recorded beside it
// (hostClockDeltaSec) and surfaced, not silently fixed.
//
// Sequelize round-trips DATE through UTC, so the controller builds the JS Date
// from the meter's components with Date.UTC() and reads it back with the UTC
// accessors (see utils/glucoseTime.js). That makes the stored value equal the
// meter's wall time whatever timezone the server runs in — the same
// "stay in one frame" rule utils/clinicTime.js applies to dates.

const GlucoseMeterReading = defineModel('GlucoseMeterReading', {
  // PatientId      — added by Patient.hasMany(GlucoseMeterReading)
  // PatientMeterId — added by PatientMeter.hasMany(GlucoseMeterReading)
  // importedById / excludedById — belongsTo(User, { as })

  deviceSerial:   { type: DataTypes.STRING(64), allowNull: false },
  sequenceNumber: { type: DataTypes.INTEGER,    allowNull: false },

  measuredAt:     { type: DataTypes.DATE,       allowNull: false },
  timeOffsetMin:  { type: DataTypes.SMALLINT,   defaultValue: null },

  glucoseMgdl:    { type: DataTypes.DECIMAL(6, 1), allowNull: false },
  unitsReported:  { type: DataTypes.ENUM('kg/L', 'mol/L'), allowNull: false, defaultValue: 'kg/L' },
  sampleType:     { type: DataTypes.TINYINT,    defaultValue: null },
  sampleLocation: { type: DataTypes.TINYINT,    defaultValue: null },
  sensorStatus:   { type: DataTypes.SMALLINT,   allowNull: false, defaultValue: 0 },
  mealFlag:       { type: DataTypes.TINYINT,    defaultValue: null },

  contextTag:     { type: DataTypes.STRING(32), defaultValue: null },
  contextSource:  { type: DataTypes.ENUM('meter', 'clock', 'matched', 'manual'), defaultValue: null },

  importBatchId:  { type: DataTypes.STRING(40), allowNull: false },
  importedByRole: { type: DataTypes.ENUM('clinic', 'patient', 'bridge'), allowNull: false, defaultValue: 'clinic' },
  hostClockDeltaSec: { type: DataTypes.INTEGER, defaultValue: null },
  rawHex:         { type: DataTypes.STRING(64), defaultValue: null },

  status:         { type: DataTypes.ENUM('Active', 'Excluded'), allowNull: false, defaultValue: 'Active' },
  excludeReason:  { type: DataTypes.STRING(255), defaultValue: null },
  excludedAt:     { type: DataTypes.DATE,       defaultValue: null },
}, {
  indexes: [
    { unique: true, fields: ['deviceSerial', 'sequenceNumber'], name: 'unique_meter_record' },
    { fields: ['PatientId', 'measuredAt'], name: 'glucose_meter_readings_patient_time' },
    { fields: ['importBatchId'], name: 'glucose_meter_readings_batch' },
  ],
});

module.exports = GlucoseMeterReading;
