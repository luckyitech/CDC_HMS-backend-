'use strict';

// BridgeStatus — one row per DICOM bridge (keyed by bridgeId). Guarded and
// reversible. Backs the Radiology Suite bridge status chip + Restart button and
// the bridge's outbound heartbeat/command channel. Real columns (no JSON) so
// status is SQL-queryable.

const TABLE = 'BridgeStatuses';

const tableExists = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables
    .map((t) => (typeof t === 'string' ? t : t.tableName).toLowerCase())
    .includes(name.toLowerCase());
};

module.exports = {
  async up(queryInterface, Sequelize) {
    if (await tableExists(queryInterface, TABLE)) return;

    await queryInterface.createTable(TABLE, {
      id:                   { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      bridgeId:             { type: Sequelize.STRING, allowNull: false, defaultValue: 'default' },
      aeTitle:              { type: Sequelize.STRING, allowNull: true },
      host:                 { type: Sequelize.STRING, allowNull: true },
      localIp:              { type: Sequelize.STRING, allowNull: true },
      version:              { type: Sequelize.STRING, allowNull: true },
      listenerOk:           { type: Sequelize.BOOLEAN, allowNull: true },
      queueDepth:           { type: Sequelize.INTEGER, allowNull: true },
      lastImageReceivedAt:  { type: Sequelize.DATE, allowNull: true },
      lastHeartbeatAt:      { type: Sequelize.DATE, allowNull: true },
      restartRequestedAt:   { type: Sequelize.DATE, allowNull: true },
      restartAckedAt:       { type: Sequelize.DATE, allowNull: true },
      restartRequestedById: { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      createdAt:            { type: Sequelize.DATE, allowNull: false },
      updatedAt:            { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex(TABLE, ['bridgeId'], { unique: true, name: 'bridge_statuses_bridge_id' });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface, TABLE)) {
      await queryInterface.dropTable(TABLE);
    }
  },
};
