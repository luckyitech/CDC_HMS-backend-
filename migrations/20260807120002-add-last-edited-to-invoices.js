'use strict';

// Billing — who last changed a bill before it was issued.
//
// An ISSUED invoice is already immutable, and voiding records its own reason
// and author. The gap was the draft: reception can add, remove and re-price
// lines freely while the checkout is open, and nothing recorded who did.
//
// Deliberately "last editor", not a full history. The checkout re-syncs on
// every tick, so a per-change log would be thousands of rows describing one
// person building one bill. What is worth knowing is whose hands were on it
// last — and the moment it is issued, the lines are frozen anyway.
// Guarded; working down().

const TABLE = 'Invoices';
const COLUMNS = {
  lastEditedById: (Sequelize) => ({
    type: Sequelize.INTEGER,
    allowNull: true,
    defaultValue: null,
    references: { model: 'Users', key: 'id' },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
  }),
  lastEditedAt: (Sequelize) => ({
    type: Sequelize.DATE,
    allowNull: true,
    defaultValue: null,
  }),
};

const existing = async (queryInterface) => Object.keys(await queryInterface.describeTable(TABLE));

module.exports = {
  async up(queryInterface, Sequelize) {
    const have = await existing(queryInterface);
    for (const [name, define] of Object.entries(COLUMNS)) {
      if (!have.includes(name)) await queryInterface.addColumn(TABLE, name, define(Sequelize));
    }
  },

  async down(queryInterface) {
    const have = await existing(queryInterface);
    for (const name of Object.keys(COLUMNS)) {
      if (have.includes(name)) await queryInterface.removeColumn(TABLE, name);
    }
  },
};
