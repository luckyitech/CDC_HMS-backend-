'use strict';

// Billing carried through every stage (12 Oct 2026, Emu): QueueCharges — one
// row per line on a visit's bill with who added it, their role, the stage and
// whether it came from a triage result; soft removal (who, when, why).
// Queue.selectedCharges / selectedProcedures are unchanged and stay the bill.
//
// `down`: REFUSES once any row exists (billing audit trail — restore the backup).

const TAG = '[20260928000031]';

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;
    const queues = await findTable(qi, 'Queues');
    if (!queues) throw new Error(`${TAG} Queues missing`);
    const users = await findTable(qi, 'Users') || 'Users';
    if (await findTable(qi, 'QueueCharges')) return;
    await qi.createTable('QueueCharges', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      QueueId: {
        type: Sequelize.INTEGER, allowNull: false,
        references: { model: queues, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
      },
      kind: { type: Sequelize.STRING(20), allowNull: false },
      name: { type: Sequelize.STRING(120), allowNull: false },
      stage: { type: Sequelize.STRING(20), allowNull: false },
      source: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'picked' },
      addedById: {
        type: Sequelize.INTEGER, allowNull: true,
        references: { model: users, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      addedByName: { type: Sequelize.STRING(120), allowNull: true },
      addedByRole: { type: Sequelize.STRING(20), allowNull: true },
      status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'active' },
      removedById: {
        type: Sequelize.INTEGER, allowNull: true,
        references: { model: users, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      removedByName: { type: Sequelize.STRING(120), allowNull: true },
      removedAt: { type: Sequelize.DATE, allowNull: true },
      removedReason: { type: Sequelize.STRING(255), allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await qi.addIndex('QueueCharges', ['QueueId', 'status'], { name: 'idx_queue_charges_visit' });
    console.log(`${TAG} QueueCharges created`);
  },

  async down(queryInterface) {
    const qi = queryInterface;
    const t = await findTable(qi, 'QueueCharges');
    if (!t) return;
    const [rows] = await qi.sequelize.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
    const n = Number(rows[0].n ?? rows[0].N ?? 0);
    if (n > 0) throw new Error(`${TAG} down refused: ${n} bill line(s) recorded. Restore the database backup instead.`);
    await qi.dropTable(t);
    console.log(`${TAG} reverted (nothing used it)`);
  },
};
