'use strict';

module.exports = {
  async up(queryInterface) {
    // Guarded so this migration is safe to re-run, and safe on a database
    // built by sequelize.sync() — which is what server.js does on boot, so it
    // is the normal state of every dev machine here. Without this the migration
    // throws on an existing column and sequelize-cli stops, taking every later
    // migration with it.
    const addIndexIfMissing = async (...args) => {
      try {
        await queryInterface.addIndex(...args);
      } catch (err) {
        // Duplicate index names / duplicate key names are the re-run case.
        if (!/duplicate|exists/i.test(err.message || '')) throw err;
      }
    };

    // Remove duplicate appointments before adding the unique index.
    // Keeps the earliest record (lowest id) for each (doctorId, date, timeSlot) group.
    // This only affects test/dev data — in production there should be no duplicates.
    await queryInterface.sequelize.query(`
      DELETE a1 FROM Appointments a1
      INNER JOIN Appointments a2
        ON a1.doctorId  = a2.doctorId
       AND a1.date      = a2.date
       AND a1.timeSlot  = a2.timeSlot
       AND a1.id        > a2.id
    `);

    // Guard: skip if the index already exists
    try {
      await addIndexIfMissing('Appointments', ['doctorId', 'date', 'timeSlot'], {
        unique: true,
        name: 'unique_doctor_date_timeslot',
      });
    } catch (err) {
      if (err.message && err.message.includes('Duplicate key name')) {
        console.log('Index unique_doctor_date_timeslot already exists — skipping.');
      } else {
        throw err;
      }
    }
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('Appointments', 'unique_doctor_date_timeslot');
  },
};
