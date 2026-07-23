'use strict';

/**
 * Glp1SideEffects — one row per symptom per review.
 *
 * A table rather than a JSON blob on the review row, so the clinic can answer
 * "every patient with moderate-or-worse nausea on tirzepatide" in SQL. It also
 * makes the weekly summary grid a GROUP BY rather than a JSON walk in JS.
 *
 * symptomName is denormalised on purpose: if a catalogue entry is later renamed,
 * historical reviews still read as they were recorded.
 *
 * Glp1TherapyId is denormalised too, so "all side effects on this course" is one
 * query with no join through Glp1Reviews.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('Glp1SideEffects')) return;

    await queryInterface.createTable('Glp1SideEffects', {
      id: {
        type:          Sequelize.INTEGER,
        primaryKey:    true,
        autoIncrement: true,
        allowNull:     false,
      },
      Glp1ReviewId: {
        type:       Sequelize.INTEGER,
        allowNull:  false,
        references: { model: 'Glp1Reviews', key: 'id' },
        onUpdate:   'CASCADE',
        onDelete:   'CASCADE',
      },
      Glp1TherapyId: {
        type:       Sequelize.INTEGER,
        allowNull:  false,
        references: { model: 'Glp1Therapies', key: 'id' },
        onUpdate:   'CASCADE',
        onDelete:   'CASCADE',
      },
      symptomId: {
        type:       Sequelize.INTEGER,    // camelCase — explicitly aliased FK
        allowNull:  false,
        references: { model: 'Glp1SideEffectCatalogs', key: 'id' },
        onUpdate:   'CASCADE',
        onDelete:   'RESTRICT',           // catalogue entries in use are retired, not deleted
      },
      symptomName: {
        type:      Sequelize.STRING,      // snapshot of the catalogue name at the time of recording
        allowNull: false,
      },
      severity: {
        type:      Sequelize.ENUM('none', 'mild', 'moderate', 'severe'),
        allowNull: false,
      },
      note: {
        type:      Sequelize.TEXT,
        allowNull: true,
      },
      source: {
        type:         Sequelize.ENUM('doctor', 'patient'),
        allowNull:    false,
        defaultValue: 'doctor',           // 'patient' reserved for between-visit reporting
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

    // One grading per symptom per review.
    await queryInterface.addIndex('Glp1SideEffects', ['Glp1ReviewId', 'symptomId'], {
      unique: true,
      name:   'unique_glp1_side_effect_review_symptom',
    });

    // Cross-patient reporting: "moderate-or-worse nausea".
    await queryInterface.addIndex('Glp1SideEffects', ['symptomId', 'severity'], {
      name: 'idx_glp1_side_effects_symptom_severity',
    });

    await queryInterface.addIndex('Glp1SideEffects', ['Glp1TherapyId'], {
      name: 'idx_glp1_side_effects_therapy',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('Glp1SideEffects');
  },
};
