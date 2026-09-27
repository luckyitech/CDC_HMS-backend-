'use strict';

// Staff Email (B26) phase 4 — "Email this patient". The mail audit learns one
// more event:
//
//   event ENUM + 'patient_emailed'   a message went to a recipient picked AS a
//                                    patient (the Patient tag), confirmed
//                                    against that patient's file; logged on
//                                    the patient (patientId = canonical file)
//
// detail keeps the SUBJECT (≤ 200 characters — Emu's decision, 27 Sep), the
// ids of the file's documents that went with it, and counts + recipient
// domains. Never the body, never an address. Shown on that patient's
// Communications trail only; the admin Activity Log shows metadata.
//
// Guarded both ways. down deletes 'patient_emailed' rows before narrowing the
// ENUM back to phase 3b's list (MySQL would otherwise refuse or blank them).
// Must run after 20260926000003 (which added 'trash_emptied').

const TABLE = 'StaffMailEvents';
const OLD_EVENTS = ['connected', 'disconnected', 'auth_failed', 'wiped', 'sent', 'patient_docs_sent', 'saved_to_patient', 'trash_emptied'];
const NEW_EVENTS = [...OLD_EVENTS, 'patient_emailed'];

const tableExists = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables
    .map((t) => (typeof t === 'string' ? t : t.tableName).toLowerCase())
    .includes(name.toLowerCase());
};

const enumValues = (column) => {
  const m = String(column && column.type ? column.type : '').match(/^ENUM\((.*)\)$/i);
  return m ? m[1].split(',').map((v) => v.trim().replace(/^'|'$/g, '')) : [];
};

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface, TABLE))) return;
    const cols = await queryInterface.describeTable(TABLE);
    const current = enumValues(cols.event);
    if (!NEW_EVENTS.every((v) => current.includes(v))) {
      await queryInterface.changeColumn(TABLE, 'event', { type: Sequelize.ENUM(...NEW_EVENTS), allowNull: false });
    }
  },

  async down(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface, TABLE))) return;
    const cols = await queryInterface.describeTable(TABLE);
    if (enumValues(cols.event).includes('patient_emailed')) {
      await queryInterface.bulkDelete(TABLE, { event: 'patient_emailed' });
      await queryInterface.changeColumn(TABLE, 'event', { type: Sequelize.ENUM(...OLD_EVENTS), allowNull: false });
    }
  },
};
