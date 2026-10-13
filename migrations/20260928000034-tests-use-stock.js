'use strict';

// Tests use stock (13 Oct 2026, Emu): an HbA1c / RBS / Ketones done at triage
// or in a consultation takes ONE strip/cartridge out of the room it was done
// in — every attempt, including a repeat after an error reading or a
// confirmatory repeat — and the charge sheet counts attempts ("HbA1c × 2").
// No per-test set-up: the test matches its item BY NAME, and the room comes
// from the par levels (triage → the triage room; a doctor → the room matched
// to that doctor in Room Balance → edit pars).
//
//   StockItems                   3 default items, added if missing — the names
//                                the tests match on (locked against renaming).
//   StockLocations.assignedDoctorId NEW — the doctor who works in this room.
//   QueueCharges.stockStatus     NEW — for a test line: 'taken' | 'not_taken' |
//   QueueCharges.stockNote       NEW   'returned' | 'resolved', and why.
//   StockMovements.queueChargeId NEW — the charge-sheet line a 'use' was for.
//
// `down`: REFUSES once a test has taken stock.

const TAG = '[20260928000034]';
// Keep in step with utils/testStock.js TEST_ITEMS.
const DEFAULT_ITEMS = ['HbA1c test cartridge', 'Blood glucose test strip', 'Ketone test strip'];

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};
const count = async (qi, sql, replacements) => {
  const [rows] = await qi.sequelize.query(sql, { replacements });
  return Number(rows[0].n ?? rows[0].N ?? 0);
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;
    const items = await findTable(qi, 'StockItems');
    const locations = await findTable(qi, 'StockLocations');
    const users = await findTable(qi, 'Users');
    const charges = await findTable(qi, 'QueueCharges');
    const movements = await findTable(qi, 'StockMovements');
    if (!items || !locations || !users || !charges || !movements) throw new Error(`${TAG} a required table is missing`);

    const sl = await qi.describeTable(locations);
    if (!sl.assignedDoctorId) {
      await qi.addColumn(locations, 'assignedDoctorId', {
        type: Sequelize.INTEGER, allowNull: true,
        references: { model: users, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      });
      console.log(`${TAG} StockLocations.assignedDoctorId added`);
    }

    const now = new Date();
    for (const name of DEFAULT_ITEMS) {
      if (await count(qi, `SELECT COUNT(*) AS n FROM \`${items}\` WHERE name = ?`, [name])) continue;
      await qi.bulkInsert(items, [{
        name, category: 'diagnostic', unit: 'piece', packSize: 1,
        requiresColdChain: false, isHighAlert: false, reorderLevel: 0,
        status: 'active', createdAt: now, updatedAt: now,
      }]);
      console.log(`${TAG} item "${name}" added`);
    }

    const qc = await qi.describeTable(charges);
    if (!qc.stockStatus) {
      await qi.addColumn(charges, 'stockStatus', { type: Sequelize.STRING(20), allowNull: true });
      console.log(`${TAG} QueueCharges.stockStatus added`);
    }
    if (!qc.stockNote) {
      await qi.addColumn(charges, 'stockNote', { type: Sequelize.STRING(255), allowNull: true });
      console.log(`${TAG} QueueCharges.stockNote added`);
    }
    const sm = await qi.describeTable(movements);
    if (!sm.queueChargeId) {
      await qi.addColumn(movements, 'queueChargeId', { type: Sequelize.INTEGER, allowNull: true });
      await qi.addIndex(movements, ['queueChargeId'], { name: 'idx_stock_movements_queue_charge' });
      console.log(`${TAG} StockMovements.queueChargeId added`);
    }
  },

  async down(queryInterface) {
    const qi = queryInterface;
    const movements = await findTable(qi, 'StockMovements');
    const charges = await findTable(qi, 'QueueCharges');
    const locations = await findTable(qi, 'StockLocations');
    const items = await findTable(qi, 'StockItems');
    const batches = await findTable(qi, 'StockBatches');
    if (movements && (await qi.describeTable(movements)).queueChargeId) {
      const n = await count(qi, `SELECT COUNT(*) AS n FROM \`${movements}\` WHERE queueChargeId IS NOT NULL`);
      if (n > 0) throw new Error(`${TAG} down refused: ${n} test(s) have taken stock. Restore the database backup instead.`);
      try { await qi.removeIndex(movements, 'idx_stock_movements_queue_charge'); } catch { /* gone */ }
      await qi.removeColumn(movements, 'queueChargeId');
    }
    if (charges) {
      const qc = await qi.describeTable(charges);
      if (qc.stockStatus) await qi.removeColumn(charges, 'stockStatus');
      if (qc.stockNote) await qi.removeColumn(charges, 'stockNote');
    }
    // The default items go only if nothing was ever received against them.
    if (items) {
      for (const name of DEFAULT_ITEMS) {
        const used = batches ? await count(qi,
          `SELECT COUNT(*) AS n FROM \`${batches}\` b JOIN \`${items}\` i ON i.id = b.stockItemId WHERE i.name = ?`, [name]) : 0;
        if (!used) await qi.sequelize.query(`DELETE FROM \`${items}\` WHERE name = ? AND id NOT IN (SELECT stockItemId FROM StockParLevels)`, { replacements: [name] });
      }
    }
    if (locations && (await qi.describeTable(locations)).assignedDoctorId) {
      await qi.removeColumn(locations, 'assignedDoctorId');
    }
    console.log(`${TAG} reverted (nothing used it)`);
  },
};
