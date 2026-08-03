'use strict';

/**
 * Repairs a Glp1WeekNotes table created by the boot-time sync() race.
 *
 * server.js runs sequelize.sync({ alter: false }) on every boot. If the server
 * restarts after models/Glp1WeekNote.js exists but before the create migration
 * has run, sync() builds the table from the bare model — without the three
 * association foreign keys (Glp1TherapyId, PatientId, authorId), because those
 * come from associations, not the model file. The create migration's
 * table-exists guard then sees the name and skips, recording itself as applied
 * while the table is missing its columns. Every insert then fails with
 * "Unknown column 'Glp1TherapyId' in 'field list'".
 *
 * This migration detects that state — table present, Glp1TherapyId absent —
 * drops the malformed table if (and only if) it is empty, and rebuilds it to
 * the correct shape. A healthy table is left untouched, so this is safe to run
 * anywhere, including production and a fresh rebuild.
 */

const buildTable = async (queryInterface, Sequelize) => {
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
      type:       Sequelize.INTEGER,
      allowNull:  false,
      references: { model: 'Patients', key: 'id' },
      onUpdate:   'CASCADE',
      onDelete:   'CASCADE',
    },
    weekNumber: {
      type:      Sequelize.INTEGER,
      allowNull: false,
    },
    authorId: {
      type:       Sequelize.INTEGER,
      allowNull:  false,
      references: { model: 'Users', key: 'id' },
      onUpdate:   'CASCADE',
      onDelete:   'RESTRICT',
    },
    authorRole: {
      type:      Sequelize.STRING,
      allowNull: false,
    },
    body: {
      type:      Sequelize.TEXT,
      allowNull: false,
    },
    status: {
      type:         Sequelize.ENUM('active', 'deleted'),
      allowNull:    false,
      defaultValue: 'active',
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

  await queryInterface.addIndex('Glp1WeekNotes', ['Glp1TherapyId', 'weekNumber', 'status'], {
    name: 'idx_glp1_week_notes_therapy_week',
  });
  await queryInterface.addIndex('Glp1WeekNotes', ['PatientId', 'status'], {
    name: 'idx_glp1_week_notes_patient_status',
  });
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = (await queryInterface.showAllTables())
      .map((t) => String(typeof t === 'string' ? t : t.tableName).toLowerCase());

    // No table at all — the create migration was skipped some other way. Build it.
    if (!tables.includes('glp1weeknotes')) {
      await buildTable(queryInterface, Sequelize);
      console.log('Glp1WeekNotes was missing — created');
      return;
    }

    // Guard on the column, not the table name — the whole point of this repair.
    const cols = await queryInterface.describeTable('Glp1WeekNotes');
    if (cols.Glp1TherapyId && cols.PatientId && cols.authorId) {
      console.log('Glp1WeekNotes is healthy — skipping');
      return;
    }

    // Malformed sync()-built table. Refuse to drop it if it somehow has rows.
    const [[{ n }]] = await queryInterface.sequelize.query(
      'SELECT COUNT(*) AS n FROM `Glp1WeekNotes`'
    );
    if (Number(n) > 0) {
      throw new Error(
        `Glp1WeekNotes is malformed (missing FK columns) but holds ${n} row(s) — ` +
        'refusing to drop it. Inspect and migrate the rows manually.'
      );
    }

    await queryInterface.dropTable('Glp1WeekNotes');
    await buildTable(queryInterface, Sequelize);
    console.log('Glp1WeekNotes was malformed (sync() race) — rebuilt with FK columns');
  },

  // The repair is not reversible to a broken state, and dropping a possibly
  // populated table on rollback would be worse than a no-op.
  async down() {},
};
