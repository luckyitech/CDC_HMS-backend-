const { defineModel, DataTypes } = require('../utils/defineModel');

// ---------------------------------------------------------------------------
// LabInboxItem — one external lab-report PDF pulled from the clinic mailbox,
// waiting for a staff member to pair it to a patient.
//
// This is the *staging* row for the Lab Inbox feature. Nothing here is a
// medical record yet: on pairing, the controller creates a real
// MedicalDocument (category "Lab Report - External", status "Pending Review")
// via the shared document-create helper, and this row is marked `Matched`
// with a link back to that document. A wrong pull is `Discarded` — a
// soft-delete (A5): the row and the staged file are kept for audit, never
// destroy()'d.
//
// Dedup / idempotency: a re-poll must never re-import the same attachment.
// The unique index on (messageId, attachmentIndex) is the guard — the RFC
// Message-ID header is stable across re-polls, and one email can carry
// several PDFs (one row each). See migration 20260919000001.
//
// FK columns here are the explicitly-aliased, camelCase kind (A4): they are
// declared as real columns and wired with belongsTo({ as, foreignKey }) in
// models/index.js — NOT association-generated PascalCase keys.
// ---------------------------------------------------------------------------

const LabInboxItem = defineModel('LabInboxItem', {
  // --- Where this report came from ---
  // 'email' (the original IMAP mailbox path) or 'whatsapp' (a lab that sent the
  // report over WhatsApp — the Communications Inbox mirrors it here so the Lab
  // reports tab stays the single queue for external results). sourceMessageId
  // links back to the ConversationMessage when source is 'whatsapp'.
  source: {
    type: DataTypes.ENUM('email', 'whatsapp'),
    allowNull: false,
    defaultValue: 'email',
  },
  sourceMessageId: {
    type: DataTypes.INTEGER,         // FK -> ConversationMessages.id (whatsapp source)
    allowNull: true,
  },

  // --- Source message / dedup ---
  mailbox: {
    type: DataTypes.STRING,          // folder the message was read from, e.g. "INBOX"
    allowNull: true,
  },
  messageId: {
    type: DataTypes.STRING,          // RFC 5322 Message-ID header — stable dedup key
    allowNull: false,
  },
  imapUid: {
    type: DataTypes.INTEGER,         // per-mailbox UID at fetch time (diagnostics only)
    allowNull: true,
  },
  attachmentIndex: {
    type: DataTypes.INTEGER,         // which PDF within the message (0-based)
    allowNull: false,
    defaultValue: 0,
  },

  // --- Email metadata (display + hints for matching) ---
  senderEmail: { type: DataTypes.STRING, allowNull: true },
  senderName:  { type: DataTypes.STRING, allowNull: true },
  subject:     { type: DataTypes.STRING, allowNull: true },
  emailDate:   { type: DataTypes.DATE,   allowNull: true },   // Date header (stored UTC)

  // --- The staged file ---
  fileName: { type: DataTypes.STRING, allowNull: false },     // original attachment name
  filePath: { type: DataTypes.STRING, allowNull: false },     // server-side path under uploads/lab-inbox/
  fileUrl:  { type: DataTypes.STRING, allowNull: true },      // authenticated serve path (NOT a static mount)
  fileSize: { type: DataTypes.STRING, allowNull: true },      // "320 KB"
  mimeType: { type: DataTypes.STRING, allowNull: true },      // application/pdf

  // --- Lifecycle ---
  status: {
    type: DataTypes.ENUM('New', 'Matched', 'Discarded', 'Error'),
    allowNull: false,
    defaultValue: 'New',
  },

  // --- Auto-suggestion (advisory only; a human always confirms) ---
  suggestedPatientId: { type: DataTypes.INTEGER, allowNull: true },
  suggestionScore: {
    type: DataTypes.INTEGER,         // 0..100
    allowNull: true,
  },
  suggestionConfidence: {
    type: DataTypes.ENUM('high', 'medium', 'low', 'none'),
    allowNull: false,
    defaultValue: 'none',
  },
  suggestionSource: { type: DataTypes.STRING, allowNull: true }, // e.g. "pdf+email"
  extractedName:     { type: DataTypes.STRING,   allowNull: true },
  extractedPhone:    { type: DataTypes.STRING,   allowNull: true },
  extractedIdNumber: { type: DataTypes.STRING,   allowNull: true },
  extractedUhid:     { type: DataTypes.STRING,   allowNull: true },
  extractedDob:      { type: DataTypes.DATEONLY, allowNull: true },

  // --- Outcome: matched ---
  matchedPatientId:  { type: DataTypes.INTEGER, allowNull: true },
  matchedDocumentId: { type: DataTypes.INTEGER, allowNull: true }, // FK -> MedicalDocuments.id
  matchedById:       { type: DataTypes.INTEGER, allowNull: true }, // FK -> Users.id (JWT attribution)
  matchedAt:         { type: DataTypes.DATE,    allowNull: true },

  // --- Outcome: discarded (soft-delete) ---
  discardedById: { type: DataTypes.INTEGER, allowNull: true },
  discardedAt:   { type: DataTypes.DATE,    allowNull: true },
  discardReason: { type: DataTypes.STRING,  allowNull: true },

  // --- Diagnostics ---
  errorMessage: { type: DataTypes.TEXT, allowNull: true },
}, {
  indexes: [
    { unique: true, fields: ['messageId', 'attachmentIndex'], name: 'unique_lab_inbox_message_attachment' },
    { fields: ['status'], name: 'lab_inbox_status' },
    { fields: ['suggestedPatientId'], name: 'lab_inbox_suggested_patient' },
    { fields: ['matchedPatientId'], name: 'lab_inbox_matched_patient' },
  ],
});

module.exports = LabInboxItem;
