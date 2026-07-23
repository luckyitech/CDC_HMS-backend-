'use strict';

// Generic key-value system settings table.
module.exports = {
  async up(queryInterface, Sequelize) {
    // sequelize.sync() in server.js creates missing tables from the model on
    // startup, so the table may already exist by the time this migration runs.
    const tables = await queryInterface.showAllTables();
    if (tables.some((t) => String(t).toLowerCase() === 'settings')) return;

    await queryInterface.createTable('settings', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false,
      },
      key: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true,
      },
      value: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('settings');
  },
};
