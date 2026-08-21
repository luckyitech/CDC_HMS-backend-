const { defineModel, DataTypes } = require('../utils/defineModel');

const BloodSugarReading = defineModel('BloodSugarReading', {
  // patientId is added automatically by the association in index.js

  date: {
    type: DataTypes.DATEONLY,   // DATE only — no time component (e.g. "2025-01-15")
    allowNull: false,
  },
  timeSlot: {
    type: DataTypes.ENUM(
      'fasting',
      'breakfast',
      'beforeLunch',
      'afterLunch',
      'beforeDinner',
      'afterDinner',
      'bedtime'
    ),
    allowNull: false,
  },
  value: {
    type: DataTypes.DECIMAL(5, 1),  // mg/dL
    allowNull: false,
  },
  time: {
    type: DataTypes.STRING,         // display time e.g. "7:00 AM"
  },

  // Who entered this reading, and in what capacity.
  //
  // Until clinical staff could log readings, every row came from the patient
  // themselves and there was nothing to record. Now that a nurse can enter the
  // reading taken when a patient comes into clinic, the two are clinically
  // different evidence — a home glucometer is not a clinic measurement — and a
  // chart that cannot tell them apart is misleading to whoever reads it next.
  //
  // Nullable because every existing row predates this and its author is not
  // recoverable. A null means "recorded before this was tracked", which is
  // honest; backfilling them all as 'patient' would be a guess presented as a
  // fact, and every one of them would be wrong for any reading a doctor
  // entered.
  recordedById: {
    type: DataTypes.INTEGER,        // Users.id
    allowNull: true,
  },
  recordedByRole: {
    type: DataTypes.ENUM('patient', 'clinic'),
    allowNull: true,
  },
}, {
  // Composite unique constraint:
  // one patient can only have one reading per date per time slot.
  // If they try to save the same slot again, the controller uses upsert.
  //
  // The column is PatientId — capitalised, because Patient.hasMany() generates
  // it rather than it being declared above. This read 'patientId' until now.
  // MySQL treats column identifiers as case-insensitive, so the index built
  // correctly and nothing was broken; every other model that indexes a foreign
  // key names it exactly (the Stock models declare theirs explicitly), so this
  // was the odd one out. Postgres, which folds unquoted identifiers to
  // lowercase, would not have matched it.
  //
  // No database change: the index is matched by name, which is unchanged.
  indexes: [
    {
      unique: true,
      fields: ['PatientId', 'date', 'timeSlot'],
      name: 'unique_reading_per_slot',
    },
  ],
});

module.exports = BloodSugarReading;
