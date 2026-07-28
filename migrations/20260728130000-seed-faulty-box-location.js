'use strict';

/**
 * Seeds a "Faulty Box" quarantine location.
 *
 * Returned items that are not safe to re-dispense (a faulty CGM sensor, a
 * broken glucometer, the wrong medicine handed out) are parked here. It is a
 * real StockLocation with isDispensing = false, so the ledger and the dispense
 * flow both refuse to hand its stock out again — a returned faulty item can
 * only leave by being moved back into normal stock first (a logged transfer),
 * or written off.
 *
 * Idempotent: skips if a location of kind 'faulty' already exists.
 */

module.exports = {
  async up(queryInterface) {
    const tables = (await queryInterface.showAllTables())
      .map((t) => String(typeof t === 'string' ? t : t.tableName).toLowerCase());
    if (!tables.includes('stocklocations')) {
      console.log('StockLocations not found — skipping Faulty Box seed');
      return;
    }

    const [existing] = await queryInterface.sequelize.query(
      "SELECT id FROM `StockLocations` WHERE `kind` = 'faulty' LIMIT 1"
    );
    if (existing.length) {
      console.log('A faulty-box location already exists — skipping');
      return;
    }

    const now = new Date();
    await queryInterface.bulkInsert('StockLocations', [{
      name: 'Faulty Box',
      kind: 'faulty',
      isColdChain: false,
      isDispensing: false,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }]);
    console.log('Seeded the Faulty Box quarantine location');
  },

  async down(queryInterface) {
    const tables = (await queryInterface.showAllTables())
      .map((t) => String(typeof t === 'string' ? t : t.tableName).toLowerCase());
    if (!tables.includes('stocklocations')) return;

    // Only remove it if nothing was ever quarantined there.
    const [rows] = await queryInterface.sequelize.query(
      "SELECT id FROM `StockLocations` WHERE `kind` = 'faulty'"
    );
    for (const r of rows) {
      const [used] = await queryInterface.sequelize.query(
        'SELECT 1 FROM `StockLevels` WHERE `locationId` = ' + r.id +
        ' UNION SELECT 1 FROM `StockMovements` WHERE `toLocationId` = ' + r.id +
        ' OR `fromLocationId` = ' + r.id + ' LIMIT 1'
      );
      if (!used.length) {
        await queryInterface.bulkDelete('StockLocations', { id: r.id });
      }
    }
  },
};
