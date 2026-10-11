const { defineModel, DataTypes } = require('../utils/defineModel');

// Where a finding sits on the body map — one row per region (a rash may cover
// several). `region` is an id from utils/dermRegions; never renamed once shipped.
const DermFindingRegion = defineModel('DermFindingRegion', {
  region: { type: DataTypes.STRING(40), allowNull: false },
}, {
  timestamps: false,
  indexes: [{ name: 'uq_derm_finding_region', unique: true, fields: ['DermFindingId', 'region'] }],
});

module.exports = DermFindingRegion;
