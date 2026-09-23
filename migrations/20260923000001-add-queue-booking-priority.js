'use strict';

// Booking-priority queue: link a queue entry to the appointment it came from
// and record the slot's start instant, so the queue can order booked patients
// ahead of walk-ins and demote a booking that arrives late (utils/queuePriority).
//
//   appointmentId  — the non-cancelled same-day Appointment this visit is for
//                    (nullable; null = walk-in). SET NULL if the appointment row
//                    is ever removed — the queue entry must survive.
//   scheduledTime  — the slot's clinic-wall-clock start instant, denormalised so
//                    ordering never has to re-parse "9:00 AM" against a date.
//
// Both nullable, no backfill (existing rows are walk-ins). Guarded and reversible.

const TABLE = 'Queues';

const resolveTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.find((t) => String(t).toLowerCase() === name.toLowerCase());
};
const hasColumn = async (qi, table, col) => {
  const d = await qi.describeTable(table);
  return Object.keys(d).some((c) => c.toLowerCase() === col.toLowerCase());
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await resolveTable(queryInterface, TABLE);
    if (!table) return;
    if (!(await hasColumn(queryInterface, table, 'appointmentId'))) {
      await queryInterface.addColumn(table, 'appointmentId', {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: null,
        references: { model: 'Appointments', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      });
    }
    if (!(await hasColumn(queryInterface, table, 'scheduledTime'))) {
      await queryInterface.addColumn(table, 'scheduledTime', {
        type: Sequelize.DATE,
        allowNull: true,
        defaultValue: null,
      });
    }
  },

  async down(queryInterface) {
    const table = await resolveTable(queryInterface, TABLE);
    if (!table) return;
    for (const col of ['scheduledTime', 'appointmentId']) {
      if (await hasColumn(queryInterface, table, col)) {
        await queryInterface.removeColumn(table, col);
      }
    }
  },
};
