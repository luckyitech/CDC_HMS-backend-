const { defineModel, DataTypes } = require('../utils/defineModel');

// Links a machine-ingested UltrasoundImage to a thyroid report for the combined
// radiology PDF. FKs (ThyroidUltrasoundId, ThyroidNoduleId, UltrasoundImageId)
// come from models/index.js.
const ThyroidUltrasoundImage = defineModel('ThyroidUltrasoundImage', {
  imageType:  { type: DataTypes.ENUM('longitudinal', 'transverse', 'doppler', 'capsule_halo', 'calcification', 'lymph_node', 'other'), defaultValue: null },
  caption:    { type: DataTypes.STRING, defaultValue: null },
  orderIndex: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  brightness: { type: DataTypes.DECIMAL(4, 2), allowNull: false, defaultValue: 1 },
  scale:      { type: DataTypes.DECIMAL(4, 2), allowNull: false, defaultValue: 1 },
  offsetX:    { type: DataTypes.DECIMAL(5, 3), allowNull: false, defaultValue: 0 },
  offsetY:    { type: DataTypes.DECIMAL(5, 3), allowNull: false, defaultValue: 0 },
});

module.exports = ThyroidUltrasoundImage;
