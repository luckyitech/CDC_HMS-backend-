'use strict';

// MySQL uses the unique index as the backing index for the doctorId FK.
// We must create a regular index on the same columns first, then drop the unique one.
module.exports = {
  async up(queryInterface) {
    // 1. Add a non-unique index (MySQL needs it to back the FK on doctorId)
    try {
      await queryInterface.addIndex('Appointments', {
        fields: ['doctorId', 'date', 'timeSlot'],
        name: 'idx_appointments_doctor_date_timeslot',
      });
    } catch {
      // index may already exist
    }

    // 2. Drop the old unique constraint
    try {
      await queryInterface.sequelize.query(
        'ALTER TABLE Appointments DROP INDEX unique_doctor_date_timeslot'
      );
    } catch {
      // index may have already been removed
    }
  },

  async down(queryInterface) {
    try {
      await queryInterface.addIndex('Appointments', {
        fields: ['doctorId', 'date', 'timeSlot'],
        unique: true,
        name: 'unique_doctor_date_timeslot',
      });
    } catch {
      // already exists
    }
    try {
      await queryInterface.removeIndex('Appointments', 'idx_appointments_doctor_date_timeslot');
    } catch {
      // already gone
    }
  },
};
