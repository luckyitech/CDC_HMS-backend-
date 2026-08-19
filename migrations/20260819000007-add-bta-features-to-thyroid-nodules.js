'use strict';

/**
 * Adds btaFeatures (JSON) to ThyroidNodules — the individual BTA U descriptor
 * points the reporter ticked, stored as [{ code, text }] so they can drive the
 * suggested category and be listed in the report.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const desc = await queryInterface.describeTable('ThyroidNodules').catch(() => ({}));
    if (desc.btaFeatures) return;
    await queryInterface.addColumn('ThyroidNodules', 'btaFeatures', {
      type: Sequelize.JSON, allowNull: true, defaultValue: null,
    });
  },
  async down(queryInterface) {
    const desc = await queryInterface.describeTable('ThyroidNodules').catch(() => ({}));
    if (desc.btaFeatures) await queryInterface.removeColumn('ThyroidNodules', 'btaFeatures');
  },
};
