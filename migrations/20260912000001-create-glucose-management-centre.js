'use strict';

// Glucose Management Centre — three tables, each guarded and reversible.
//
//   GlucoseMeterReadings   one row per record read from a home glucose meter
//                          over Bluetooth (Bluetooth SIG Glucose Profile).
//                          Normalised — every value is a real column, nothing
//                          is JSON — so the clinic can report on it in SQL.
//                          Unique on (deviceSerial, sequenceNumber): the meter
//                          numbers its own records, so a second download of
//                          the same meter is idempotent and incremental.
//   PatientMeters          which meter (serial) belongs to which patient. One
//                          serial may be Active on at most one patient — the
//                          guard that stops a shared household meter filing
//                          one person's readings under another.
//   PatientGlucoseTargets  a doctor's per-patient override of the consensus
//                          targets (constants/glucose.js). Absent = consensus.
//
// The existing BloodSugarReadings logbook is untouched: it stays the manual
// entry path and the Glucose Management Centre reads both.
//
// Clinical records soft-delete via `status` (A5) — nothing here is ever
// destroy()'d; an excluded reading keeps who excluded it and why.

const READINGS = 'GlucoseMeterReadings';
const METERS   = 'PatientMeters';
const TARGETS  = 'PatientGlucoseTargets';

