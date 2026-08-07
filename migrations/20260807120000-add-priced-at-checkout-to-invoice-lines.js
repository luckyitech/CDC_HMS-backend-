'use strict';

// Billing — records that a line's price was typed at the checkout desk rather
// than coming off the price list an admin controls.
//
// A supply scanned at checkout that no service is linked to has no price to
// look up. Reception may set one so the patient is charged and nothing leaves
// the clinic unbilled — but that hands the person taking the money the ability
// to decide what it costs, so every such price carries the name of whoever
// typed it and is reviewable afterwards.
//
// NULL is the normal case: the line was priced from the price list.
// Guarded; working down().

const TABLE = 'InvoiceLines';
const COLUMN = 'pricedAtCheckoutById';

const columnExists = async (queryInterface) => {
  const table = await queryInterface.describeTable(TABLE);
  return Object.keys(table).includes(COLUMN);
};

module.exports = {
  async up(queryInterface, Sequelize) {
    if (await columnExists(queryInterface)) return;

    await queryInterface.addColumn(TABLE, COLUMN, {
      type: Sequelize.INTEGER,
      allowNull: true,
      defaultValue: null,
      references: { model: 'Users', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });

    // The review report reads "every ad-hoc priced line, newest first".
    await queryInterface.addIndex(TABLE, [COLUMN], {
      name: 'idx_invoice_lines_priced_at_checkout',
    });
  },

  async down(queryInterface) {
    if (!(await columnExists(queryInterface))) return;
    await queryInterface.removeIndex(TABLE, 'idx_invoice_lines_priced_at_checkout').catch(() => {});
    await queryInterface.removeColumn(TABLE, COLUMN);
  },
};
