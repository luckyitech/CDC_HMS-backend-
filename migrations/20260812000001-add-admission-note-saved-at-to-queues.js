'use strict';

// Adds admissionNoteSavedAt to Queues — when the admission NOTE was documented
// via "Save & Print", as distinct from admissionRequestedAt (when the visit was
// actually sent for admission).
//
// Before this, saveNote stamped admissionRequestedAt, so a note that was only
// documented looked like a request in the record. Mirrors referralNoteSavedAt on
// the referral side. Nullable, so existing rows are untouched — listAdvised
// falls back to admissionRequestedAt for rows written before this column.
//
// Per-column guarded via describeTable; working down().

const TABLE = 'Queues';

const COLUMNS = {
  admissionNoteSavedAt: { type: (S) => ({ type: S.DATE, allowNull: true }) },
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable(TABLE);
    for (const [name, def] of Object.entries(COLUMNS)) {
      if (!table[name]) {
        await queryInterface.addColumn(TABLE, name, def.type(Sequelize));
      }
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable(TABLE);
    for (const name of Object.keys(COLUMNS)) {
      if (table[name]) await queryInterface.removeColumn(TABLE, name);
    }
  },
};
