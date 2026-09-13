const { defineModel, DataTypes } = require('../utils/defineModel');

// A patient's own diary entry — the context a home glucose meter cannot give.
//
// The Accu-Chek Instant sends no meal marker at all (no 0x2A34 context — the
// clinic's meter was verified on 12 Sep 2026), so a bare download is a wall of
// timestamped numbers with nothing to say which was fasting, which was after
// dinner, which followed a walk or an insulin dose. The diary supplies that:
// the patient (or a clinician on their behalf) logs meals, activity, insulin,
// oral medication, symptoms and free notes, and the server time-matches them
// to nearby meter readings (utils/glucoseMatching.js), writing a `pre-<meal>`
// or `post-<meal>` tag onto the reading — never altering the reading's value
// or its meter time.
//
// TIME. `occurredAt` is the phone's wall-clock time (a naive DATETIME on the
// same axis as GlucoseMeterReadings.measuredAt), stored verbatim through the
// glucoseTime UTC-accessor trick so it equals what the patient's phone showed
// whatever timezone the server runs in. One-tap "now" or an explicit picker
// for a retro entry.
//
// Never hard-deleted (A5): a removed entry is status → 'Deleted' and stops
// influencing matches, but the row stays for the audit trail. `detail` is a
// small JSON blob for the type-specific extras (carbs g, minutes, units, drug
// name, symptom severity) — it is display context only, never anything the
// clinic needs to query in SQL, which is the one legitimate use of a JSON
// column here (A5).

const PatientDiaryEvent = defineModel('PatientDiaryEvent', {
  // PatientId    — added by Patient.hasMany(PatientDiaryEvent)
  // enteredById  — belongsTo(User, { as: 'enteredBy' })

  eventType:   { type: DataTypes.ENUM('meal', 'activity', 'insulin', 'oral_med', 'symptom', 'note'), allowNull: false },
  occurredAt:  { type: DataTypes.DATE, allowNull: false },
  label:       { type: DataTypes.STRING(120), defaultValue: null },   // e.g. "Breakfast", "Walk", "Novomix 30"
  detail:      { type: DataTypes.JSON, defaultValue: null },          // { carbs, minutes, units, drug, severity, … }

  enteredByRole: { type: DataTypes.ENUM('patient', 'clinic', 'bridge'), allowNull: false, defaultValue: 'patient' },

  status:      { type: DataTypes.ENUM('Active', 'Deleted'), allowNull: false, defaultValue: 'Active' },
  deletedAt:   { type: DataTypes.DATE, defaultValue: null },
}, {
  indexes: [
    { fields: ['PatientId', 'occurredAt'], name: 'patient_diary_events_patient_time' },
    { fields: ['PatientId', 'status'], name: 'patient_diary_events_patient_status' },
  ],
});

module.exports = PatientDiaryEvent;
