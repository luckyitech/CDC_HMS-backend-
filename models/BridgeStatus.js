const { defineModel, DataTypes } = require('../utils/defineModel');

// Bridge status — one row per DICOM bridge (keyed by bridgeId; a single clinic
// bridge uses 'default'). The bridge on the clinic Mac has no inbound route
// (portable, behind NAT, changing IP), so control is INVERTED: the bridge polls
// this server on its own outbound channel (a heartbeat), and the heartbeat
// RESPONSE carries any pending restart command. This table is what the heartbeat
// writes and what the Radiology Suite status chip + Restart button read/write.
//
// Real columns (no JSON) so status is SQL-queryable/reportable. The
// restartRequestedById FK is added by the association in models/index.js.
const BridgeStatus = defineModel('BridgeStatus', {
  bridgeId:            { type: DataTypes.STRING, allowNull: false, unique: true, defaultValue: 'default' },
  aeTitle:             { type: DataTypes.STRING, defaultValue: null },
  host:                { type: DataTypes.STRING, defaultValue: null },
  localIp:             { type: DataTypes.STRING, defaultValue: null },
  version:             { type: DataTypes.STRING, defaultValue: null },
  listenerOk:          { type: DataTypes.BOOLEAN, defaultValue: null },
  queueDepth:          { type: DataTypes.INTEGER, defaultValue: null },
  lastImageReceivedAt: { type: DataTypes.DATE, defaultValue: null },
  lastHeartbeatAt:     { type: DataTypes.DATE, defaultValue: null },
  restartRequestedAt:  { type: DataTypes.DATE, defaultValue: null },
  restartAckedAt:      { type: DataTypes.DATE, defaultValue: null },
  // restartRequestedById — added by BridgeStatus.belongsTo(User, { as: 'restartRequestedBy' })
});

module.exports = BridgeStatus;
