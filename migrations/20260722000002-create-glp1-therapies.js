'use strict';

/**
 * Glp1Therapies — one row per patient course of a GLP-1 / GIP agonist.
 *
 * FK casing follows the codebase split exactly:
 *   PatientId, Glp1MedicationId — PascalCase, association-generated
 *   doctorId, stoppedBy         — camelCase, explicitly aliased
 *
 * doseSchedule is a patient-scoped copy of the formulary ladder, so editing a
 * patient's steps never touches the clinic default.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('Glp1Therapies')) return;

    await queryInterface.createTable('Glp1Therapies', {
      id: {
        type:          Sequelize.INTEGER,
        primaryKey:    true,
        autoIncrement: true,
        allowNull:     false,
      },
      PatientId: {
        type:       Sequelize.INTEGER,
        allowNull:  false,
        references: { model: 'Patients', key: 'id' },
        onUpdate:   'CASCADE',
        onDelete:   'CASCADE',
      },
      Glp1MedicationId: {
        type:       Sequelize.INTEGER,
        allowNull:  false,
        references: { model: 'Glp1Medications', key: 'id' },
        onUpdate:   'CASCADE',
        onDelete:   'RESTRICT',           // a formulary row in use cannot be deleted
      },
      doctorId: {
        type:       Sequelize.INTEGER,    // the prescriber, stamped from the JWT
        allowNull:  false,
        references: { model: 'Users', key: 'id' },
        onUpdate:   'CASCADE',
        onDelete:   'RESTRICT',           // attribution on a medication record is not disposable
      },
      indication: {
        type:         Sequelize.ENUM('T2DM', 'Obesity', 'Both'),
        allowNull:    false,
        defaultValue: 'T2DM',
      },
      startDate: {
        type:      Sequelize.DATEONLY,    // drives current-week computation
        allowNull: false,
      },
      startingDose: {
        type:         Sequelize.DECIMAL(5, 2),
        defaultValue: null,
      },
      targetDose: {
        type:         Sequelize.DECIMAL(5, 2),
        defaultValue: null,
      },
      otherConditions: {
        type:      Sequelize.TEXT,
        allowNull: true,
      },
      baseline: {
        type:      Sequelize.JSON,        // the baseline assessment block, captured once at initiation
        allowNull: true,
      },
      safetyScreen: {
        type:      Sequelize.JSON,        // { pancreatitis, mtcMen2, giHistory, pregnancyTest,
        allowNull: true,                  //   ageOverride, overrideReason, screenedBy, screenedAt }
      },
      doseSchedule: {
        type:      Sequelize.JSON,        // patient-scoped ladder [{ fromWeek, toWeek, dose, note }]
        allowNull: true,
      },
      reviewWeeks: {
        type:      Sequelize.JSON,        // planned monitoring weeks, e.g. [4,8,12,24,36,52] plus additions
        allowNull: true,
      },
      status: {
        type:         Sequelize.ENUM('Active', 'Paused', 'Stopped', 'Completed'),
        allowNull:    false,
        defaultValue: 'Active',           // there is no delete path — a course is stopped, never destroyed
      },
      stopReason: {
        type:      Sequelize.TEXT,
        allowNull: true,
      },
      stoppedBy: {
        type:       Sequelize.INTEGER,
        allowNull:  true,
        references: { model: 'Users', key: 'id' },
        onUpdate:   'CASCADE',
        onDelete:   'SET NULL',
      },
      stoppedAt: {
        type:         Sequelize.DATE,
        defaultValue: null,
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

    await queryInterface.addIndex('Glp1Therapies', ['PatientId', 'status'], {
      name: 'idx_glp1_therapies_patient_status',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('Glp1Therapies');
  },
};
