'use strict';

// HMIS V3 Phase 1 — admission-request fields on Queues (mirror the referral*
// columns). All nullable/defaulted so existing rows are untouched. Per-column
// guarded via describeTable; working down().

const TABLE = 'Queues';

const COLUMNS = {
  admissionRequested:             { type: (S) => ({ type: S.BOOLEAN, allowNull: false, defaultValue: false }) },
  admissionReason:                { type: (S) => ({ type: S.TEXT, allowNull: true }) },
  admissionType:                  { type: (S) => ({ type: S.ENUM('Emergency', 'Elective', 'Transfer', 'Observation'), allowNull: true }) },
  admissionWardPreference:        { type: (S) => ({ type: S.STRING, allowNull: true }) },
  admissionRequestedByDoctorName: { type: (S) => ({ type: S.STRING, allowNull: true }) },
  admissionRequestedAt:           { type: (S) => ({ type: S.DATE, allowNull: true }) },
  admissionConvertedToId:         { type: (S) => ({ type: S.INTEGER, allowNull: true }) },
  admissionCancelledAt:           { type: (S) => ({ type: S.DATE, allowNull: true }) },
  admissionCancelReason:          { type: (S) => ({ type: S.TEXT, allowNull: true }) },
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
