const { defineModel, DataTypes } = require('../utils/defineModel');

// The areas a skin photo shows (migration 20260928000026) — one row per region,
// each one of its finding's regions. No row = an overview of the whole finding.
const DermPhotoRegion = defineModel('DermPhotoRegion', {
  region: { type: DataTypes.STRING(40), allowNull: false },
}, {
  timestamps: false,
  indexes: [{ name: 'uq_derm_photo_region', unique: true, fields: ['DermPhotoId', 'region'] }],
});

module.exports = DermPhotoRegion;
