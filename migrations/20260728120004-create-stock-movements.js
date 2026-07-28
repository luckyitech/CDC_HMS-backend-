'use strict';

// Stock module — the append-only ledger, the source of truth. Rows are never
// updated or deleted; mistakes are corrected by a reversing entry, exactly
// like an accounting ledger. Reportable data lives in rows, not JSON (repo
// rule). PatientId/prescriptionId ship nullable now so the future
// patient-linked-dispensing phase needs no migration. Guarded; down().

const TABLE = 'StockMovements';

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
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      // 'intake' | 'dispense' | 'use' | 'transfer' | 'adjustment' |
      // 'expiry_writeoff' | 'damage_writeoff' | 'return' | 'reversal' —
      // STRING so new types need no migration.
      type: { type: Sequelize.STRING, allowNull: false },
      // Denormalised from the batch for fast per-item reporting.
      stockItemId: {
        type: Sequelize.INTEGER, allowNull: false,
        references: { model: 'StockItems', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT',
      },
      stockBatchId: {
        type: Sequelize.INTEGER, allowNull: false,
        references: { model: 'StockBatches', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT',
      },
      // Always positive — direction comes from type + locations, not sign.
      quantity: { type: Sequelize.INTEGER, allowNull: false },
      // Null for intake (stock enters the world).
      fromLocationId: {
        type: Sequelize.INTEGER, allowNull: true,
        references: { model: 'StockLocations', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT',
      },
      // Null for dispense / use / write-off (stock leaves the world).
      toLocationId: {
        type: Sequelize.INTEGER, allowNull: true,
        references: { model: 'StockLocations', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT',
      },
      // Association-generated PascalCase FK (Patient.hasMany convention).
      // Nullable — the patient-linking phase activates it later; when it does,
      // writes go via resolvePatient → family.patient.id.
      PatientId: {
        type: Sequelize.INTEGER, allowNull: true,
        references: { model: 'Patients', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      prescriptionId: {
        type: Sequelize.INTEGER, allowNull: true,
        references: { model: 'Prescriptions', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      // From the JWT, never the client.
      performedById: {
        type: Sequelize.INTEGER, allowNull: false,
        references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT',
      },
      // Required by the controller for adjustment, write-offs, reversal and
      // FEFO overrides. TEXT — free-text reasons and the concatenated
      // stocktake string can exceed 255 chars; MySQL 8 strict mode errors
      // on overflow rather than truncating.
      reason: { type: Sequelize.TEXT, allowNull: true, defaultValue: null },
      // Set on 'reversal' rows, pointing at the corrected entry.
      reversesMovementId: {
        type: Sequelize.INTEGER, allowNull: true,
        references: { model: TABLE, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    // Movement history & consumption reports filter on these.
    await queryInterface.addIndex(TABLE, ['stockItemId', 'createdAt'], {
      name: 'idx_stock_movements_item_created',
    });
    await queryInterface.addIndex(TABLE, ['stockBatchId'], {
      name: 'idx_stock_movements_batch',
    });
    await queryInterface.addIndex(TABLE, ['type', 'createdAt'], {
      name: 'idx_stock_movements_type_created',
    });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface)) {
      await queryInterface.dropTable(TABLE);
    }
  },
};
