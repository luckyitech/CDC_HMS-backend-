const { defineModel, DataTypes } = require('../utils/defineModel');

// The approximate place of an outside IP address, as answered once by the
// lookup service (services/ipLookup.js) and kept, so no address is sent out
// twice. Sign-in tracking (16 Oct 2026). Migration 20260928000038.
const IpLocation = defineModel('IpLocation', {
  ip:          { type: DataTypes.STRING(45), allowNull: false, unique: true },
  countryCode: { type: DataTypes.STRING(2), allowNull: true },
  country:     { type: DataTypes.STRING(80), allowNull: true },
  region:      { type: DataTypes.STRING(100), allowNull: true },
  city:        { type: DataTypes.STRING(100), allowNull: true },
  isp:         { type: DataTypes.STRING(150), allowNull: true },
  provider:    { type: DataTypes.STRING(16), allowNull: true },
  status:      { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'ok' },  // 'ok' | 'failed'
  lookedUpAt:  { type: DataTypes.DATE, allowNull: false },
});

module.exports = IpLocation;
