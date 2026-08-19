'use strict';

/**
 * Adds imageLayout to ThyroidUltrasounds — the montage grid the reporter chose
 * in the imaging workspace (l32 / l23 / p23 / p32). Drives the image-holder
 * layout at the end of the combined radiology PDF.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const desc = await queryInterface.describeTable('ThyroidUltrasounds').catch(() => ({}));
    if (desc.imageLayout) return;
    await queryInterface.addColumn('ThyroidUltrasounds', 'imageLayout', {
      type: Sequelize.STRING(8), allowNull: false, defaultValue: 'l32',
    });
  },
  async down(queryInterface) {
    const desc = await queryInterface.describeTable('ThyroidUltrasounds').catch(() => ({}));
    if (desc.imageLayout) await queryInterface.removeColumn('ThyroidUltrasounds', 'imageLayout');
  },
};
