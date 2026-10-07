'use strict';

// Autosave drafts (6 Oct 2026) — every doctor's typed form saves itself as a
// DRAFT while the doctor types, so a refresh, a sleeping tablet or the logout
// a `pm2 restart` causes no longer loses clinical text.
//
//   FormDrafts   NEW — one row per (author, patient, form, context):
//                userId (the author, from the JWT), PatientId (the canonical
//                patient), formKey ('consultation-notes', 'prescription', …),
//                contextKey ('' or e.g. an admission id), label (what the
//                reminders call it), payload (the form's state, JSON text),
//                device (which device saved last), reminderSentAt (the
//                day-12 "will be deleted" bell, once), createdAt, updatedAt.
//
// A draft is NOT part of the medical record: only its author sees it, it is
// deleted when the real save succeeds, and the hourly sweep deletes anything
// untouched for 14 days. So deleting rows here is by design (no soft delete).
//
// Touches no existing table and seeds nothing.
//
// `down`: drops the table. Drafts are throw-away by design (never part of the
// record), so this is not a lossy down in the record sense — but it does wipe
// unsaved typing, so it REFUSES while any draft newer than 1 day exists
// (someone may be mid-note). Guarded both ways; table names compared
// case-insensitively (the VDS returns them lowercase).

const TAG = '[20260928000019]';

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;
    if (await findTable(qi, 'FormDrafts')) {
      console.log(`${TAG} FormDrafts already exists — nothing to do`);
      return;
    }
    const users = await findTable(qi, 'Users') || 'Users';
    const patients = await findTable(qi, 'Patients') || 'Patients';

    await qi.createTable('FormDrafts', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      userId: {
        type: Sequelize.INTEGER, allowNull: false,
        references: { model: users, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
      },
      PatientId: {
        type: Sequelize.INTEGER, allowNull: false,
        references: { model: patients, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
      },
      formKey: { type: Sequelize.STRING(64), allowNull: false },
      contextKey: { type: Sequelize.STRING(64), allowNull: false, defaultValue: '' },
      label: { type: Sequelize.STRING(120), allowNull: true },
      payload: { type: Sequelize.TEXT('long'), allowNull: false },
      device: { type: Sequelize.STRING(60), allowNull: true },
      reminderSentAt: { type: Sequelize.DATE, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await qi.addIndex('FormDrafts', ['userId', 'PatientId', 'formKey', 'contextKey'], {
      name: 'uq_form_draft_owner_form', unique: true,
    });
    await qi.addIndex('FormDrafts', ['updatedAt'], { name: 'idx_form_draft_updated' });
    console.log(`${TAG} FormDrafts created`);
  },

  async down(queryInterface) {
    const qi = queryInterface;
    const table = await findTable(qi, 'FormDrafts');
    if (!table) return;
    const [rows] = await qi.sequelize.query(
      `SELECT COUNT(*) AS n FROM \`${table}\` WHERE updatedAt > DATE_SUB(NOW(), INTERVAL 1 DAY)`,
    );
    const n = Number(rows[0].n ?? rows[0].N ?? 0);
    if (n > 0) throw new Error(`${TAG} down refused: ${n} draft(s) saved in the last day — someone may be mid-note.`);
    await qi.dropTable(table);
    console.log(`${TAG} FormDrafts dropped`);
  },
};
