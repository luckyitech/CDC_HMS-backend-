const { defineModel, DataTypes } = require('../utils/defineModel');

// ---------------------------------------------------------------------------
// StaffMailEvent — metadata-only audit of the Staff Email feature (B26).
// Who connected / disconnected / was wiped on archive / had a login refused
// (and, from phase 2, who sent — recipient DOMAINS and a count only; from
// phase 3a, which PATIENT a document was emailed from or saved to — counts
// and domains only, migration 20260926000002).
//
// NEVER a subject, a body, an attachment name or a full recipient address:
// decision D1 is that the HMS keeps no copy of anyone's mail.
// ---------------------------------------------------------------------------

const StaffMailEvent = defineModel('StaffMailEvent', {
  userId:       { type: DataTypes.INTEGER, allowNull: true },   // whose mailbox
  actorId:      { type: DataTypes.INTEGER, allowNull: true },   // who did it (self, or an admin)
  patientId:    { type: DataTypes.INTEGER, allowNull: true },   // canonical patient (phase 3a events)
  event: {
    type: DataTypes.ENUM('connected', 'disconnected', 'auth_failed', 'wiped', 'sent', 'patient_docs_sent', 'saved_to_patient'),
    allowNull: false,
  },
  emailAddress: { type: DataTypes.STRING, allowNull: true },
  detail:       { type: DataTypes.STRING(500), allowNull: true },
});

module.exports = StaffMailEvent;
