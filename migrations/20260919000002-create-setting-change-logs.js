'use strict';

// Setting change audit — one guarded, reversible table.
//
//   SettingChangeLogs   who changed which clinic-wide setting (password policy,
//                       Lab Inbox mailbox/allowlist, catalog suggestion source),
//                       from what, to what, when. Feeds a 'setting_changed'
//                       event in the Activity Log. Secrets are never stored
//                       (the service writes "(set)"/"(changed)" instead).
//
// Actor name/role are denormalised (like UserLoginLogs) so the trail survives
// a user being renamed or removed; changedById SET NULLs on delete.

const TABLE = 'SettingChangeLogs';

const tableExists = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables
    .map((t) => (typeof t === 'string' ? t : t.tableName).toLowerCase())
    .includes(name.toLowerCase());
};

module.exports = {
  async up(queryInterface, Sequelize) {
    if (await tableExists(queryInterface, TABLE)) return;

    await queryInterface.createTable(TABLE, {
      id:            { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      area:          { type: Sequelize.STRING, allowNull: false },
      settingKey:    { type: Sequelize.STRING, allowNull: false },
      label:         { type: Sequelize.STRING, allowNull: false },
      oldValue:      { type: Sequelize.TEXT, allowNull: true },
      newValue:      { type: Sequelize.TEXT, allowNull: true },
      changedById: {
        type: Sequelize.INTEGER, allowNull: true,
        references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      changedByName: { type: Sequelize.STRING, allowNull: false },
      changedByRole: { type: Sequelize.STRING, allowNull: true },
      changedAt:     { type: Sequelize.DATE, allowNull: false },
      createdAt:     { type: Sequelize.DATE, allowNull: false },
      updatedAt:     { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex(TABLE, ['changedAt'], { name: 'setting_change_logs_changed_at' });
    await queryInterface.addIndex(TABLE, ['settingKey'], { name: 'setting_change_logs_key' });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface, TABLE)) {
      await queryInterface.dropTable(TABLE);
    }
  },
};
