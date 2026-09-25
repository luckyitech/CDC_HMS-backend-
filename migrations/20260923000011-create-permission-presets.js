'use strict';

// Onboarding wizard — permission presets.
//
// A named bundle of access ("Nurse — clinic floor", "Receptionist") that a
// permissions administrator defines once in Settings and the onboarding
// wizard applies to new hires. A template, not a link: no column on Users
// points here, so editing a preset never changes anyone already created.
// See models/PermissionPreset.js and claude/onboarding-wizard-build-spec.md.
//
// Schema only — no seed rows; the clinic defines its own presets from the
// settings screen. Guarded, reversible. Dated after every deployed and every
// pushed migration (…000010 is the hr.confidential seed).

const TABLE = 'PermissionPresets';

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
        id:                { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        name:              { type: Sequelize.STRING, allowNull: false },
        description:       { type: Sequelize.TEXT, allowNull: true, defaultValue: null },
        baseRole:          { type: Sequelize.ENUM('doctor', 'staff', 'nurse', 'lab'), allowNull: false },
        staffType:         { type: Sequelize.ENUM('clinical', 'non_clinical'), allowNull: false, defaultValue: 'clinical' },
        position:          { type: Sequelize.STRING, allowNull: true, defaultValue: null },
        department:        { type: Sequelize.STRING, allowNull: true, defaultValue: null },
        permissions:       { type: Sequelize.JSON, allowNull: false },
        deniedPermissions: { type: Sequelize.JSON, allowNull: false },
        status:            { type: Sequelize.ENUM('active', 'archived'), allowNull: false, defaultValue: 'active' },
        appliedCount:      { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        createdById:       { type: Sequelize.INTEGER, allowNull: true, defaultValue: null,
          references: { model: users, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
        updatedById:       { type: Sequelize.INTEGER, allowNull: true, defaultValue: null,
          references: { model: users, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
        createdAt:         { type: Sequelize.DATE, allowNull: false },
        updatedAt:         { type: Sequelize.DATE, allowNull: false },
      });
      table = TABLE;
    }
    // Name uniqueness is enforced among ACTIVE presets by the controller, not
    // by a unique index — an archived preset's name must stay reusable. This
    // index is for the wizard's "active presets for this cadre" query only.
    if (!(await hasIndex(queryInterface, table, 'permission_presets_status_role'))) {
      await queryInterface.addIndex(table, ['status', 'baseRole'], { name: 'permission_presets_status_role' });
    }
  },

  async down(queryInterface) {
    const table = await resolveTable(queryInterface, TABLE);
    if (table) await queryInterface.dropTable(table);
  },
};
