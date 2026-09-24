'use strict';

// HR Suite (B21) — remembered personal phones. Holds only the SHA-256 of the
// device token; expiresAt rolls 90 days on every use. Guarded, reversible.

const TABLE = 'UserDevices';

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
        id:          { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        tokenHash:   { type: Sequelize.STRING(64), allowNull: false },
        label:       { type: Sequelize.STRING, allowNull: true, defaultValue: null },
        lastSeenAt:  { type: Sequelize.DATE, allowNull: true, defaultValue: null },
        lastIp:      { type: Sequelize.STRING(45), allowNull: true, defaultValue: null },
        expiresAt:   { type: Sequelize.DATE, allowNull: false },
        revokedAt:   { type: Sequelize.DATE, allowNull: true, defaultValue: null },
        UserId:      { type: Sequelize.INTEGER, allowNull: true, defaultValue: null,
          references: { model: users, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
        revokedById: { type: Sequelize.INTEGER, allowNull: true, defaultValue: null,
          references: { model: users, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
        createdAt:   { type: Sequelize.DATE, allowNull: false },
        updatedAt:   { type: Sequelize.DATE, allowNull: false },
      });
      table = TABLE;
    }
    if (!(await hasIndex(queryInterface, table, 'user_devices_token_hash'))) {
      await queryInterface.addIndex(table, ['tokenHash'], { name: 'user_devices_token_hash', unique: true });
    }
    if (!(await hasIndex(queryInterface, table, 'user_devices_user'))) {
      await queryInterface.addIndex(table, ['UserId'], { name: 'user_devices_user' });
    }
  },

  async down(queryInterface) {
    const table = await resolveTable(queryInterface, TABLE);
    if (table) await queryInterface.dropTable(table);
  },
};
