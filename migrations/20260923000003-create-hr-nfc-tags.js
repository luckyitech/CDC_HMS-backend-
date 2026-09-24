'use strict';

// HR Suite (B21) — entrance tags. One row per NTAG 424 DNA tag registered with
// the clinic; the tag's file-read key is stored encrypted (utils/crypto.js).
// First of the five HR migrations (…000003 – …000007); the FK from
// StaffAttendances to this table is added in …000005, once both exist.
// Guarded, reversible. Dated after everything deployed (tip: 20260923000002).

const TABLE = 'HrNfcTags';

const resolveTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.find((t) => String(t).toLowerCase() === name.toLowerCase());
};
const hasIndex = async (qi, table, name) => {
  const idx = await qi.showIndex(table);
  return idx.some((i) => String(i.name).toLowerCase() === name.toLowerCase());
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const users = (await resolveTable(queryInterface, 'Users')) || 'Users';
    let table = await resolveTable(queryInterface, TABLE);
    if (!table) {
      await queryInterface.createTable(TABLE, {
        id:           { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        uid:          { type: Sequelize.STRING(14), allowNull: false },
        label:        { type: Sequelize.STRING, allowNull: false },
        location:     { type: Sequelize.STRING, allowNull: true, defaultValue: null },
        keyEncrypted: { type: Sequelize.TEXT, allowNull: false },
        lastCounter:  { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        lastTapAt:    { type: Sequelize.DATE, allowNull: true, defaultValue: null },
        status:       { type: Sequelize.ENUM('active', 'retired'), allowNull: false, defaultValue: 'active' },
        retiredAt:    { type: Sequelize.DATE, allowNull: true, defaultValue: null },
        notes:        { type: Sequelize.TEXT, allowNull: true, defaultValue: null },
        createdById:  { type: Sequelize.INTEGER, allowNull: true, defaultValue: null,
          references: { model: users, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
        retiredById:  { type: Sequelize.INTEGER, allowNull: true, defaultValue: null,
          references: { model: users, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
        createdAt:    { type: Sequelize.DATE, allowNull: false },
        updatedAt:    { type: Sequelize.DATE, allowNull: false },
      });
      table = TABLE;
    }
    if (!(await hasIndex(queryInterface, table, 'hr_nfc_tags_uid'))) {
      await queryInterface.addIndex(table, ['uid'], { name: 'hr_nfc_tags_uid', unique: true });
    }
  },

  async down(queryInterface) {
    const table = await resolveTable(queryInterface, TABLE);
    if (table) await queryInterface.dropTable(table);
  },
};
