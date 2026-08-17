'use strict';

// Nursing notes — DAR-format Kardex (Data, Action, Response), one row per entry,
// additive, soft-deleted via status. Guarded so a re-run is a no-op.

const TABLE = 'NursingNotes';

const tableExists = async (qi) => {
  const tables = await qi.showAllTables();
  return tables
    .map((t) => (typeof t === 'string' ? t : t.tableName).toLowerCase())
    .includes(TABLE.toLowerCase());
};

module.exports = {
  async up(queryInterface, Sequelize) {
    if (await tableExists(queryInterface)) return;
    await queryInterface.createTable(TABLE, {
      id:         { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      PatientId:  { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Patients', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      authorId:   { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      authorRole: { type: Sequelize.STRING, allowNull: true },
      date:       { type: Sequelize.DATEONLY, allowNull: true },
      time:       { type: Sequelize.STRING, allowNull: true },
      data:       { type: Sequelize.TEXT, allowNull: true },
      action:     { type: Sequelize.TEXT, allowNull: true },
      response:   { type: Sequelize.TEXT, allowNull: true },
      status:     { type: Sequelize.ENUM('active', 'deleted'), allowNull: false, defaultValue: 'active' },
      createdAt:  { type: Sequelize.DATE, allowNull: false },
      updatedAt:  { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface)) await queryInterface.dropTable(TABLE);
  },
};
