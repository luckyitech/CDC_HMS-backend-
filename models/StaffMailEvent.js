const { defineModel, DataTypes } = require('../utils/defineModel');

// ---------------------------------------------------------------------------
// StaffMailEvent — metadata-only audit of the Staff Email feature (B26).
// Who connected / disconnected / was wiped on archive / had a login refused
// (and, from phase 2, who sent — recipient DOMAINS and a count only; from
// phase 3a, which PATIENT a document was emailed from or saved to — counts
// and domains only, migration 20260926000002; from phase 3b, who emptied
// their own Trash — a count only, migration 20260926000003; from phase 4,
// that a PATIENT was emailed — migration 20260926000004).
//
// NEVER a body, an attachment name or a full recipient address: decision D1
// is that the HMS keeps no copy of anyone's mail. The one exception is the
// SUBJECT of a patient_emailed row (≤ 200 characters, Emu 27 Sep), kept for
// that patient's Communications trail and never shown in the Activity Log.
// ---------------------------------------------------------------------------

const StaffMailEvent = defineModel('StaffMailEvent', {
  userId:       { type: DataTypes.INTEGER, allowNull: true },   // whose mailbox
  actorId:      { type: DataTypes.INTEGER, allowNull: true },   // who did it (self, or an admin)
  patientId:    { type: DataTypes.INTEGER, allowNull: true },   // canonical patient (phase 3a events)
  event: {
    type: DataTypes.ENUM('connected', 'disconnected', 'auth_failed', 'wiped', 'sent', 'patient_docs_sent', 'saved_to_patient', 'trash_emptied', 'patient_emailed'),
    allowNull: false,
  },
  emailAddress: { type: DataTypes.STRING, allowNull: true },
  detail:       { type: DataTypes.STRING(500), allowNull: true },
});

module.exports = StaffMailEvent;
