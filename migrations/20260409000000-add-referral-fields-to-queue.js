'use strict';

/**
 * Migration: Add referral tracking fields to the Queues table.
 *
 * These six columns give a full, permanent audit trail for every referral:
 *   - who referred, to whom, why, when, and whether it was internal or external.
 *
 * All columns are nullable so that non-referred queue entries are unaffected.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Queues', 'referralType', {
      type: Sequelize.ENUM('Internal', 'External'),
      allowNull: true,
      defaultValue: null,
      after: 'removalReason',
    });

    await queryInterface.addColumn('Queues', 'referralReason', {
      type: Sequelize.TEXT,
      allowNull: true,
      defaultValue: null,
      after: 'referralType',
    });

    await queryInterface.addColumn('Queues', 'referredByDoctorName', {
      type: Sequelize.STRING,
      allowNull: true,
      defaultValue: null,
      after: 'referralReason',
      comment: 'Name of the doctor who made the referral — stored as string for permanent audit trail',
    });

    await queryInterface.addColumn('Queues', 'referredAt', {
      type: Sequelize.DATE,
      allowNull: true,
      defaultValue: null,
      after: 'referredByDoctorName',
      comment: 'Exact timestamp when the referral was made — separate from updatedAt which changes on every queue update',
    });

    await queryInterface.addColumn('Queues', 'referredToDoctorName', {
      type: Sequelize.STRING,
      allowNull: true,
      defaultValue: null,
      after: 'referredAt',
      comment: 'Internal referrals only — name of the receiving doctor, stored as string so the record persists even if assignedDoctorId changes again later',
    });

    await queryInterface.addColumn('Queues', 'externalReferralTarget', {
      type: Sequelize.STRING,
      allowNull: true,
      defaultValue: null,
      after: 'referredToDoctorName',
      comment: 'External referrals only — name of the hospital, clinic, or specialist the patient is being sent to',
    });
  },

  async down(queryInterface) {
    // Remove in reverse order to avoid dependency issues
    await queryInterface.removeColumn('Queues', 'externalReferralTarget');
    await queryInterface.removeColumn('Queues', 'referredToDoctorName');
    await queryInterface.removeColumn('Queues', 'referredAt');
    await queryInterface.removeColumn('Queues', 'referredByDoctorName');
    await queryInterface.removeColumn('Queues', 'referralReason');
    await queryInterface.removeColumn('Queues', 'referralType');
  },
};
