const { defineModel, DataTypes } = require('../utils/defineModel');

// Who opened a patient's CLINICAL record, and when.
//
// Authorship was already recorded everywhere — who wrote a consultation note,
// who recorded a reading. Reading left no trace at all, so "who has been
// looking at my records?" had no answer. This is the other half of the question
// the clinical/non-clinical split answers: that decides who MAY look, this
// records who DID.
//
// It stores the fact of the look, never the content. A row says that Bridgit
// opened Moses' consultation notes at 14:32; it does not say what they said.
//
// Denormalised on purpose. userName and userRole are copied in rather than
// joined out at read time, because the log has to stay truthful about the past:
// if someone is later renamed, or moves from reception to nursing, or their
// account is deleted outright, the entry must still say who it was at the time.
// A join would quietly rewrite history — or lose it.
const PatientAccessLog = defineModel('PatientAccessLog', {
  // The patient whose record was opened. Not a declared association: the log
  // must survive a patient merge, which repoints records at the surviving UHID.
  // Keeping the raw id means an entry still describes the file that was
  // actually opened rather than the one it was later folded into.
  //
  // Nullable, and one of patientId/uhid must be present. The collection routes
  // (consultation notes, GLP-1) filter by a uhid query parameter and never
  // resolve a patient row, so the id genuinely is not known there. Storing null
  // says that honestly; a 0 sentinel would read as a real foreign key and would
  // eventually be joined against something.
  patientId: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  uhid: {
    type: DataTypes.STRING,
    allowNull: true,
  },

  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  userName: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  userRole: {
    type: DataTypes.STRING,   // deliberately not an ENUM; see below
    allowNull: true,
  },

  // What was opened, as a short stable key: 'consultation-notes',
  // 'treatment-plans', 'vitals', 'nursing-notes', 'blood-sugar', 'glp1',
  // 'equipment'.
  //
  // A STRING rather than an ENUM, and the same for userRole above. An ENUM
  // needs a migration every time a section or a role is added, and this project
  // has already been bitten by exactly that: UserLoginLog.role omitted 'nurse'
  // and 'admin', and because the insert is fire-and-forget those logins were
  // silently dropped and the Activity view sat empty. An audit log that
  // quietly discards rows is worse than none, because it looks complete.
  section: {
    type: DataTypes.STRING,
    allowNull: false,
  },

  // The concrete request, for tracing an entry back to what actually happened.
  method: {
    type: DataTypes.STRING(8),
    allowNull: true,
  },
  path: {
    type: DataTypes.STRING(512),
    allowNull: true,
  },

  ipAddress: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  accessedAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
}, {
  // The only query this table is built to serve: one patient, most recent
  // first. Deliberately NOT indexed by user — see the note in the controller
  // about why this is read per patient and never as "what has X been doing".
  indexes: [
    { fields: ['patientId', 'accessedAt'], name: 'patient_access_by_patient' },
  ],
});

module.exports = PatientAccessLog;
