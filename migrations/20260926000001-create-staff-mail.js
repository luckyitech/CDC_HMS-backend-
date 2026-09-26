'use strict';

// Staff Email (B26) — two guarded, reversible tables.
//
//   StaffMailAccounts   one row per staff user who has connected their own
//                       clinic mailbox: the address, the mailbox password
//                       ENCRYPTED (utils/crypto.js), the provider preset, and
//                       status. NO MAIL CONTENT IS EVER STORED — the HMS reads
//                       and sends live over IMAP/SMTP (live-proxy decision,
//                       claude/staff-email-scope-and-plan.md §3).
//   StaffMailEvents     metadata-only audit: connected / disconnected /
//                       auth_failed / wiped (and 'sent' from phase 2). Never a
//                       subject or a body (decision D1).
//
// userId / actorId are the explicitly-aliased camelCase kind (A4).
// trustedImageSenders is TEXT holding a JSON array rather than a JSON column,
// so MariaDB (local) and MySQL 8 (prod) read it identically.

const ACCOUNTS = 'StaffMailAccounts';
const EVENTS = 'StaffMailEvents';

const tableExists = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables
    .map((t) => (typeof t === 'string' ? t : t.tableName).toLowerCase())
    .includes(name.toLowerCase());
};

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface, ACCOUNTS))) {
      await queryInterface.createTable(ACCOUNTS, {
        id:                { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        userId: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        emailAddress:      { type: Sequelize.STRING, allowNull: false },
        passwordEncrypted: { type: Sequelize.TEXT, allowNull: true },
        authType:          { type: Sequelize.ENUM('password', 'oauth'), allowNull: false, defaultValue: 'password' },
        provider:          { type: Sequelize.STRING(40), allowNull: false, defaultValue: 'onecom' },
        displayName:       { type: Sequelize.STRING, allowNull: true },
        signatureHtml:     { type: Sequelize.TEXT, allowNull: true },
        status: {
          type: Sequelize.ENUM('connected', 'needs_password', 'error', 'disconnected'),
          allowNull: false, defaultValue: 'connected',
        },
        lastError:           { type: Sequelize.TEXT, allowNull: true },
        failedAuthCount:     { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        lastConnectedAt:     { type: Sequelize.DATE, allowNull: true },
        remoteImagesDefault: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        trustedImageSenders: { type: Sequelize.TEXT, allowNull: true },
        createdAt:           { type: Sequelize.DATE, allowNull: false },
        updatedAt:           { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex(ACCOUNTS, ['userId'], { name: 'staff_mail_accounts_user', unique: true });
      await queryInterface.addIndex(ACCOUNTS, ['emailAddress'], { name: 'staff_mail_accounts_email' });
    }

    if (!(await tableExists(queryInterface, EVENTS))) {
      await queryInterface.createTable(EVENTS, {
        id:     { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        userId: {
          type: Sequelize.INTEGER, allowNull: true,
          references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
        },
        actorId: {
          type: Sequelize.INTEGER, allowNull: true,
          references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
        },
        event: {
          type: Sequelize.ENUM('connected', 'disconnected', 'auth_failed', 'wiped', 'sent'),
          allowNull: false,
        },
        emailAddress: { type: Sequelize.STRING, allowNull: true },
        detail:       { type: Sequelize.STRING(500), allowNull: true },
        createdAt:    { type: Sequelize.DATE, allowNull: false },
        updatedAt:    { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex(EVENTS, ['createdAt'], { name: 'staff_mail_events_created' });
      await queryInterface.addIndex(EVENTS, ['userId'], { name: 'staff_mail_events_user' });
    }
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface, EVENTS)) await queryInterface.dropTable(EVENTS);
    if (await tableExists(queryInterface, ACCOUNTS)) await queryInterface.dropTable(ACCOUNTS);
  },
};
