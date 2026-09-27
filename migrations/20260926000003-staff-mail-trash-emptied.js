'use strict';

// Staff Email (B26) phase 3b — the mail audit learns one more event:
//
//   event ENUM + 'trash_emptied'   someone permanently emptied their OWN Trash
//                                  (detail = the message COUNT only)
//
// Emptying Trash is the only permanent action in My mail (one.com keeps no
// backups), so it is audited; moves, archives and flags are not (Emu, 26 Sep).
// Still metadata only (decision D1): never subjects, senders or addresses.
//
// Guarded both ways. down deletes 'trash_emptied' rows before narrowing the
// ENUM back to phase 3a's list (MySQL would otherwise refuse or blank them).
// Must run after 20260926000002 (which added the phase 3a events).

const TABLE = 'StaffMailEvents';
const OLD_EVENTS = ['connected', 'disconnected', 'auth_failed', 'wiped', 'sent', 'patient_docs_sent', 'saved_to_patient'];
const NEW_EVENTS = [...OLD_EVENTS, 'trash_emptied'];

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
    if (enumValues(cols.event).includes('trash_emptied')) {
      await queryInterface.bulkDelete(TABLE, { event: 'trash_emptied' });
      await queryInterface.changeColumn(TABLE, 'event', { type: Sequelize.ENUM(...OLD_EVENTS), allowNull: false });
    }
  },
};
