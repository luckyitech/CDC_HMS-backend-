'use strict';

// Billing module — a patient's bill for one visit. Draft while reception builds
// it, frozen once issued; corrected by voiding and re-issuing, never by editing.
// The money columns are materialized from InvoiceLines and Payments and can be
// rebuilt from them. Guarded; working down().

const TABLE = 'Invoices';

const tableExists = async (queryInterface) => {
  const tables = await queryInterface.showAllTables();
  return tables
    .map((t) => (typeof t === 'string' ? t : t.tableName).toLowerCase())
    .includes(TABLE.toLowerCase());
};

// Every amount is a BIGINT of minor units (cents). Never DECIMAL: mysql2 hands
// DECIMAL back to Node as a string, and the one read that forgets to parse
// concatenates instead of adding. See utils/money.js.
const money = (Sequelize) => ({
  type: Sequelize.BIGINT, allowNull: false, defaultValue: 0,
});

module.exports = {
  async up(queryInterface, Sequelize) {
    if (await tableExists(queryInterface)) return;

    await queryInterface.createTable(TABLE, {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      // 'INV-2026-001', from utils/generateId's generateNumber.
      //
      // NULL until the invoice is ISSUED. A number is a commitment: once one is
      // handed to a patient the sequence has to account for it. Numbering
      // drafts instead would burn a number every time reception opened a
      // checkout and backed out, leaving gaps that look like deleted invoices
      // to anyone auditing the books.
      invoiceNumber: { type: Sequelize.STRING, allowNull: true, defaultValue: null, unique: true },

      // draft | issued | partially_paid | paid | void.
      // Derived by the ledger from the balance — never set by a caller.
      status: { type: Sequelize.STRING, allowNull: false, defaultValue: 'draft' },
      currency: { type: Sequelize.STRING, allowNull: false, defaultValue: 'KES' },

      // Whether this invoice's unit prices are VAT-inclusive. Snapshotted from
      // the clinic setting at draft time, because the answer changes what every
      // stored price MEANS — without it, flipping the setting would silently
      // reinterpret every historical invoice.
      pricesIncludeVat: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },

      // --- Amounts ---
      subtotalMinor: money(Sequelize),
      discountMinor: money(Sequelize),
      vatTotalMinor: money(Sequelize),
      totalMinor: money(Sequelize),
      amountPaidMinor: money(Sequelize),
      balanceMinor: money(Sequelize),

      // --- Who settles ---
      payerType: { type: Sequelize.STRING, allowNull: false, defaultValue: 'patient' },
      customerName: { type: Sequelize.STRING, allowNull: true, defaultValue: null },
      // The payer's KRA PIN — needed on a tax invoice when the buyer claims the
      // input tax, irrelevant for a walk-in paying cash.
      customerPin: { type: Sequelize.STRING, allowNull: true, defaultValue: null },

      // --- eTIMS (KRA fiscalisation): modelled now, submitted by nobody yet ---
      etimsStatus: { type: Sequelize.STRING, allowNull: false, defaultValue: 'not_submitted' },
      etimsInvoiceNo: { type: Sequelize.STRING, allowNull: true, defaultValue: null },
      etimsSignature: { type: Sequelize.STRING, allowNull: true, defaultValue: null },
      etimsQr: { type: Sequelize.TEXT, allowNull: true, defaultValue: null },
      etimsSubmittedAt: { type: Sequelize.DATE, allowNull: true, defaultValue: null },

      // --- Lifecycle ---
      issuedAt: { type: Sequelize.DATE, allowNull: true, defaultValue: null },
      voidedAt: { type: Sequelize.DATE, allowNull: true, defaultValue: null },
      voidReason: { type: Sequelize.TEXT, allowNull: true, defaultValue: null },
      notes: { type: Sequelize.TEXT, allowNull: true, defaultValue: null },

      // At most ONE live invoice per visit, enforced by the database.
      // Holds QueueId while the invoice is live and NULL once voided; MySQL
      // allows repeated NULLs in a unique index, so a corrected re-issue is
      // possible but two live bills for one visit are not. An application-level
      // check cannot hold: two receptionists discharging the same patient both
      // read their snapshot under REPEATABLE READ and both see no invoice.
      activeForQueueId: { type: Sequelize.INTEGER, allowNull: true, defaultValue: null, unique: true },

      // RESTRICT: a patient with invoices is never deleted. Patients are merged
      // (mergedIntoId) or deactivated, never destroyed.
      PatientId: {
        type: Sequelize.INTEGER, allowNull: false,
        references: { model: 'Patients', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT',
      },
      // Null for an invoice raised outside a visit (a standalone lab bill, a
      // correction re-issue).
      QueueId: {
        type: Sequelize.INTEGER, allowNull: true, defaultValue: null,
        references: { model: 'Queues', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      issuedById: {
        type: Sequelize.INTEGER, allowNull: true, defaultValue: null,
        references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      voidedById: {
        type: Sequelize.INTEGER, allowNull: true, defaultValue: null,
        references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex(TABLE, ['status', 'issuedAt'], {
      name: 'idx_invoices_status_issued',
    });
    await queryInterface.addIndex(TABLE, ['PatientId', 'createdAt'], {
      name: 'idx_invoices_patient_created',
    });
    await queryInterface.addIndex(TABLE, ['QueueId'], {
      name: 'idx_invoices_queue',
    });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface)) {
      await queryInterface.dropTable(TABLE);
    }
  },
};