const tableExists = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables
    .map((t) => (typeof t === 'string' ? t : t.tableName).toLowerCase())
    .includes(name.toLowerCase());
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const userRef = (onDelete = 'SET NULL') => ({
      type: Sequelize.INTEGER, allowNull: true,
      references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete,
    });
    const patientRef = {
      type: Sequelize.INTEGER, allowNull: false,
      references: { model: 'Patients', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT',
    };
    const stamps = {
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    };

    if (!(await tableExists(queryInterface, METERS))) {
      await queryInterface.createTable(METERS, {
        id:            { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        PatientId:     patientRef,
        deviceSerial:  { type: Sequelize.STRING(64), allowNull: false },
        deviceModel:   { type: Sequelize.STRING(64), allowNull: true },   // human name, e.g. "Accu-Chek Instant"
        deviceModelId: { type: Sequelize.STRING(32), allowNull: true },   // DIS model string, e.g. "973"
        firmware:      { type: Sequelize.STRING(32), allowNull: true },
        status:        { type: Sequelize.ENUM('Active', 'Retired'), allowNull: false, defaultValue: 'Active' },
        shared:        { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false }, // household meter — more than one Active patient by explicit clinical decision
        firstLinkedAt: { type: Sequelize.DATE, allowNull: false },
        linkedById:    userRef(),
        linkReason:    { type: Sequelize.STRING(255), allowNull: true },  // set when a link overrode a conflict
        // "Since when has this patient used this meter?" — asked by the nurse.
        // Import files only records dated on/after it. Null = every record on
        // the meter is this patient's. Required when a meter is re-assigned
        // from another patient, so the previous owner's readings never land
        // in the new owner's chart (Emu, 12 Sep 2026).
        usedFromDate:  { type: Sequelize.DATEONLY, allowNull: true },
        retiredAt:     { type: Sequelize.DATE, allowNull: true },
        retiredById:   userRef(),
        retireReason:  { type: Sequelize.STRING(255), allowNull: true },
        lastSequenceNumber: { type: Sequelize.INTEGER, allowNull: true }, // highest seq imported for this patient from this meter
        lastSyncAt:    { type: Sequelize.DATE, allowNull: true },
        lastClockDeltaSec: { type: Sequelize.INTEGER, allowNull: true },   // host − meter, at the last download
        clockCorrectedAt:  { type: Sequelize.DATE, allowNull: true },      // a nurse set the meter's clock at the visit
        ...stamps,
      });
      await queryInterface.addIndex(METERS, ['PatientId'], { name: 'patient_meters_patient_id' });
      await queryInterface.addIndex(METERS, ['deviceSerial', 'status'], { name: 'patient_meters_serial_status' });
    }

    if (!(await tableExists(queryInterface, READINGS))) {
      await queryInterface.createTable(READINGS, {
        id:              { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        PatientId:       patientRef,
        PatientMeterId:  { type: Sequelize.INTEGER, allowNull: true, references: { model: METERS, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
        deviceSerial:    { type: Sequelize.STRING(64), allowNull: false },
        sequenceNumber:  { type: Sequelize.INTEGER, allowNull: false },

        // Meter wall-clock time of the reading (base time + offset). A naive
        // DATETIME: the meter has no timezone, and this is never converted.
        measuredAt:      { type: Sequelize.DATE, allowNull: false },
        timeOffsetMin:   { type: Sequelize.SMALLINT, allowNull: true },

        glucoseMgdl:     { type: Sequelize.DECIMAL(6, 1), allowNull: false },
        unitsReported:   { type: Sequelize.ENUM('kg/L', 'mol/L'), allowNull: false, defaultValue: 'kg/L' },
        sampleType:      { type: Sequelize.TINYINT, allowNull: true },    // SIG type nibble (8 = undetermined plasma, 10 = control solution)
        sampleLocation:  { type: Sequelize.TINYINT, allowNull: true },    // SIG location nibble (15 = n/a)
        sensorStatus:    { type: Sequelize.SMALLINT, allowNull: false, defaultValue: 0 },
        mealFlag:        { type: Sequelize.TINYINT, allowNull: true },    // from 0x2A34 if the meter sends it (the Instant never does)

        // Tagging. Phase 1: `clock` (time-of-day bucket by the meter's hour).
        // Phase 2 adds `matched` (diary time-matching) and `manual` (re-tagged).
        contextTag:      { type: Sequelize.STRING(32), allowNull: true },
        contextSource:   { type: Sequelize.ENUM('meter', 'clock', 'matched', 'manual'), allowNull: true },

        // Provenance — every row says which download brought it and who did it.
        importBatchId:   { type: Sequelize.STRING(40), allowNull: false },
        importedById:    userRef(),
        importedByRole:  { type: Sequelize.ENUM('clinic', 'patient', 'bridge'), allowNull: false, defaultValue: 'clinic' },
        hostClockDeltaSec: { type: Sequelize.INTEGER, allowNull: true },  // host − meter at import; never used to rewrite measuredAt
        rawHex:          { type: Sequelize.STRING(64), allowNull: true },  // the 0x2A18 frame, for decoder audits

        // Soft-exclude. Excluded rows stay visible, struck through, with reason.
        status:          { type: Sequelize.ENUM('Active', 'Excluded'), allowNull: false, defaultValue: 'Active' },
        excludeReason:   { type: Sequelize.STRING(255), allowNull: true },
        excludedById:    userRef(),
        excludedAt:      { type: Sequelize.DATE, allowNull: true },
        ...stamps,
      });
      await queryInterface.addIndex(READINGS, ['deviceSerial', 'sequenceNumber'], { unique: true, name: 'unique_meter_record' });
      await queryInterface.addIndex(READINGS, ['PatientId', 'measuredAt'], { name: 'glucose_meter_readings_patient_time' });
      await queryInterface.addIndex(READINGS, ['importBatchId'], { name: 'glucose_meter_readings_batch' });
    }

    if (!(await tableExists(queryInterface, TARGETS))) {
      await queryInterface.createTable(TARGETS, {
        id:              { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        PatientId:       { ...patientRef, unique: true },                 // one override row per patient; history is in UserEditLogs-style audit later if needed
        preset:          { type: Sequelize.STRING(32), allowNull: true }, // 'standard' | 'olderHighRisk' | 'pregnancy' | null (custom)
        tirLowMgdl:      { type: Sequelize.SMALLINT, allowNull: true },
        tirHighMgdl:     { type: Sequelize.SMALLINT, allowNull: true },
        tbrLevel2Mgdl:   { type: Sequelize.SMALLINT, allowNull: true },
        tarLevel2Mgdl:   { type: Sequelize.SMALLINT, allowNull: true },
        fastingLowMgdl:  { type: Sequelize.SMALLINT, allowNull: true },
        fastingHighMgdl: { type: Sequelize.SMALLINT, allowNull: true },
        cvTargetPct:     { type: Sequelize.TINYINT, allowNull: true },
        tirGoalPct:      { type: Sequelize.TINYINT, allowNull: true },
        tbrGoalPct:      { type: Sequelize.TINYINT, allowNull: true },
        tarGoalPct:      { type: Sequelize.TINYINT, allowNull: true },
        rationale:       { type: Sequelize.STRING(255), allowNull: false },
        setById:         userRef(),
        setAt:           { type: Sequelize.DATE, allowNull: false },
        ...stamps,
      });
    }
  },

  async down(queryInterface) {
    // Readings reference meters — drop children first.
    if (await tableExists(queryInterface, READINGS)) await queryInterface.dropTable(READINGS);
    if (await tableExists(queryInterface, TARGETS))  await queryInterface.dropTable(TARGETS);
    if (await tableExists(queryInterface, METERS))   await queryInterface.dropTable(METERS);
  },
};
