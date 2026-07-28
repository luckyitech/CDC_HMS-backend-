'use strict';

// Extends BarcodeScans from a scan log into a general barcode event log for
// the admin Activity Log:
//   - adds `action` ('scan' | 'print_card' | 'print_label' | 'email'),
//     backfilling existing rows to 'scan' via the default
//   - makes `source` nullable (generation events have no scan source)
// Guarded with describeTable; working down().

const TABLE = 'BarcodeScans';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName).toLowerCase());
    if (!names.includes(TABLE.toLowerCase())) return; // create-table migration hasn't run yet

    const table = await queryInterface.describeTable(TABLE);

    if (!table.action) {
      await queryInterface.addColumn(TABLE, 'action', {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: 'scan',
      });
    }

    if (table.source && table.source.allowNull === false) {
      await queryInterface.changeColumn(TABLE, 'source', {
        type: Sequelize.ENUM('usb', 'camera'),
        allowNull: true,
        defaultValue: null,
      });
    }
  },

  async down(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName).toLowerCase());
    if (!names.includes(TABLE.toLowerCase())) return;

    const table = await queryInterface.describeTable(TABLE);

    if (table.action) {
      await queryInterface.removeColumn(TABLE, 'action');
    }
    if (table.source && table.source.allowNull !== false) {
      await queryInterface.changeColumn(TABLE, 'source', {
        type: Sequelize.ENUM('usb', 'camera'),
        allowNull: false,
        defaultValue: 'usb',
      });
    }
  },
};
