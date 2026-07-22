'use strict';

// Admin-managed clinical catalogs (medications, diagnoses) that power the
// autocomplete inputs, replacing the external US-centric APIs.
module.exports = {
  async up(queryInterface, Sequelize) {
    // sequelize.sync() in server.js creates missing tables from the model on
    // startup, so the table may already exist by the time this migration runs.
    const tables = await queryInterface.showAllTables();
    if (tables.some((t) => String(t).toLowerCase() === 'catalogitems')) return;

    await queryInterface.createTable('catalogitems', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false,
      },
      type: {
        type: Sequelize.ENUM('medication', 'diagnosis'),
        allowNull: false,
      },
      name: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      detail: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: null,
      },
      addedBy: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: null,
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('catalogitems', ['type', 'name'], {
      unique: true,
      name: 'unique_catalog_type_name',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('catalogitems');
  },
};
