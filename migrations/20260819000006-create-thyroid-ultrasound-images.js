'use strict';

/**
 * ThyroidUltrasoundImages — links machine-ingested UltrasoundImage rows (the
 * HS70A DICOM feed) to a thyroid report for the combined radiology PDF.
 *
 * Report-level selection for v1 (ThyroidNoduleId reserved, nullable, for later
 * per-nodule tagging). Montage params are carried per image so the combined PDF
 * (structured findings + image montage) is reproducible and freezes at signing.
 * The generated combined PDF itself is filed as a MedicalDocument and referenced
 * from ThyroidUltrasounds.reportSnapshot — this table holds the SOURCE images.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables().then((t) => t.map((x) => x.toLowerCase()));
    if (tables.includes('thyroidultrasoundimages')) return;
    // Guard: the DICOM UltrasoundImages table must exist (it does on HMS-improvements).
    if (!tables.includes('ultrasoundimages')) {
      throw new Error('UltrasoundImages table not found — the DICOM ultrasound module must be migrated before the thyroid image link table.');
    }

    const S = Sequelize;
    await queryInterface.createTable('ThyroidUltrasoundImages', {
      id:                 { type: S.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      ThyroidUltrasoundId:{ type: S.INTEGER, allowNull: false, references: { model: 'ThyroidUltrasounds', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      ThyroidNoduleId:    { type: S.INTEGER, allowNull: true, references: { model: 'ThyroidNodules', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      UltrasoundImageId:  { type: S.INTEGER, allowNull: false, references: { model: 'UltrasoundImages', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },

      imageType: { type: S.ENUM('longitudinal', 'transverse', 'doppler', 'capsule_halo', 'calcification', 'lymph_node', 'other'), defaultValue: null },
      caption:   { type: S.STRING, defaultValue: null },
      orderIndex:{ type: S.INTEGER, allowNull: false, defaultValue: 0 },

      // montage params (mirror the radiology workspace transform)
      brightness:{ type: S.DECIMAL(4, 2), allowNull: false, defaultValue: 1 },
      scale:     { type: S.DECIMAL(4, 2), allowNull: false, defaultValue: 1 },
      offsetX:   { type: S.DECIMAL(5, 3), allowNull: false, defaultValue: 0 },
      offsetY:   { type: S.DECIMAL(5, 3), allowNull: false, defaultValue: 0 },

      createdAt: { type: S.DATE, allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP') },
      updatedAt: { type: S.DATE, allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP') },
    });

    await queryInterface.addIndex('ThyroidUltrasoundImages', ['ThyroidUltrasoundId', 'orderIndex'], { name: 'idx_thyroid_us_image_report_order' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('ThyroidUltrasoundImages');
  },
};
