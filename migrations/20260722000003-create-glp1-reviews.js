'use strict';

/**
 * Glp1Reviews — one row per monitoring visit.
 *
 * doctorId is the Doctor column on the monitoring table. It is stamped from the
 * JWT at creation and never client-supplied, and it never changes: an amendment
 * records a second name in amendedBy rather than overwriting the author.
 *
 * PatientId is denormalised from the therapy so merge-aware reads
 * (PatientId IN family.patientIds) work without a join.
 *
 * Soft delete only — status flips to 'deleted', the row stays. Because of that
 * there is no unique index on (Glp1TherapyId, weekNumber): a soft-deleted row
 * would permanently block re-entry of that week. One active review per week is
 * enforced in the controller instead.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('Glp1Reviews')) return;

    await queryInterface.createTable('Glp1Reviews', {
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
        type:       Sequelize.INTEGER,
        allowNull:  false,
        references: { model: 'Patients', key: 'id' },
        onUpdate:   'CASCADE',
        onDelete:   'CASCADE',
      },
      doctorId: {
        type:       Sequelize.INTEGER,    // the Doctor column — from the JWT, locked with the entry
        allowNull:  false,
        references: { model: 'Users', key: 'id' },
        onUpdate:   'CASCADE',
        onDelete:   'RESTRICT',
      },
      weekNumber: {
        type:      Sequelize.INTEGER,     // 4, 8, 12, 24, 36, 52 and any user-added week
        allowNull: false,
      },
      reviewDate: {
        type:      Sequelize.DATEONLY,
        allowNull: false,
      },
      weight: {
        type:         Sequelize.DECIMAL(5, 1),   // kg — mirrors PatientVital precision
        defaultValue: null,
      },
      bmi: {
        type:         Sequelize.DECIMAL(4, 1),
        defaultValue: null,
      },
      waistCircumference: {
        type:         Sequelize.DECIMAL(4, 1),   // cm
        defaultValue: null,
      },
      bp: {
        type:         Sequelize.STRING,          // "128/80" — same convention as PatientVital.bp
        defaultValue: null,
      },
      heartRate: {
        type:         Sequelize.INTEGER,
        defaultValue: null,
      },
      fpg: {
        type:         Sequelize.DECIMAL(5, 1),   // fasting plasma glucose
        defaultValue: null,
      },
      hba1c: {
        type:         Sequelize.DECIMAL(3, 1),
        defaultValue: null,
      },
      doseAtReview: {
        type:         Sequelize.DECIMAL(5, 2),   // what they were actually on, not what the ladder says
        defaultValue: null,
      },
      adherence: {
        type:         Sequelize.ENUM('Good', 'Missed doses', 'Stopped'),
        defaultValue: null,
      },
      actionPlan: {
        type:      Sequelize.TEXT,
        allowNull: true,
      },
      status: {
        type:         Sequelize.ENUM('active', 'deleted'),
        allowNull:    false,
        defaultValue: 'active',           // soft delete — clinical rows are never destroyed
      },
      deletedBy: {
        type:       Sequelize.INTEGER,
        allowNull:  true,
        references: { model: 'Users', key: 'id' },
        onUpdate:   'CASCADE',
        onDelete:   'SET NULL',
      },
      deletedAt: {
        type:         Sequelize.DATE,
        defaultValue: null,
      },
      // --- Amendment trail ---
      amendedBy: {
        type:       Sequelize.INTEGER,
        allowNull:  true,
        references: { model: 'Users', key: 'id' },
        onUpdate:   'CASCADE',
        onDelete:   'SET NULL',
      },
      amendedAt: {
        type:         Sequelize.DATE,
        defaultValue: null,
      },
      amendmentReason: {
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

    await queryInterface.addIndex('Glp1Reviews', ['Glp1TherapyId', 'weekNumber'], {
      name: 'idx_glp1_reviews_therapy_week',
    });

    await queryInterface.addIndex('Glp1Reviews', ['PatientId', 'status'], {
      name: 'idx_glp1_reviews_patient_status',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('Glp1Reviews');
  },
};
