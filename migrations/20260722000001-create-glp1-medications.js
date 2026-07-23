'use strict';

/**
 * Glp1Medications — the clinic formulary.
 *
 * Drives the medication tabs in the GLP-1 monitoring tool. Adding a row here
 * makes the agent available for every patient, which is why writes are
 * admin-only at the route layer.
 *
 * drugClass is a STRING, not an ENUM: the whole point of a formulary table is
 * that a new agent can be added without a code change or a migration.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('Glp1Medications')) return;

    await queryInterface.createTable('Glp1Medications', {
      id: {
        type:          Sequelize.INTEGER,
        primaryKey:    true,
        autoIncrement: true,
        allowNull:     false,
      },
      genericName: {
        type:      Sequelize.STRING,
        allowNull: false,
      },
      brandName: {
        type:         Sequelize.STRING,
        defaultValue: null,
      },
      drugClass: {
        type:         Sequelize.STRING,   // "GLP-1 RA", "GIP/GLP-1 RA", or a future class
        defaultValue: null,
      },
      route: {
        type:         Sequelize.STRING,   // "SC weekly"
        defaultValue: null,
      },
      // JSON/TEXT columns carry no SQL default — MySQL 8 forbids it.
      // Application-side defaults live on the model.
      strengths: {
        type:      Sequelize.JSON,        // [2.5, 5, 7.5, 10, 12.5, 15]
        allowNull: true,
      },
      defaultSchedule: {
        type:      Sequelize.JSON,        // [{ fromWeek, toWeek, dose }, …] clinic default ladder
        allowNull: true,
      },
      defaultTitrationWeeks: {
        type:         Sequelize.INTEGER,
        allowNull:    false,
        defaultValue: 4,
      },
      isActive: {
        type:         Sequelize.BOOLEAN,
        allowNull:    false,
        defaultValue: true,               // soft-retire; formulary rows are never destroyed
      },
      addedBy: {
        type:       Sequelize.INTEGER,
        allowNull:  true,
        references: { model: 'Users', key: 'id' },
        onUpdate:   'CASCADE',
        onDelete:   'SET NULL',
      },
      createdAt: {
        type:         Sequelize.DATE,
        allowNull:    false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updatedAt: {
        type:         Sequelize.DATE,
        allowNull:    false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    // One row per agent — stops "Tirzepatide" and "tirzepatide" both appearing as tabs.
    await queryInterface.addIndex('Glp1Medications', ['genericName'], {
      unique: true,
      name:   'unique_glp1_medication_generic_name',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('Glp1Medications');
  },
};
