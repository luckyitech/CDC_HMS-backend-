'use strict';

// Billing module — one billable line on an invoice.
//
// Every commercial fact here is a SNAPSHOT taken when the line was created: the
// description, the price, the VAT class, the rate, the tax code. Nothing is read
// back through serviceItemId to render the invoice. Raise the consultation fee
// in November and the invoice printed in August must still say what it actually
// charged. Guarded; working down().

const TABLE = 'InvoiceLines';

const tableExists = async (queryInterface) => {
  const tables = await queryInterface.showAllTables();
  return tables
    .map((t) => (typeof t === 'string' ? t : t.tableName).toLowerCase())
    .includes(TABLE.toLowerCase());
};

const money = (Sequelize) => ({
  type: Sequelize.BIGINT, allowNull: false, defaultValue: 0,
});

module.exports = {
  async up(queryInterface, Sequelize) {
    if (await tableExists(queryInterface)) return;

    await queryInterface.createTable(TABLE, {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      // CASCADE: discarding a DRAFT takes its lines with it. An issued invoice
      // is never deleted, so in practice this only ever fires on a draft.
      invoiceId: {
        type: Sequelize.INTEGER, allowNull: false,
        references: { model: 'Invoices', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
      },
      // NULL for an ad-hoc line typed at the desk. SET NULL rather than RESTRICT
      // because the line already carries everything it needs to print — the link
      // is for reporting only.
      serviceItemId: {
        type: Sequelize.INTEGER, allowNull: true, defaultValue: null,
        references: { model: 'ServiceItems', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      // Ties a supply line to the batch actually dispensed, so the bill and the
      // stock ledger reconcile against each other.
      stockBatchId: {
        type: Sequelize.INTEGER, allowNull: true, defaultValue: null,
        references: { model: 'StockBatches', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },

      // What prints on the bill — copied from the ServiceItem at creation, so
      // renaming or retiring the service later leaves this line intact.
      description: { type: Sequelize.STRING, allowNull: false },
      quantity: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },

      // --- Snapshotted amounts (minor units) ---
      // NULL means the service had no price set when the line was added. A
      // draft is allowed to carry such a line so reception can SEE what is
      // missing and price it; issuing the invoice is refused while one remains.
      // The computed columns below stay 0 for it, so it contributes nothing to
      // a total that would otherwise silently understate the bill.
      unitPriceMinor: { type: Sequelize.BIGINT, allowNull: true, defaultValue: null },
      discountMinor: money(Sequelize),
      // Computed by lineAmounts() and STORED, so the printed invoice is a record
      // rather than a re-derivation that could round differently later.
      netMinor: money(Sequelize),
      vatMinor: money(Sequelize),
      grossMinor: money(Sequelize),

      // --- Snapshotted tax treatment ---
      vatClass: { type: Sequelize.STRING, allowNull: false, defaultValue: 'exempt' },
      // The rate actually applied, in basis points (16% = 1600). Stored rather
      // than re-derived, so changing the clinic's standard rate cannot alter
      // what an old invoice claims to have charged.
      vatRateBp: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      // 'A' exempt | 'B' standard | 'C' zero-rated — what eTIMS is told. Exempt
      // and zero-rated are not the same thing to KRA even though both charge 0.
      etimsTaxCode: { type: Sequelize.STRING, allowNull: true, defaultValue: null },

      // Explicit, rather than relying on id order, so reception can reorder a
      // draft before issuing it.
      sortOrder: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },

      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex(TABLE, ['invoiceId', 'sortOrder'], {
      name: 'idx_invoice_lines_invoice_sort',
    });
    // Revenue by service, for the reports.
    await queryInterface.addIndex(TABLE, ['serviceItemId'], {
      name: 'idx_invoice_lines_service',
    });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface)) {
      await queryInterface.dropTable(TABLE);
    }
  },
};
