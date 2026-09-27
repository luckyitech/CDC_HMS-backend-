const { defineModel, DataTypes } = require('../utils/defineModel');

// ---------------------------------------------------------------------------
// StaffMailTraffic — one row per email sent or received by a connected staff
// mailbox (Staff Email phase 5, migration 20260926000005). Metadata ONLY:
// whose mailbox, direction, when, the counterpart DOMAINS, counts, whether it
// went through the HMS or elsewhere (phone / webmail), and the patient when the
// message is in a patient thread. Never a subject, a body or a full address.
// Feeds the Activity Log (system-wide + each Staff File) and Inbox → Analytics.
// (Emu, 27 Sep: "every email sent + received"; staff are told by Emu.)
// ---------------------------------------------------------------------------

const StaffMailTraffic = defineModel('StaffMailTraffic', {
  userId:          { type: DataTypes.INTEGER, allowNull: true },
  direction:       { type: DataTypes.ENUM('in', 'out'), allowNull: false },
  via:             { type: DataTypes.ENUM('hms', 'elsewhere'), allowNull: false },
  messageId:       { type: DataTypes.STRING(255), allowNull: false },
  domains:         { type: DataTypes.STRING(255), allowNull: true },   // comma-separated
  recipientCount:  { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  attachmentCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  patientId:       { type: DataTypes.INTEGER, allowNull: true },
  at:              { type: DataTypes.DATE, allowNull: false },
}, { tableName: 'StaffMailTraffic' });

module.exports = StaffMailTraffic;
