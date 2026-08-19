'use strict';

/**
 * Migration: Add referral tracking fields to the Queues table.
 *
 * These six columns give a full, permanent audit trail for every referral:
 *   - who referred, to whom, why, when, and whether it was internal or external.
 *
 * All columns are nullable so that non-referred queue entries are unaffected.
 *
 * Guarded per column with describeTable, like every other migration in this
 * tree. It was not, and that made it a wall: on any database where the columns
 * already exist — which is every one built by sequelize.sync(), and sync() is
 * what server.js runs on boot — it threw "Duplicate column name 'referralType'"
 * and sequelize-cli stopped. Migrations are applied in order, so nothing after
 * this one ever ran. Nine thyroid-ultrasound migrations, including the TI-RADS
 * catalog seed, were sitting behind it.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('Queues');
    const add = async (name, spec) => {
      if (table[name]) return;
      await queryInterface.addColumn('Queues', name, spec);
    };

    await add('referralType', {
      type: Sequelize.ENUM('Internal', 'External'),
      allowNull: true,
      defaultValue: null,
      after: 'removalReason',
    });

    await add('referralReason', {
      type: Sequelize.TEXT,
      allowNull: true,
      defaultValue: null,
      after: 'referralType',
    });

    await add('referredByDoctorName', {
      type: Sequelize.STRING,
      allowNull: true,
      defaultValue: null,
      after: 'referralReason',
      comment: 'Name of the doctor who made the referral — stored as string for permanent audit trail',
    });

    await add('referredAt', {
      type: Sequelize.DATE,
      allowNull: true,
      defaultValue: null,
      after: 'referredByDoctorName',
      comment: 'Exact timestamp when the referral was made — separate from updatedAt which changes on every queue update',
    });

    await add('referredToDoctorName', {
      type: Sequelize.STRING,
      allowNull: true,
      defaultValue: null,
      after: 'referredAt',
      comment: 'Internal referrals only — name of the receiving doctor, stored as string so the record persists even if assignedDoctorId changes again later',
    });

    await add('externalReferralTarget', {
      type: Sequelize.STRING,
      allowNull: true,
      defaultValue: null,
      after: 'referredToDoctorName',
      comment: 'External referrals only — name of the hospital, clinic, or specialist the patient is being sent to',
    });
  },

  async down(queryInterface) {
    // Remove in reverse order to avoid dependency issues, and only what is
    // actually there — the same reason up() is guarded.
    const table = await queryInterface.describeTable('Queues');
    for (const name of [
      'externalReferralTarget', 'referredToDoctorName', 'referredAt',
      'referredByDoctorName', 'referralReason', 'referralType',
    ]) {
      if (table[name]) await queryInterface.removeColumn('Queues', name);
    }
  },
};
