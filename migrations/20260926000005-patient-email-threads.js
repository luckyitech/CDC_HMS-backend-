'use strict';

// Staff Email (B26) phase 5 — patient email threads, all-mail activity, email
// analytics (Emu, 27 Sep 2026 — claude/b26-phase5-patient-email-threads-plan.md).
//
//   PatientEmailMessages   the email side of a patient's Communications trail:
//                          messages sent to a tagged patient, every reply in
//                          those threads (picked up from INBOX / Sent), and any
//                          email a staff member LINKED to the patient. Keeps the
//                          TEXT, from/to and time — this REVERSES decision D1
//                          for patient threads only (Emu's decision). Documents
//                          already on the file are kept as document ids (links,
//                          never copies); other attachments by name only.
//                          Soft delete only (status 'removed' + who/when/why) —
//                          admins only, audited.
//   StaffMailTraffic       one row per email sent or received by a connected
//                          mailbox: who, direction, when, counterpart DOMAINS,
//                          counts, and the patient when it is in a patient
//                          thread. Never a subject, a body or a full address.
//                          Feeds the Activity Log and Inbox → Analytics.
//   StaffMailAccounts      + syncState (TEXT, JSON: per-folder uidValidity /
//                            uidNext cursors of the 5-minute checker)
//                          + lastSyncAt
//   StaffMailEvents.event  + 'linked_to_patient', 'patient_email_removed'
//
// Guarded both ways; down drops what up added (FKs go with their tables) and
// deletes the two new event types before narrowing the ENUM. Runs after
// 20260926000004.

const MESSAGES = 'PatientEmailMessages';
const TRAFFIC = 'StaffMailTraffic';
const ACCOUNTS = 'StaffMailAccounts';
const EVENTS = 'StaffMailEvents';
const OLD_EVENTS = ['connected', 'disconnected', 'auth_failed', 'wiped', 'sent', 'patient_docs_sent', 'saved_to_patient', 'trash_emptied', 'patient_emailed'];
const NEW_EVENTS = [...OLD_EVENTS, 'linked_to_patient', 'patient_email_removed'];

const tableExists = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables
    .map((t) => (typeof t === 'string' ? t : t.tableName).toLowerCase())
    .includes(name.toLowerCase());
};

const enumValues = (column) => {
  const m = String(column && column.type ? column.type : '').match(/^ENUM\((.*)\)$/i);
  return m ? m[1].split(',').map((v) => v.trim().replace(/^'|'$/g, '')) : [];
};

