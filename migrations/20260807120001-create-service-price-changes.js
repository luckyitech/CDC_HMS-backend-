'use strict';

// Billing — an append-only history of what a service used to cost.
//
// ServiceItem records WHO last edited it and WHEN, but not WHAT CHANGED. That
// left this open:
//
//   Drop HbA1c from 3,500 to 500. Bill the patient 500 officially, take 3,500
//   in cash, keep the difference. Put the price back five minutes later.
//
//   The activity log shows two edits by that person. NEITHER shows an amount.
//   Every invoice raised in between is arithmetically perfect.
//
// One row per change makes the dip visible. Append-only, like StockMovement and
// Payment — the correction to a wrong entry is another entry, never an edit.
// Guarded; working down().

const TABLE = 'ServicePriceChanges';

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

      // RESTRICT: a service that has a price history is never destroyed. It is
      // retired like everything else in this module.
      serviceItemId: {
        type: Sequelize.INTEGER, allowNull: false,
        references: { model: 'ServiceItems', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT',
      },

      // Both sides of every change. NULL on the price columns means "not priced"
      // — the state a seeded service starts in — and is distinct from 0.
      oldPriceMinor: { type: Sequelize.BIGINT, allowNull: true, defaultValue: null },
      newPriceMinor: { type: Sequelize.BIGINT, allowNull: true, defaultValue: null },
      oldVatClass: { type: Sequelize.STRING, allowNull: true, defaultValue: null },
      newVatClass: { type: Sequelize.STRING, allowNull: true, defaultValue: null },
      oldStatus: { type: Sequelize.STRING, allowNull: true, defaultValue: null },
      newStatus: { type: Sequelize.STRING, allowNull: true, defaultValue: null },

      // SET NULL rather than RESTRICT: a leaver's account may be removed, and
      // losing the name is better than being unable to remove them. The row
      // itself survives either way.
      changedById: {
        type: Sequelize.INTEGER, allowNull: true, defaultValue: null,
        references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },

      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    // "What has this service cost over time" and "what changed today" are the
    // two questions this table exists to answer.
    await queryInterface.addIndex(TABLE, ['serviceItemId', 'createdAt'], {
      name: 'idx_price_changes_service_created',
    });
    await queryInterface.addIndex(TABLE, ['createdAt'], {
      name: 'idx_price_changes_created',
    });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface)) {
      await queryInterface.dropTable(TABLE);
    }
  },
};
