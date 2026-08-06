'use strict';

// Billing module — the money ledger. Append-only, exactly like StockMovement:
// rows are never updated or deleted, and a mistake is corrected by writing a
// 'reversal' row that points at the original.
//
// Nothing here processes a payment. The card was authorised by the bank's POS
// terminal and the M-Pesa confirmed by Safaricom, both outside this system.
// These rows record money that has already moved, with the reference that
// reconciles it against a statement later. Guarded; working down().

const TABLE = 'Payments';

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
      // 'RCT-2026-001'. Reversals and refunds get their own number so they can
      // be printed and handed over as a credit note.
      receiptNumber: { type: Sequelize.STRING, allowNull: false, unique: true },

      // RESTRICT: an invoice that has been paid against can never be deleted.
      invoiceId: {
        type: Sequelize.INTEGER, allowNull: false,
        references: { model: 'Invoices', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT',
      },

      // 'payment' | 'refund' | 'reversal' — carries the DIRECTION of the money.
      type: { type: Sequelize.STRING, allowNull: false, defaultValue: 'payment' },
      // 'cash' | 'mpesa' | 'card' | 'insurance' | 'bank'. STRING so a new method
      // is a row in constants/billing.js, not a migration.
      method: { type: Sequelize.STRING, allowNull: false },

      // ALWAYS POSITIVE — direction comes from `type`, never the sign, the same
      // rule as StockMovement.quantity. A signed column invites a negative
      // payment that no validator rejects and every SUM silently believes.
      amountMinor: { type: Sequelize.BIGINT, allowNull: false },

      // The proof that reconciles this against an external statement: M-Pesa
      // code, terminal auth code, bank reference, claim number.
      reference: { type: Sequelize.STRING, allowNull: true, defaultValue: null },

      // The guarded form, 'method:REFERENCE', written ONLY for methods whose
      // reference is genuinely unique (M-Pesa, bank) so the same transaction can
      // never be banked twice — a real risk when a receptionist retries a
      // submission that already succeeded.
      //
      // Card auth codes are deliberately excluded: they are ~6 digits, repeat
      // across terminals and days, and guarding them would reject honest
      // payments. Insurance member numbers repeat on every visit by design,
      // which is why they live in their own column below and never in
      // `reference`. NULL for unguarded methods; MySQL lets NULLs repeat.
      uniqueReference: { type: Sequelize.STRING, allowNull: true, defaultValue: null, unique: true },

      // Last four digits ONLY, never the full number, expiry or CVV — storing
      // any of those drags the clinic into PCI DSS scope for no benefit, since
      // the terminal already handled the card.
      cardLast4: { type: Sequelize.STRING(4), allowNull: true, defaultValue: null },
      insuranceScheme: { type: Sequelize.STRING, allowNull: true, defaultValue: null },
      insuranceMemberNo: { type: Sequelize.STRING, allowNull: true, defaultValue: null },

      receivedAt: { type: Sequelize.DATE, allowNull: false },
      receivedById: {
        type: Sequelize.INTEGER, allowNull: true, defaultValue: null,
        references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      // Required for refunds and reversals — money handed back or unwound always
      // has to say why.
      reason: { type: Sequelize.TEXT, allowNull: true, defaultValue: null },

      // --- The gateway seam: unused today ---
      // Every payment is 'manual', keyed by a person reading a confirmation SMS
      // or a terminal slip. If Daraja STK push is added later the callback fills
      // these and sets source='gateway' — same row, same ledger, same reports.
      source: { type: Sequelize.STRING, allowNull: false, defaultValue: 'manual' },
      gatewayRef: { type: Sequelize.STRING, allowNull: true, defaultValue: null },
      gatewayStatus: { type: Sequelize.STRING, allowNull: true, defaultValue: null },
      confirmedAt: { type: Sequelize.DATE, allowNull: true, defaultValue: null },

      // Self-referential: a reversal points at the payment it undid. The FK is
      // added separately below — the table does not exist yet at createTable
      // time, so it cannot reference itself inline.
      reversesPaymentId: { type: Sequelize.INTEGER, allowNull: true, defaultValue: null },

      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addConstraint(TABLE, {
      fields: ['reversesPaymentId'],
      type: 'foreign key',
      name: 'fk_payments_reverses_payment',
      references: { table: TABLE, field: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'RESTRICT',
    });

    await queryInterface.addIndex(TABLE, ['invoiceId'], {
      name: 'idx_payments_invoice',
    });
    // The cash-up report: everything taken on a given day, by method.
    await queryInterface.addIndex(TABLE, ['receivedAt', 'method'], {
      name: 'idx_payments_received_method',
    });

    // A payment may be reversed at most ONCE. Enforced by the database, not by
    // a read-then-write check in reversePayment: two concurrent reversals both
    // read their snapshot under REPEATABLE READ, both see no reversal, and both
    // proceed — crediting the patient twice for one payment. Ordinary payments
    // hold NULL here and are unaffected. Same reasoning as
    // unique_reversal_per_movement on StockMovements.
    await queryInterface.addIndex(TABLE, ['reversesPaymentId'], {
      unique: true,
      name: 'unique_reversal_per_payment',
    });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface)) {
      // The self-referencing FK has to go before the table can be dropped.
      await queryInterface.removeConstraint(TABLE, 'fk_payments_reverses_payment').catch(() => {});
      await queryInterface.dropTable(TABLE);
    }
  },
};
