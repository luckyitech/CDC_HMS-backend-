const { defineModel, DataTypes } = require('../utils/defineModel');

// A fingerprint / card scanner whose punches reach the HMS through the relay
// on a clinic PC (HR Suite, 17 Oct 2026). The clinic's is a ZKTeco K40/ID.
//
// The relay authenticates with its own key: only the SHA-256 is stored
// (keyHash), the key is shown once when generated, and the relay must also
// send this scanner's serial. A replaced key stops the old one at once.
//
// goLiveAt: punches before it are kept but never counted (Emu: start fresh).
// lastSeenAt: the relay's last heartbeat — "Online" while it is recent.
//
// Association-injected: createdById (models/index.js).
const HrScanner = defineModel('HrScanner', {
  serial: {
    type: DataTypes.STRING(32),
    allowNull: false,
    unique: true,
  },
  label: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  location: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  keyHash: {
    type: DataTypes.STRING(64),
    allowNull: false,
  },
  keySetAt: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
  },
  status: {
    type: DataTypes.ENUM('active', 'stopped'),
    allowNull: false,
    defaultValue: 'active',
  },
  goLiveAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  lastSeenAt:   { type: DataTypes.DATE, allowNull: true, defaultValue: null },
  lastPunchAt:  { type: DataTypes.DATE, allowNull: true, defaultValue: null },
  recordCount:  { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },
  userCount:    { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },
  relayVersion: { type: DataTypes.STRING(32), allowNull: true, defaultValue: null },
  relayHost:    { type: DataTypes.STRING(64), allowNull: true, defaultValue: null },
  // Scanner clock minus server clock, seconds, from the last heartbeat (+ = fast).
  clockDriftSeconds: { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },
});

module.exports = HrScanner;
