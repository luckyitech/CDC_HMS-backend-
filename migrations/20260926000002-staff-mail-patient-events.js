'use strict';

// Staff Email (B26) phase 3a — the mail audit learns which PATIENT an event
// was about, so "documents emailed from this patient's file" and "email
// attachment saved to this patient's file" appear against the patient in the
// Activity log.
//
//   StaffMailEvents.patientId   nullable; the canonical patient (after merge
//                               resolution). camelCase: an explicitly aliased
//                               key, like userId / actorId on this table (A4).
//   event ENUM + 'patient_docs_sent', 'saved_to_patient'
//
// Still metadata only (decision D1): a document COUNT, a recipient COUNT and
// recipient DOMAINS — never addresses, subjects, bodies or file names.
//
// Guarded both ways; down deletes the rows that use the new events before
// narrowing the ENUM (MySQL would otherwise refuse or blank them).

const TABLE = 'StaffMailEvents';
const OLD_EVENTS = ['connected', 'disconnected', 'auth_failed', 'wiped', 'sent'];
const NEW_EVENTS = [...OLD_EVENTS, 'patient_docs_sent', 'saved_to_patient'];

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

    if (!cols.patientId) {
      await queryInterface.addColumn(TABLE, 'patientId', {
        type: Sequelize.INTEGER, allowNull: true,
        references: { model: 'Patients', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      });
      await queryInterface.addIndex(TABLE, ['patientId'], { name: 'staff_mail_events_patient' });
    }

    const current = enumValues(cols.event);
    if (!NEW_EVENTS.every((v) => current.includes(v))) {
      await queryInterface.changeColumn(TABLE, 'event', { type: Sequelize.ENUM(...NEW_EVENTS), allowNull: false });
    }
  },

  async down(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface, TABLE))) return;
    const cols = await queryInterface.describeTable(TABLE);

    if (enumValues(cols.event).some((v) => !OLD_EVENTS.includes(v))) {
      await queryInterface.bulkDelete(TABLE, { event: ['patient_docs_sent', 'saved_to_patient'] });
      await queryInterface.changeColumn(TABLE, 'event', { type: Sequelize.ENUM(...OLD_EVENTS), allowNull: false });
    }

    if (cols.patientId) {
      // Foreign key first: MySQL refuses to drop an index a constraint still uses.
      const refs = await queryInterface.getForeignKeyReferencesForTable(TABLE);
      for (const ref of refs.filter((r) => r.columnName === 'patientId')) {
        await queryInterface.removeConstraint(TABLE, ref.constraintName);
      }
      const indexes = await queryInterface.showIndex(TABLE);
      if (indexes.some((i) => i.name === 'staff_mail_events_patient')) {
        await queryInterface.removeIndex(TABLE, 'staff_mail_events_patient');
      }
      await queryInterface.removeColumn(TABLE, 'patientId');
    }
  },
};
