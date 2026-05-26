'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableInfo = await queryInterface.describeTable('Patients');
    if (!tableInfo.registrationComplete) {
      await queryInterface.addColumn('Patients', 'registrationComplete', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
    }
    // Backfill 1: patients who completed registration with a portal account.
    // Backfill 2: patients whose full profile was completed without email (bug-affected records).
    //   Quick registration only ever sets firstName, lastName, phone — so any patient with
    //   UserId=null that also has other profile fields must have gone through completeRegistration.
    await queryInterface.sequelize.query(`
      UPDATE Patients
      SET registrationComplete = TRUE
      WHERE UserId IS NOT NULL
         OR dateOfBirth     IS NOT NULL
         OR gender          IS NOT NULL
         OR diagnosis       IS NOT NULL
         OR idNumber        IS NOT NULL
         OR address         IS NOT NULL
         OR primaryDoctorId IS NOT NULL
         OR emergencyContact IS NOT NULL
         OR insurance       IS NOT NULL
    `);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Patients', 'registrationComplete');
  },
};
