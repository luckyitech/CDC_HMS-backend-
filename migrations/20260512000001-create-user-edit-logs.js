'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Guarded so this migration is safe to re-run, and safe on a database
    // built by sequelize.sync() — which is what server.js does on boot, so it
    // is the normal state of every dev machine here. Without this the migration
    // throws on an existing column and sequelize-cli stops, taking every later
    // migration with it.
    const createIfMissing = async (tableName, spec, options) => {
      const names = (await queryInterface.showAllTables())
        .map((t) => String(typeof t === 'string' ? t : t.tableName).toLowerCase());
      if (names.includes(tableName.toLowerCase())) return;
      await queryInterface.createTable(tableName, spec, options);
    };

    await createIfMissing('UserEditLogs', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      targetUserId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Users', key: 'id' },
        onDelete: 'CASCADE',
      },
      editedBy: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      editedByName: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      changes: {
        type: Sequelize.JSON,
        allowNull: false,
      },
      editedAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('UserEditLogs');
  },
};
