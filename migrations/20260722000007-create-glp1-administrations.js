'use strict';

/**
 * Glp1Administrations — one row per week that was actually recorded.
 *
 * Many patients attend weekly for the nurse to give the injection, so the tool
 * needs to record what happened week by week. This is deliberately separate
 * from Glp1Reviews:
 *
 *   Glp1Reviews         a clinical assessment — weight, HbA1c, side effects,
 *                       action plan. Roughly 4-weekly, by a clinician.
 *   Glp1Administrations one injection — given, missed or deferred. Weekly.
 *
 * Conflating them would fill the monitoring table with fifty mostly-empty rows
 * a year and leave "missed" with nowhere clean to live.
 *
 * A week with no row simply has not been recorded yet. The dose ladder still
 * describes the PLAN; this records what happened.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('Glp1Administrations')) return;

    await queryInterface.createTable('Glp1Administrations', {
      id: {
        type:          Sequelize.INTEGER,
        primaryKey:    true,
        autoIncrement: true,
        allowNull:     false,
      },
      Glp1TherapyId: {
        type:       Sequelize.INTEGER,
        allowNull:  false,
        references: { model: 'Glp1Therapies', key: 'id' },
        onUpdate:   'CASCADE',
        onDelete:   'CASCADE',
      },
      PatientId: {
        type:       Sequelize.INTEGER,   // denormalised for merge-aware reads
        allowNull:  false,
        references: { model: 'Patients', key: 'id' },
        onUpdate:   'CASCADE',
        onDelete:   'CASCADE',
      },
      weekNumber: {
        type:      Sequelize.INTEGER,    // 0 is the starting week
        allowNull: false,
      },
      status: {
        type:      Sequelize.ENUM('given', 'missed', 'deferred'),
        allowNull: false,
      },
      administeredDate: {
        type:         Sequelize.DATEONLY,  // when it was actually given
        defaultValue: null,
      },
      dose: {
        type:         Sequelize.DECIMAL(5, 2),   // what was given, which may differ from the ladder
        defaultValue: null,
      },
      site: {
        type:         Sequelize.STRING,   // "Left thigh", "Abdomen"
        defaultValue: null,
      },
      // Whoever gave it — usually a nurse (staff role), sometimes a doctor.
      // Stamped from the JWT, never client-supplied.
      administeredBy: {
        type:       Sequelize.INTEGER,
        allowNull:  true,
        references: { model: 'Users', key: 'id' },
        onUpdate:   'CASCADE',
        onDelete:   'RESTRICT',
      },
      // Why a dose was missed or deferred — the clinically useful part
      note: {
        type:      Sequelize.TEXT,
        allowNull: true,
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

    // One record per week per course — recording week 6 twice is a mistake,
    // and re-recording it should overwrite rather than duplicate.
    await queryInterface.addIndex('Glp1Administrations', ['Glp1TherapyId', 'weekNumber'], {
      unique: true,
      name:   'unique_glp1_administration_therapy_week',
    });

    // "Which patients missed a dose recently" — the reason this is a table
    await queryInterface.addIndex('Glp1Administrations', ['status', 'administeredDate'], {
      name: 'idx_glp1_administrations_status_date',
    });

    await queryInterface.addIndex('Glp1Administrations', ['PatientId'], {
      name: 'idx_glp1_administrations_patient',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('Glp1Administrations');
  },
};
