'use strict';

// Adds finalSupplies to Queues — the itemised medications/supplies scanned at
// the discharge (checkout) desk and billed to the visit. Mirrors the existing
// finalCharges / finalProcedures JSON columns; each entry is
// { name, quantity, labelCode, stockBatchId } (labels + quantities, no money).
// The stock movements are the inventory truth; this is the per-visit bill
// record. Guarded with describeTable; working down().

const TABLE = 'Queues';
const COLUMN = 'finalSupplies';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable(TABLE);
    if (table[COLUMN]) return;
    await queryInterface.addColumn(TABLE, COLUMN, {
      type: Sequelize.JSON,
      allowNull: true,
      defaultValue: null,
    });
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable(TABLE);
    if (table[COLUMN]) {
      await queryInterface.removeColumn(TABLE, COLUMN);
    }
  },
};
