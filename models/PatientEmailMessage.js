const { defineModel, DataTypes } = require('../utils/defineModel');

// ---------------------------------------------------------------------------
// PatientEmailMessage — the email side of a patient's Communications trail
// (Staff Email phase 5, migration 20260926000005).
//
// One row per message per patient: sent to a tagged patient from the HMS, a
// reply in that thread (picked up by the 5-minute checker from INBOX / Sent),
// or an email a staff member LINKED to the patient (e.g. an insurer
// pre-authorisation where the patient is not a recipient).
//
// Unlike the rest of Staff Email, this KEEPS the message text and addresses —
// patient threads are part of the medical record (Emu, 27 Sep; reverses
// decision D1 for these rows only). Documents already on the patient file are
// kept as ids (shown as links, never copied); other attachments by name only.
//
// Read only through GET /api/comms/patients/:uhid/email-threads, gated by
// patientemail.view. Never hard-deleted: an admin may mark a row 'removed'
// (who / when / why), which hides it from the trail and is audited.
// ---------------------------------------------------------------------------

const PatientEmailMessage = defineModel('PatientEmailMessage', {
  patientId:       { type: DataTypes.INTEGER, allowNull: false },   // canonical file at write time
  threadKey:       { type: DataTypes.STRING(255), allowNull: false },
  messageId:       { type: DataTypes.STRING(255), allowNull: false },
  inReplyTo:       { type: DataTypes.STRING(255), allowNull: true },
  referencesIds:   { type: DataTypes.TEXT, allowNull: true },
  direction:       { type: DataTypes.ENUM('in', 'out'), allowNull: false },
  mailboxUserId:   { type: DataTypes.INTEGER, allowNull: true },    // whose mailbox it came from
  fromName:        { type: DataTypes.STRING, allowNull: true },
  fromAddress:     { type: DataTypes.STRING, allowNull: true },
  toList:          { type: DataTypes.TEXT, allowNull: true },       // JSON [{ name, address }]
  ccList:          { type: DataTypes.TEXT, allowNull: true },       // JSON
  subject:         { type: DataTypes.STRING(500), allowNull: true },
  bodyText:        { type: DataTypes.TEXT('medium'), allowNull: true },
  sentAt:          { type: DataTypes.DATE, allowNull: false },
  source:          { type: DataTypes.ENUM('hms_send', 'reply', 'linked', 'sent_elsewhere'), allowNull: false },
  documentIds:     { type: DataTypes.TEXT, allowNull: true },       // JSON [MedicalDocument.id]
  attachmentNames: { type: DataTypes.TEXT, allowNull: true },       // JSON [name]
  linkedById:      { type: DataTypes.INTEGER, allowNull: true },
  status:          { type: DataTypes.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
  removedById:     { type: DataTypes.INTEGER, allowNull: true },
  removedAt:       { type: DataTypes.DATE, allowNull: true },
  removedReason:   { type: DataTypes.STRING(500), allowNull: true },
});

module.exports = PatientEmailMessage;
