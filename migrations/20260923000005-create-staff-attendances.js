'use strict';

// HR Suite (B21) — the staff Time & Attendance register: one row per session
// or refused tap. Runs AFTER …000003 (HrNfcTags) and …000004 (UserDevices)
// because it references both. The three lookup indexes live here, not in the
// model, because UserId is association-injected (see models/StaffLeave.js).
//
// Distinct from the patient Attendance Register (B19), which is a report over
// Queue and has no table. Guarded, reversible.

const TABLE = 'StaffAttendances';

const resolveTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.find((t) => String(t).toLowerCase() === name.toLowerCase());
};
const hasIndex = async (qi, table, name) => {
  const idx = await qi.showIndex(table);
  return idx.some((i) => String(i.name).toLowerCase() === name.toLowerCase());
};

const INDEXES = [
  { name: 'staff_attendances_user_date',   fields: ['UserId', 'clinicDate'] },
  { name: 'staff_attendances_date_status', fields: ['clinicDate', 'status'] },
  { name: 'staff_attendances_user_status', fields: ['UserId', 'status'] },
];

module.exports = {
  async up(queryInterface, Sequelize) {
    const users   = (await resolveTable(queryInterface, 'Users'))       || 'Users';
    const tags    = (await resolveTable(queryInterface, 'HrNfcTags'))   || 'HrNfcTags';
    const devices = (await resolveTable(queryInterface, 'UserDevices')) || 'UserDevices';
    const fk = (model, allowNull = true) => ({
      type: Sequelize.INTEGER, allowNull, defaultValue: allowNull ? null : undefined,
      references: { model, key: 'id' }, onUpdate: 'CASCADE', onDelete: allowNull ? 'SET NULL' : 'RESTRICT',
    });

    let table = await resolveTable(queryInterface, TABLE);
    if (!table) {
      await queryInterface.createTable(TABLE, {
        id:                   { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        clinicDate:           { type: Sequelize.DATEONLY, allowNull: false },
        checkInAt:            { type: Sequelize.DATE, allowNull: false },
        checkOutAt:           { type: Sequelize.DATE, allowNull: true, defaultValue: null },
        checkInMethod:        { type: Sequelize.ENUM('nfc', 'code', 'manual'), allowNull: false },
        checkOutMethod:       { type: Sequelize.ENUM('nfc', 'code', 'manual'), allowNull: true, defaultValue: null },
        checkInVerification:  { type: Sequelize.ENUM('verified', 'flagged', 'refused', 'manual'), allowNull: false },
        checkOutVerification: { type: Sequelize.ENUM('verified', 'flagged', 'refused', 'manual'), allowNull: true, defaultValue: null },
        checkInIp:            { type: Sequelize.STRING(45), allowNull: true, defaultValue: null },
        checkOutIp:           { type: Sequelize.STRING(45), allowNull: true, defaultValue: null },
        checkInLat:           { type: Sequelize.DECIMAL(9, 6), allowNull: true, defaultValue: null },
        checkInLng:           { type: Sequelize.DECIMAL(9, 6), allowNull: true, defaultValue: null },
        checkOutLat:          { type: Sequelize.DECIMAL(9, 6), allowNull: true, defaultValue: null },
        checkOutLng:          { type: Sequelize.DECIMAL(9, 6), allowNull: true, defaultValue: null },
        expectedInAt:         { type: Sequelize.DATE, allowNull: true, defaultValue: null },
        expectedOutAt:        { type: Sequelize.DATE, allowNull: true, defaultValue: null },
        lateMinutes:          { type: Sequelize.INTEGER, allowNull: true, defaultValue: null },
        earlyOutMinutes:      { type: Sequelize.INTEGER, allowNull: true, defaultValue: null },
        checkInPunctuality:   { type: Sequelize.ENUM('early', 'on_time', 'late', 'none'), allowNull: false, defaultValue: 'none' },
        checkOutPunctuality:  { type: Sequelize.ENUM('early', 'on_time', 'late', 'none'), allowNull: false, defaultValue: 'none' },
        status:               { type: Sequelize.ENUM('open', 'closed', 'missed_checkout', 'refused', 'voided'), allowNull: false, defaultValue: 'open' },
        amendedAt:            { type: Sequelize.DATE, allowNull: true, defaultValue: null },
        amendReason:          { type: Sequelize.TEXT, allowNull: true, defaultValue: null },
        diagnostics:          { type: Sequelize.JSON, allowNull: true, defaultValue: null },
        UserId:               fk(users),
        amendedById:          fk(users),
        createdById:          fk(users, false),
        checkInTagId:         fk(tags),
        checkOutTagId:        fk(tags),
        deviceId:             fk(devices),
        createdAt:            { type: Sequelize.DATE, allowNull: false },
        updatedAt:            { type: Sequelize.DATE, allowNull: false },
      });
      table = TABLE;
    }
    for (const ix of INDEXES) {
      if (!(await hasIndex(queryInterface, table, ix.name))) {
        await queryInterface.addIndex(table, ix.fields, { name: ix.name });
      }
    }
  },

  async down(queryInterface) {
    const table = await resolveTable(queryInterface, TABLE);
    if (table) await queryInterface.dropTable(table);
  },
};
