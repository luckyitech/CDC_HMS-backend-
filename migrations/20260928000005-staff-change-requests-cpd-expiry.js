'use strict';

// B27 phase 0 (5 of 6) — profile change requests, CPD, expiry reminders.
// Spec §3.2, decisions D11–D12. Tables only; the screens come in phases 4–5.
//
//   StaffChangeRequests  a staff member asking HR to change a field they may
//                        not edit themselves (name, National ID, date of birth,
//                        licence / qualification details). Decided by
//                        hr.profile.approve (phase 4). Never deleted —
//                        withdrawn / rejected is a status.
//   CpdActivities        a CPD entry with points and an optional certificate
//                        (a StaffDocument). Verified by HR (phase 5). Retired
//                        via status 'archived', never deleted.
//   ExpiryReminders      a de-duplication log so each 60/30/7/0-day reminder
//                        for a document or licence goes out once per expiry
//                        date (phase 5 daily job).
//
// Guarded both ways; `down` drops the three tables.

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};

const userRef = (Sequelize, allowNull = true) => ({
  type: Sequelize.INTEGER, allowNull,
  references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: allowNull ? 'SET NULL' : 'CASCADE',
});
const docRef = (Sequelize) => ({
  type: Sequelize.INTEGER, allowNull: true,
  references: { model: 'StaffDocuments', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
});

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await findTable(queryInterface, 'StaffChangeRequests'))) {
      await queryInterface.createTable('StaffChangeRequests', {
        id:                   { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        UserId:               userRef(Sequelize, false),
        field:                { type: Sequelize.STRING(60), allowNull: false },
        oldValue:             { type: Sequelize.TEXT, allowNull: true },
        newValue:             { type: Sequelize.TEXT, allowNull: true },
        reason:               { type: Sequelize.TEXT, allowNull: true },
        attachmentDocumentId: docRef(Sequelize),
        status:               { type: Sequelize.ENUM('pending', 'approved', 'rejected', 'withdrawn'), allowNull: false, defaultValue: 'pending' },
        decidedById:          userRef(Sequelize),
        decidedAt:            { type: Sequelize.DATE, allowNull: true },
        decisionNote:         { type: Sequelize.TEXT, allowNull: true },
        createdAt:            { type: Sequelize.DATE, allowNull: false },
        updatedAt:            { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex('StaffChangeRequests', ['status', 'createdAt'], { name: 'staff_change_requests_status' });
      await queryInterface.addIndex('StaffChangeRequests', ['UserId'], { name: 'staff_change_requests_user' });
    }

    if (!(await findTable(queryInterface, 'CpdActivities'))) {
      await queryInterface.createTable('CpdActivities', {
        id:           { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        UserId:       userRef(Sequelize, false),
        date:         { type: Sequelize.DATEONLY, allowNull: false },
        title:        { type: Sequelize.STRING(255), allowNull: false },
        provider:     { type: Sequelize.STRING(255), allowNull: true },
        category:     { type: Sequelize.ENUM('conference', 'course', 'webinar', 'workshop', 'self-study', 'other'), allowNull: false, defaultValue: 'other' },
        points:       { type: Sequelize.DECIMAL(5, 1), allowNull: false, defaultValue: 0 },
        documentId:   docRef(Sequelize),
        status:       { type: Sequelize.ENUM('pending', 'verified', 'rejected', 'archived'), allowNull: false, defaultValue: 'pending' },
        verifiedById: userRef(Sequelize),
        verifiedAt:   { type: Sequelize.DATE, allowNull: true },
        note:         { type: Sequelize.TEXT, allowNull: true },
        createdAt:    { type: Sequelize.DATE, allowNull: false },
        updatedAt:    { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex('CpdActivities', ['UserId', 'date'], { name: 'cpd_activities_user_date' });
    }

    if (!(await findTable(queryInterface, 'ExpiryReminders'))) {
      await queryInterface.createTable('ExpiryReminders', {
        id:         { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        kind:       { type: Sequelize.ENUM('document', 'licence'), allowNull: false },
        refId:      { type: Sequelize.INTEGER, allowNull: false },
        threshold:  { type: Sequelize.INTEGER, allowNull: false },
        expiryDate: { type: Sequelize.DATEONLY, allowNull: false },
        sentAt:     { type: Sequelize.DATE, allowNull: false },
        createdAt:  { type: Sequelize.DATE, allowNull: false },
        updatedAt:  { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex('ExpiryReminders', ['kind', 'refId', 'threshold', 'expiryDate'], { name: 'expiry_reminders_unique', unique: true });
    }
  },

  async down(queryInterface) {
    for (const name of ['ExpiryReminders', 'CpdActivities', 'StaffChangeRequests']) {
      const t = await findTable(queryInterface, name);
      if (t) await queryInterface.dropTable(t);
    }
  },
};
