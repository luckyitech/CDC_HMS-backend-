'use strict';

/**
 * Links a checkout dispense to the visit it was dispensed for.
 *
 * Discharging is two steps: dispense the supplies, then save the discharge. If
 * the second step fails, the modal still closes, reception retries, and the
 * supplies go out a SECOND time — the bill records them once, the ledger twice,
 * and the difference walks off the shelf. Reproduced: two discharge attempts
 * took a batch of 10 down to 4 for a patient billed for 3.
 *
 * With the visit recorded on the movement, a repeat dispense for the same queue
 * entry can be recognised and refused instead of silently applying again.
 *
 * Nullable: every other movement type (intake, transfer, write-off, over-the-
 * counter use) has no visit, and historical rows have none either.
 *
 * Idempotent, with a working down().
 */

const TABLE = 'StockMovements';
const COLUMN = 'QueueId';
const INDEX = 'idx_stock_movements_queue';

const tableExists = async (queryInterface) => {
  const tables = (await queryInterface.showAllTables())
    .map((t) => String(typeof t === 'string' ? t : t.tableName).toLowerCase());
  return tables.includes(TABLE.toLowerCase());
};

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface))) {
      console.log(`${TABLE} does not exist yet — skipping`);
      return;
    }

    const desc = await queryInterface.describeTable(TABLE);
    if (desc[COLUMN]) {
      console.log(`${TABLE}.${COLUMN} already exists — skipping`);
      return;
    }

    await queryInterface.addColumn(TABLE, COLUMN, {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'Queues', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',   // a removed visit must never delete ledger rows
    });

    const indexes = await queryInterface.showIndex(TABLE);
    if (!indexes.some((i) => i.name === INDEX)) {
      await queryInterface.addIndex(TABLE, [COLUMN], { name: INDEX });
    }
  },

  async down(queryInterface) {
    if (!(await tableExists(queryInterface))) return;
    const desc = await queryInterface.describeTable(TABLE);
    if (!desc[COLUMN]) return;
    // Dropping the column takes its index and foreign key with it.
    await queryInterface.removeColumn(TABLE, COLUMN);
  },
};
