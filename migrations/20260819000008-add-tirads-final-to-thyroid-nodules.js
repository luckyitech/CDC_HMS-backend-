'use strict';

/**
 * Adds tiradsFinal to ThyroidNodules — the reporter's confirmed/overridden ACR
 * TI-RADS category. The engine still computes the level from the descriptors
 * (tiradsCategory / tiradsPoints); tiradsFinal is what the reporter signs off.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const desc = await queryInterface.describeTable('ThyroidNodules').catch(() => ({}));
    if (desc.tiradsFinal) return;
    await queryInterface.addColumn('ThyroidNodules', 'tiradsFinal', {
      type: Sequelize.ENUM('TR1', 'TR2', 'TR3', 'TR4', 'TR5'), allowNull: true, defaultValue: null,
    });
  },
  async down(queryInterface) {
    const desc = await queryInterface.describeTable('ThyroidNodules').catch(() => ({}));
    if (desc.tiradsFinal) await queryInterface.removeColumn('ThyroidNodules', 'tiradsFinal');
  },
};