const userRef = (Sequelize) => ({
  type: Sequelize.INTEGER, allowNull: true,
  references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
});

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface, MESSAGES))) {
      await queryInterface.createTable(MESSAGES, {
        id:            { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        patientId: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: 'Patients', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        threadKey:     { type: Sequelize.STRING(255), allowNull: false },
        messageId:     { type: Sequelize.STRING(255), allowNull: false },
        inReplyTo:     { type: Sequelize.STRING(255), allowNull: true },
        referencesIds: { type: Sequelize.TEXT, allowNull: true },
        direction:     { type: Sequelize.ENUM('in', 'out'), allowNull: false },
        mailboxUserId: userRef(Sequelize),
        fromName:      { type: Sequelize.STRING, allowNull: true },
        fromAddress:   { type: Sequelize.STRING, allowNull: true },
        toList:        { type: Sequelize.TEXT, allowNull: true },
        ccList:        { type: Sequelize.TEXT, allowNull: true },
        subject:       { type: Sequelize.STRING(500), allowNull: true },
        bodyText:      { type: Sequelize.TEXT('medium'), allowNull: true },
        sentAt:        { type: Sequelize.DATE, allowNull: false },
        source:        { type: Sequelize.ENUM('hms_send', 'reply', 'linked', 'sent_elsewhere'), allowNull: false },
        documentIds:   { type: Sequelize.TEXT, allowNull: true },
        attachmentNames: { type: Sequelize.TEXT, allowNull: true },
        linkedById:    userRef(Sequelize),
        status:        { type: Sequelize.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
        removedById:   userRef(Sequelize),
        removedAt:     { type: Sequelize.DATE, allowNull: true },
        removedReason: { type: Sequelize.STRING(500), allowNull: true },
        createdAt:     { type: Sequelize.DATE, allowNull: false },
        updatedAt:     { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex(MESSAGES, ['patientId', 'messageId'], { name: 'patient_email_msg_unique', unique: true });
      await queryInterface.addIndex(MESSAGES, ['patientId', 'sentAt'], { name: 'patient_email_msg_patient_time' });
      await queryInterface.addIndex(MESSAGES, ['messageId'], { name: 'patient_email_msg_mid' });
      await queryInterface.addIndex(MESSAGES, ['threadKey'], { name: 'patient_email_msg_thread' });
    }

    if (!(await tableExists(queryInterface, TRAFFIC))) {
      await queryInterface.createTable(TRAFFIC, {
        id:              { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        userId:          userRef(Sequelize),
        direction:       { type: Sequelize.ENUM('in', 'out'), allowNull: false },
        via:             { type: Sequelize.ENUM('hms', 'elsewhere'), allowNull: false },
        messageId:       { type: Sequelize.STRING(255), allowNull: false },
        domains:         { type: Sequelize.STRING(255), allowNull: true },
        recipientCount:  { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        attachmentCount: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        patientId: {
          type: Sequelize.INTEGER, allowNull: true,
          references: { model: 'Patients', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
        },
        at:              { type: Sequelize.DATE, allowNull: false },
        createdAt:       { type: Sequelize.DATE, allowNull: false },
        updatedAt:       { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex(TRAFFIC, ['userId', 'direction', 'messageId'], { name: 'staff_mail_traffic_unique', unique: true });
      await queryInterface.addIndex(TRAFFIC, ['at'], { name: 'staff_mail_traffic_at' });
      await queryInterface.addIndex(TRAFFIC, ['patientId'], { name: 'staff_mail_traffic_patient' });
    }

    if (await tableExists(queryInterface, ACCOUNTS)) {
      const cols = await queryInterface.describeTable(ACCOUNTS);
      if (!cols.syncState) await queryInterface.addColumn(ACCOUNTS, 'syncState', { type: Sequelize.TEXT, allowNull: true });
      if (!cols.lastSyncAt) await queryInterface.addColumn(ACCOUNTS, 'lastSyncAt', { type: Sequelize.DATE, allowNull: true });
    }

    if (await tableExists(queryInterface, EVENTS)) {
      const cols = await queryInterface.describeTable(EVENTS);
      if (!NEW_EVENTS.every((v) => enumValues(cols.event).includes(v))) {
        await queryInterface.changeColumn(EVENTS, 'event', { type: Sequelize.ENUM(...NEW_EVENTS), allowNull: false });
      }
    }
  },

  async down(queryInterface, Sequelize) {
    if (await tableExists(queryInterface, EVENTS)) {
      const cols = await queryInterface.describeTable(EVENTS);
      const current = enumValues(cols.event);
      if (current.includes('linked_to_patient') || current.includes('patient_email_removed')) {
        await queryInterface.bulkDelete(EVENTS, { event: ['linked_to_patient', 'patient_email_removed'] });
        await queryInterface.changeColumn(EVENTS, 'event', { type: Sequelize.ENUM(...OLD_EVENTS), allowNull: false });
      }
    }
    if (await tableExists(queryInterface, ACCOUNTS)) {
      const cols = await queryInterface.describeTable(ACCOUNTS);
      if (cols.lastSyncAt) await queryInterface.removeColumn(ACCOUNTS, 'lastSyncAt');
      if (cols.syncState) await queryInterface.removeColumn(ACCOUNTS, 'syncState');
    }
    if (await tableExists(queryInterface, TRAFFIC)) await queryInterface.dropTable(TRAFFIC);
    if (await tableExists(queryInterface, MESSAGES)) await queryInterface.dropTable(MESSAGES);
  },
};
