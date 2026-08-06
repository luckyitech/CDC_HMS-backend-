'use strict';

// Billing module — the price list. One row per billable thing the clinic sells.
// Replaces the hardcoded CHARGE_OPTIONS / PROCEDURE_OPTIONS arrays in the
// frontend. Guarded; working down().
//
// The tableExists helper is repeated in every migration rather than shared.
// That is deliberate: a migration is a historical record and must run the same
// way in five years as it did today, so it may not depend on a utility that
// could change underneath it.

const TABLE = 'ServiceItems';

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
      // Optional short code for the price list and receipts ('CONS', 'HBA1C').
      // Nullable + unique: MySQL permits repeated NULLs, so codes are opt-in.
      code: { type: Sequelize.STRING, allowNull: true, unique: true, defaultValue: null },
      // Unique because the checkout resolves a visit's charge labels back to
      // price list rows by name.
      name: { type: Sequelize.STRING, allowNull: false, unique: true },
      // 'consultation' | 'procedure' | 'laboratory' | 'injection' | 'supply' |
      // 'other' — STRING not ENUM so the clinic gains a category without a
      // migration. Validated in the model against constants/billing.js.
      category: { type: Sequelize.STRING, allowNull: false, defaultValue: 'other' },
      description: { type: Sequelize.STRING, allowNull: true, defaultValue: null },

      // NULL means NOT YET PRICED — deliberately distinct from zero. Issuing an
      // invoice containing an unpriced line is refused. Defaulting to 0 would
      // hand out free services until somebody noticed.
      // BIGINT of minor units (cents), never DECIMAL — see utils/money.js.
      unitPriceMinor: { type: Sequelize.BIGINT, allowNull: true, defaultValue: null },

      // 'exempt' | 'standard' | 'zero'. The RATE is not stored here: it is
      // derived at invoice time from this class plus the clinic's configured
      // standard rate, then snapshotted onto the line.
      vatClass: { type: Sequelize.STRING, allowNull: false, defaultValue: 'exempt' },

      // 'active' | 'retired' — soft delete, never destroy(). A service that has
      // ever been billed must stay resolvable for as long as its invoices exist.
      status: { type: Sequelize.STRING, allowNull: false, defaultValue: 'active' },

      // Links a billable supply to the StockItem it is dispensed from, so a
      // batch scanned at checkout resolves to a price.
      stockItemId: {
        type: Sequelize.INTEGER, allowNull: true, defaultValue: null,
        references: { model: 'StockItems', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      addedById: {
        type: Sequelize.INTEGER, allowNull: true, defaultValue: null,
        references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      lastUpdatedById: {
        type: Sequelize.INTEGER, allowNull: true, defaultValue: null,
        references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    // The price list screen: active items grouped by category.
    await queryInterface.addIndex(TABLE, ['status', 'category'], {
      name: 'idx_service_items_status_category',
    });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface)) {
      await queryInterface.dropTable(TABLE);
    }
  },
};
