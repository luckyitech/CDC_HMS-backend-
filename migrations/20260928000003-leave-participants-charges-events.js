'use strict';

// B27 phase 0 (3 of 6) — who is asked, what it is charged to, what happened.
// Spec §3.2, decisions D5–D7.
//
//   LeaveParticipants  the people the applicant chose: approvers (ALL must
//                      approve) and acknowledgers (told only), with each
//                      person's decision and note.
//   LeaveCharges       which balance(s) the days come off — e.g. 2 Sick + 3
//                      Annual. Sum of active charges = StaffLeave.days.
//                      Balances are summed from these from now on, not from
//                      StaffLeave.leaveType. A changed split marks the old rows
//                      'replaced' — never deleted.
//   LeaveEvents        the request's timeline and message thread. Never deleted.
//
// Backfill: one active charge per existing leave (its own type and days) and
// one 'recorded' event per existing leave, so every balance and every history
// reads the same the moment this lands.
//
// Guarded both ways; `down` drops the three tables (backfilled rows go with
// them — the StaffLeave rows themselves are untouched either way).

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};

const leaveRef = (Sequelize) => ({
  type: Sequelize.INTEGER, allowNull: false,
  references: { model: 'StaffLeaves', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
});
const userRef = (Sequelize, allowNull = true) => ({
  type: Sequelize.INTEGER, allowNull,
  references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: allowNull ? 'SET NULL' : 'CASCADE',
});

const EVENT_TYPES = ['submitted', 'approved', 'declined', 'info_requested', 'info_replied', 'charge_changed',
  'withdrawn', 'cancel_requested', 'cancelled', 'recorded', 'notified'];

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await findTable(queryInterface, 'LeaveParticipants'))) {
      await queryInterface.createTable('LeaveParticipants', {
        id:        { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        leaveId:   leaveRef(Sequelize),
        UserId:    userRef(Sequelize, false),
        kind:      { type: Sequelize.ENUM('approver', 'acknowledger'), allowNull: false },
        decision:  { type: Sequelize.ENUM('pending', 'approved', 'declined', 'info_requested', 'notified'), allowNull: false, defaultValue: 'pending' },
        decidedAt: { type: Sequelize.DATE, allowNull: true },
        note:      { type: Sequelize.TEXT, allowNull: true },
        sortOrder: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex('LeaveParticipants', ['leaveId', 'UserId'], { name: 'leave_participants_unique', unique: true });
      await queryInterface.addIndex('LeaveParticipants', ['UserId', 'decision'], { name: 'leave_participants_user_decision' });
    }

    if (!(await findTable(queryInterface, 'LeaveCharges'))) {
      await queryInterface.createTable('LeaveCharges', {
        id:        { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        leaveId:   leaveRef(Sequelize),
        leaveType: { type: Sequelize.STRING(40), allowNull: false },
        days:      { type: Sequelize.DECIMAL(6, 2), allowNull: false },
        setById:   userRef(Sequelize),
        status:    { type: Sequelize.ENUM('active', 'replaced'), allowNull: false, defaultValue: 'active' },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex('LeaveCharges', ['leaveId', 'status'], { name: 'leave_charges_leave_status' });
    }

    if (!(await findTable(queryInterface, 'LeaveEvents'))) {
      await queryInterface.createTable('LeaveEvents', {
        id:        { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        leaveId:   leaveRef(Sequelize),
        actorId:   userRef(Sequelize),
        type:      { type: Sequelize.ENUM(...EVENT_TYPES), allowNull: false },
        note:      { type: Sequelize.TEXT, allowNull: true },
        data:      { type: Sequelize.JSON, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex('LeaveEvents', ['leaveId', 'createdAt'], { name: 'leave_events_leave_time' });
    }

    // ---- Backfill: one charge + one 'recorded' event per existing leave ----
    const leaves = await findTable(queryInterface, 'StaffLeaves');
    if (!leaves) return;
    const charges = await findTable(queryInterface, 'LeaveCharges');
    const events = await findTable(queryInterface, 'LeaveEvents');
    const users = await findTable(queryInterface, 'Users');

    // INSERT … SELECT keeps it one statement however many rows there are, and
    // the NOT EXISTS makes a re-run a no-op. createdBy has no foreign key of
    // its own, so the user id is looked up rather than copied — a stale id
    // would fail the new FK and abort the whole deploy.
    await queryInterface.sequelize.query(`
      INSERT INTO ${charges} (leaveId, leaveType, days, setById, status, createdAt, updatedAt)
      SELECT l.id, l.leaveType, l.days,
             (SELECT u.id FROM ${users} u WHERE u.id = COALESCE(l.approvedById, l.createdBy)),
             'active', l.createdAt, NOW()
      FROM ${leaves} l
      WHERE NOT EXISTS (SELECT 1 FROM ${charges} c WHERE c.leaveId = l.id)
    `);
    await queryInterface.sequelize.query(`
      INSERT INTO ${events} (leaveId, actorId, type, note, data, createdAt, updatedAt)
      SELECT l.id, (SELECT u.id FROM ${users} u WHERE u.id = l.createdBy), 'recorded', NULL, JSON_OBJECT('status', l.status, 'migrated', true), l.createdAt, NOW()
      FROM ${leaves} l
      WHERE NOT EXISTS (SELECT 1 FROM ${events} e WHERE e.leaveId = l.id)
    `);
  },

  async down(queryInterface) {
    for (const name of ['LeaveEvents', 'LeaveCharges', 'LeaveParticipants']) {
      const t = await findTable(queryInterface, name);
      if (t) await queryInterface.dropTable(t);
    }
  },
};
