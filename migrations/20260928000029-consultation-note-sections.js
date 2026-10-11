'use strict';

// Consultation notes — history sections (10 Oct 2026, Emu; plan
// claude/session-2026-10-10-history-in-notes-plan.md).
//
// The Initial Assessment form is retired (its table and old rows stay —
// Visit History still shows them; POST /api/assessments now answers 410).
// A consultation note is made of SECTIONS instead:
//
//   ConsultationNoteSections      NEW — ConsultationNoteId, PatientId
//                                 (canonical), key (utils/noteSections),
//                                 position, html (sanitised formatting),
//                                 text (plain copy), reviewed ("no change"),
//                                 carriedFromSectionId (provenance).
//   ConsultationNoteSectionItems  NEW — one tick per row: item + value, so
//                                 "patients with Retinopathy = Yes" is SQL.
//
// ConsultationNotes.notes is untouched: for a note made of sections it holds
// the plain-text rendition, so every existing reader keeps working.
//
// `down`: REFUSES once any section exists (medical record — restore the
// backup instead); when both tables are empty it drops them, child first.

const TAG = '[20260928000029]';

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};
const countRows = async (qi, table) => {
  const [rows] = await qi.sequelize.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
  return Number(rows[0].n ?? rows[0].N ?? 0);
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;
    const notes = await findTable(qi, 'ConsultationNotes') || 'ConsultationNotes';
    const patients = await findTable(qi, 'Patients') || 'Patients';

    let sections = await findTable(qi, 'ConsultationNoteSections');
    if (!sections) {
      await qi.createTable('ConsultationNoteSections', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        ConsultationNoteId: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: notes, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        PatientId: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: patients, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        key: { type: Sequelize.STRING(40), allowNull: false },
        position: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        html: { type: Sequelize.TEXT, allowNull: false },
        text: { type: Sequelize.TEXT, allowNull: false },
        reviewed: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        carriedFromSectionId: { type: Sequelize.INTEGER, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      await qi.addIndex('ConsultationNoteSections', ['ConsultationNoteId', 'key'], { name: 'uq_note_section', unique: true });
      // "the last time this section was written for this patient"
      await qi.addIndex('ConsultationNoteSections', ['PatientId', 'key', 'id'], { name: 'idx_note_section_patient_key' });
      sections = 'ConsultationNoteSections';
      console.log(`${TAG} ConsultationNoteSections created`);
    } else {
      console.log(`${TAG} ConsultationNoteSections already exists — skipped`);
    }

    if (!await findTable(qi, 'ConsultationNoteSectionItems')) {
      await qi.createTable('ConsultationNoteSectionItems', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        ConsultationNoteSectionId: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: sections, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        item: { type: Sequelize.STRING(120), allowNull: false },
        value: { type: Sequelize.STRING(120), allowNull: false, defaultValue: 'yes' },
      });
      await qi.addIndex('ConsultationNoteSectionItems', ['ConsultationNoteSectionId'], { name: 'idx_note_section_item_section' });
      await qi.addIndex('ConsultationNoteSectionItems', ['item', 'value'], { name: 'idx_note_section_item_value' });
      console.log(`${TAG} ConsultationNoteSectionItems created`);
    } else {
      console.log(`${TAG} ConsultationNoteSectionItems already exists — skipped`);
    }
  },

  async down(queryInterface) {
    const qi = queryInterface;
    const sections = await findTable(qi, 'ConsultationNoteSections');
    const items = await findTable(qi, 'ConsultationNoteSectionItems');
    if (sections && await countRows(qi, sections) > 0) {
      throw new Error(`${TAG} refusing to drop ConsultationNoteSections: it holds consultation-note sections (medical record). Restore a backup instead.`);
    }
    if (items) { await qi.dropTable(items); console.log(`${TAG} ConsultationNoteSectionItems dropped`); }
    if (sections) { await qi.dropTable(sections); console.log(`${TAG} ConsultationNoteSections dropped`); }
  },
};
