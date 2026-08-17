'use strict';

// The nurse → doctor dispatch moment. triageEndTime is when vitals were saved;
// sentToDoctorAt is when the nurse actually routed the patient to a doctor
// (the "Awaiting Doctor" transition from a nurse-facing status). The gap
// between them is time the patient sat with nursing after triage, and
// createdAt → sentToDoctorAt is the door-to-doctor-queue wait — neither was
// measurable before. Nullable; existing rows are untouched.
//
// Guarded via describeTable; working down().

const TABLE  = 'Queues';
const COLUMN = 'sentToDoctorAt';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable(TABLE);
    if (table[COLUMN]) return;

    await queryInterface.addColumn(TABLE, COLUMN, {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable(TABLE);
    if (table[COLUMN]) await queryInterface.removeColumn(TABLE, COLUMN);
  },
};
