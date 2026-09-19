'use strict';

// Lab Inbox — one guarded, reversible table.
//
//   LabInboxItems   one row per external lab-report PDF pulled from the clinic
//                   mailbox over IMAP, waiting for a staff member to pair it to
//                   a patient. On pairing, a real MedicalDocument is created and
//                   this row is marked `Matched` (matchedDocumentId links them).
//                   A wrong pull is `Discarded` — soft-delete (A5), never
//                   destroy()'d; the row + staged file are kept for audit.
//
// Dedup: unique (messageId, attachmentIndex). The RFC Message-ID header is
// stable across re-polls, and one email may carry several PDFs — so a re-poll
// of the same mailbox is idempotent and never double-files a report.
//
// FK columns are the explicitly-aliased camelCase kind (A4). matchedDocumentId
// references MedicalDocuments; the patient/user refs SET NULL on delete so a
// merged/removed patient never breaks the audit row.

const TABLE = 'LabInboxItems';

const tableExists = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables
    .map((t) => (typeof t === 'string' ? t : t.tableName).toLowerCase())
    .includes(name.toLowerCase());
};

module.exports = {
  async up(queryInterface, Sequelize) {
    if (await tableExists(queryInterface, TABLE)) return;

    const userRef = {
      type: Sequelize.INTEGER, allowNull: true,
      references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
    };
    const patientRef = {
      type: Sequelize.INTEGER, allowNull: true,
      references: { model: 'Patients', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
    };

    await queryInterface.createTable(TABLE, {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },

      // source / dedup
      mailbox:         { type: Sequelize.STRING, allowNull: true },
      messageId:       { type: Sequelize.STRING, allowNull: false },
      imapUid:         { type: Sequelize.INTEGER, allowNull: true },
      attachmentIndex: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },

      // email metadata
      senderEmail: { type: Sequelize.STRING, allowNull: true },
      senderName:  { type: Sequelize.STRING, allowNull: true },
      subject:     { type: Sequelize.STRING, allowNull: true },
      emailDate:   { type: Sequelize.DATE,   allowNull: true },

      // staged file
      fileName: { type: Sequelize.STRING, allowNull: false },
      filePath: { type: Sequelize.STRING, allowNull: false },
      fileUrl:  { type: Sequelize.STRING, allowNull: true },
      fileSize: { type: Sequelize.STRING, allowNull: true },
      mimeType: { type: Sequelize.STRING, allowNull: true },

      // lifecycle
      status: {
        type: Sequelize.ENUM('New', 'Matched', 'Discarded', 'Error'),
        allowNull: false, defaultValue: 'New',
      },

      // auto-suggestion (advisory)
      suggestedPatientId:   { ...patientRef },
      suggestionScore:      { type: Sequelize.INTEGER, allowNull: true },
      suggestionConfidence: {
        type: Sequelize.ENUM('high', 'medium', 'low', 'none'),
        allowNull: false, defaultValue: 'none',
      },
      suggestionSource:  { type: Sequelize.STRING,   allowNull: true },
      extractedName:     { type: Sequelize.STRING,   allowNull: true },
      extractedPhone:    { type: Sequelize.STRING,   allowNull: true },
      extractedIdNumber: { type: Sequelize.STRING,   allowNull: true },
      extractedUhid:     { type: Sequelize.STRING,   allowNull: true },
      extractedDob:      { type: Sequelize.DATEONLY, allowNull: true },

      // outcome — matched
      matchedPatientId:  { ...patientRef },
      matchedDocumentId: {
        type: Sequelize.INTEGER, allowNull: true,
        references: { model: 'MedicalDocuments', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      matchedById: { ...userRef },
      matchedAt:   { type: Sequelize.DATE, allowNull: true },

      // outcome — discarded (soft-delete)
      discardedById: { ...userRef },
      discardedAt:   { type: Sequelize.DATE,   allowNull: true },
      discardReason: { type: Sequelize.STRING, allowNull: true },

      // diagnostics
      errorMessage: { type: Sequelize.TEXT, allowNull: true },

      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex(TABLE, ['messageId', 'attachmentIndex'], { unique: true, name: 'unique_lab_inbox_message_attachment' });
    await queryInterface.addIndex(TABLE, ['status'], { name: 'lab_inbox_status' });
    await queryInterface.addIndex(TABLE, ['suggestedPatientId'], { name: 'lab_inbox_suggested_patient' });
    await queryInterface.addIndex(TABLE, ['matchedPatientId'], { name: 'lab_inbox_matched_patient' });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface, TABLE)) {
      await queryInterface.dropTable(TABLE);
    }
  },
};
