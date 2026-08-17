'use strict';

// Referral "Save & Print" note fields on Queues (mirror the admissionReason /
// admissionRequestedAt pattern). These persist the referral note a doctor
// documents during the consultation BEFORE the referral is finalised, so it can
// be printed on the clinic letterhead and shown in the Visit History Actions tab
// alongside admission notes and prescriptions. Both nullable so existing rows are
// untouched. Per-column guarded via describeTable; working down().

const TABLE = 'Queues';

const COLUMNS = {
  referralNote:        { type: (S) => ({ type: S.TEXT, allowNull: true }) },
  referralNoteSavedAt: { type: (S) => ({ type: S.DATE, allowNull: true }) },
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
