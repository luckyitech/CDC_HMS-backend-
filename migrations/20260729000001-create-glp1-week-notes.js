'use strict';

/**
 * Glp1WeekNotes — free-text notes attached to a single week of a course.
 *
 * A weekly GLP-1 injection carries two kinds of note that must coexist on the
 * same week: the nurse's injection note (site, tolerance, what the patient
 * reported) and the doctor's clinical note (hold the escalation, review nausea
 * next visit). The one-row-per-week Glp1Administrations table cannot hold both,
 * and its `note` column is the missed/omitted reason — a different thing. So
 * per-week notes get their own table, the same way side effects did.
 *
 * Design mirrors the rest of the tool:
 *   PatientId       PascalCase, association-generated, denormalised so
 *                   merge-aware reads (PatientId IN family.patientIds) need no
 *                   join through the therapy.
 *   Glp1TherapyId   PascalCase, association-generated.
 *   authorId        camelCase, explicitly aliased. From the JWT, never the
 *                   client. RESTRICT on delete — attribution on a clinical note
 *                   is not disposable.
 *   authorRole      snapshot of the author's role at the time of writing, so the
 *                   Nurse / Doctor badge reads as written even if the user's
 *                   role later changes.
 *   status          soft delete only. A correction is a new note plus a removal
 *                   of the old one, never an overwrite — the record keeps both.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = (await queryInterface.showAllTables())
      .map((t) => String(typeof t === 'string' ? t : t.tableName).toLowerCase());
    if (tables.includes('glp1weeknotes')) return;

    await queryInterface.createTable('Glp1WeekNotes', {
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
      authorId: {
        type:       Sequelize.INTEGER,   // camelCase — explicitly aliased FK, from the JWT
        allowNull:  false,
        references: { model: 'Users', key: 'id' },
        onUpdate:   'CASCADE',
        onDelete:   'RESTRICT',          // authorship on a clinical note is not disposable
      },
      authorRole: {
        type:      Sequelize.STRING,     // 'doctor' | 'staff' — snapshot at write time
        allowNull: false,
      },
      body: {
        type:      Sequelize.TEXT,
        allowNull: false,
      },
      status: {
        type:         Sequelize.ENUM('active', 'deleted'),
        allowNull:    false,
        defaultValue: 'active',          // soft delete — clinical rows are never destroyed
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

    // Per-week fetch for a course — the common read path.
    await queryInterface.addIndex('Glp1WeekNotes', ['Glp1TherapyId', 'weekNumber', 'status'], {
      name: 'idx_glp1_week_notes_therapy_week',
    });

    // Merge-aware read across a patient's courses.
    await queryInterface.addIndex('Glp1WeekNotes', ['PatientId', 'status'], {
      name: 'idx_glp1_week_notes_patient_status',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('Glp1WeekNotes');
  },
};
