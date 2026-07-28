'use strict';

// Creates the append-only BarcodeScans audit table.
// Guarded per the repo convention: check showAllTables before acting, and a
// working down(). Safe to run on a database that already has the table.

const TABLE = 'BarcodeScans';

const tableExists = async (queryInterface) => {
  const tables = await queryInterface.showAllTables();
  return tables
    .map((t) => (typeof t === 'string' ? t : t.tableName).toLowerCase())
    .includes(TABLE.toLowerCase());
};

module.exports = {
  async up(queryInterface, Sequelize) {
    if (await tableExists(queryInterface)) return;

    await queryInterface.createTable(TABLE, {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false,
      },
      // Resolved canonical patient (association-generated PascalCase FK).
      // Nullable so future non-patient scans (lab, pharmacy, asset, stock)
      // can log to this same table without a migration.
      PatientId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Patients', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      // User who scanned — from the JWT.
      scannedBy: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      rawPayload: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      // 'patient' | 'labTest' | 'prescription' | 'asset' | 'stock' — plain
      // string, no ENUM, so new types need no schema change.
      resolvedType: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: 'patient',
      },
      redirectedFromUhid: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: null,
      },
      source: {
        type: Sequelize.ENUM('usb', 'camera'),
        allowNull: false,
        defaultValue: 'usb',
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface)) {
      await queryInterface.dropTable(TABLE);
    }
  },
};
