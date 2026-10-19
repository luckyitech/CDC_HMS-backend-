'use strict';

// Two-factor sign-in (19 Oct 2026) — the live emailed-code challenges.
//
// Holds only the SHA-256 of `${challengeId}:${code}`, never a code. Rows are
// short-lived: consumed on success, superseded on re-issue, and swept by
// services/loginOtp.js. Guarded and reversible, like
// 20260923000004-create-user-devices.js.
//
// Safe to run against a live database: it only adds a table. Nothing reads or
// writes it until an administrator switches the feature on (Setting
// 'twoFactorEnabled'), so applying this migration changes no behaviour by
// itself.

const TABLE = 'LoginOtps';

const resolveTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.find((t) => String(t).toLowerCase() === name.toLowerCase());
};
const hasIndex = async (qi, table, name) => {
  const idx = await qi.showIndex(table);
  return idx.some((i) => String(i.name).toLowerCase() === name.toLowerCase());
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const users = (await resolveTable(queryInterface, 'Users')) || 'Users';
    let table = await resolveTable(queryInterface, TABLE);
    if (!table) {
      await queryInterface.createTable(TABLE, {
        id:             { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        challengeId:    { type: Sequelize.STRING(64), allowNull: false },
        codeHash:       { type: Sequelize.STRING(64), allowNull: false },
        expiresAt:      { type: Sequelize.DATE, allowNull: false },
        attempts:       { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        consumedAt:     { type: Sequelize.DATE, allowNull: true, defaultValue: null },
        sentTo:         { type: Sequelize.STRING, allowNull: false },
        lastIp:         { type: Sequelize.STRING(45), allowNull: true, defaultValue: null },
        resendCount:    { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        rememberDevice: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        context:        { type: Sequelize.STRING(16), allowNull: true, defaultValue: null },
        UserId:         { type: Sequelize.INTEGER, allowNull: true, defaultValue: null,
          references: { model: users, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        createdAt:      { type: Sequelize.DATE, allowNull: false },
        updatedAt:      { type: Sequelize.DATE, allowNull: false },
      });
      table = TABLE;
    }
    // The verify route looks a challenge up by this and nothing else.
    if (!(await hasIndex(queryInterface, table, 'login_otps_challenge_id'))) {
      await queryInterface.addIndex(table, ['challengeId'], { name: 'login_otps_challenge_id', unique: true });
    }
    // Issuing supersedes an account's previous live challenge, so every issue
    // reads this way round.
    if (!(await hasIndex(queryInterface, table, 'login_otps_user'))) {
      await queryInterface.addIndex(table, ['UserId'], { name: 'login_otps_user' });
    }
    // The sweep deletes by age.
    if (!(await hasIndex(queryInterface, table, 'login_otps_expires_at'))) {
      await queryInterface.addIndex(table, ['expiresAt'], { name: 'login_otps_expires_at' });
    }
  },

  async down(queryInterface) {
    const table = await resolveTable(queryInterface, TABLE);
    if (table) await queryInterface.dropTable(table);
  },
};
