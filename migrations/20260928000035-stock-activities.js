'use strict';

// Stock audit (13 Oct 2026, Emu): every function in the Stocks tabs is time-
// stamped and shows in the Activity Log, the Staff File Activity tab and
// Stocks → Analytics → Audit. Movements, deliveries and line edits already
// carry who + when; this table records the functions that leave no other trace:
//
//   StockActivities  NEW — one row per: stocktake completed (even when every
//                    count matched), par levels changed, room matched to a
//                    doctor, item / location / supplier added, edited, retired
//                    or reactivated, a test settled or taken later, levels
//                    rebuilt. action + who + where + a display detail.
//
// `down`: REFUSES once anything is recorded (audit evidence — restore the
// backup instead).

const TAG = '[20260928000035]';

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;
    const users = await findTable(qi, 'Users');
    const locations = await findTable(qi, 'StockLocations');
    const items = await findTable(qi, 'StockItems');
    if (!users || !locations || !items) throw new Error(`${TAG} a required table is missing`);

    if (!await findTable(qi, 'StockActivities')) {
      await qi.createTable('StockActivities', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        action: { type: Sequelize.STRING(40), allowNull: false },
        userId: {
          type: Sequelize.INTEGER, allowNull: true,
          references: { model: users, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
        },
        locationId: {
          type: Sequelize.INTEGER, allowNull: true,
          references: { model: locations, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
        },
        stockItemId: {
          type: Sequelize.INTEGER, allowNull: true,
          references: { model: items, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
        },
        detail: { type: Sequelize.STRING(500), allowNull: true },
        // A stocktake: when the counter's list was drawn (createdAt = submitted).
        startedAt: { type: Sequelize.DATE, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      await qi.addIndex('StockActivities', ['createdAt'], { name: 'idx_stock_activities_created' });
      await qi.addIndex('StockActivities', ['action', 'locationId'], { name: 'idx_stock_activities_action_location' });
      console.log(`${TAG} StockActivities created`);
    }
  },

  async down(queryInterface) {
    const qi = queryInterface;
    const t = await findTable(qi, 'StockActivities');
    if (!t) return;
    const [rows] = await qi.sequelize.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
    const n = Number(rows[0].n ?? rows[0].N ?? 0);
    if (n > 0) throw new Error(`${TAG} down refused: ${n} stock activity record(s). Restore the database backup instead.`);
    await qi.dropTable(t);
    console.log(`${TAG} reverted (nothing used it)`);
  },
};
