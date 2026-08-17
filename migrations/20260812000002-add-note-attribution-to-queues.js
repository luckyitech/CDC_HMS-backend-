'use strict';

// Note attribution on Queues — two columns that keep a DOCUMENTED note distinct
// from a SENT admission/referral.
//
//   admissionNoteSavedAt      — when the admission note was documented via
//                               "Save & Print", as distinct from
//                               admissionRequestedAt (when it was actually sent
//                               for admission).
//   referralNoteByDoctorName  — who wrote the referral note. Deliberately NOT
//                               referredByDoctorName: on an internal referral
//                               that field records the doctor who MADE the
//                               referral, and the receiving doctor may later
//                               write a note on the same queue row. Overwriting
//                               it destroys the referral's audit trail — the
//                               exact thing models/Queue.js keeps a name string
//                               to protect.
//
// Both nullable, so existing rows are untouched; the read paths fall back to the
// older columns for rows written before this.
//
// Per-column guarded via describeTable; working down().
//
// NOTE: down() drops these columns and the attribution recorded in them. Do not
// run migrate:undo after go-live without taking a dump first.

const TABLE = 'Queues';

const COLUMNS = {
  admissionNoteSavedAt:     { type: (S) => ({ type: S.DATE,   allowNull: true }) },
  referralNoteByDoctorName: { type: (S) => ({ type: S.STRING, allowNull: true }) },
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
