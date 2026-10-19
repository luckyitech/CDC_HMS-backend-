'use strict';

// HR Suite — fingerprint scanner + one session per day (17 Oct 2026).
//
//   HrScanners       the scanner the relay reports for (key stored as SHA-256)
//   HrScannerUsers   users enrolled on it, and the staff member each is linked to
//   StaffPunches     every punch: NFC tap, fingerprint/card, or an HR time
//   StaffAttendances + 'fingerprint' / 'card' methods
//
// Guarded (describeTable / showAllTables before every step) and reversible.
// down() turns any fingerprint/card method back into 'manual' before
// narrowing the ENUM, so it never fails on rows written after go-live.

const resolveTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.find((t) => String(t).toLowerCase() === name.toLowerCase());
};
const hasIndex = async (qi, table, name) => {
  const idx = await qi.showIndex(table);
  return idx.some((i) => String(i.name).toLowerCase() === name.toLowerCase());
};

const METHODS_NEW = ['nfc', 'code', 'manual', 'fingerprint', 'card'];
const METHODS_OLD = ['nfc', 'code', 'manual'];
// Counters an earlier version of this migration (17–18 Oct 2026, never run
// in production) added; the simplified model (first punch in, last out) has
// no use for them. down() still removes them if a database got them.
const COUNTERS = ['inCount', 'outCount', 'awayMinutes'];

const INDEXES = [
  { table: 'HrScannerUsers', name: 'hr_scanner_users_scanner_no', fields: ['scannerId', 'userNo'], unique: true },
  { table: 'HrScannerUsers', name: 'hr_scanner_users_user', fields: ['UserId'] },
  { table: 'StaffPunches', name: 'staff_punches_scanner_no_at', fields: ['scannerId', 'scannerUserNo', 'at'], unique: true },
  { table: 'StaffPunches', name: 'staff_punches_user_date', fields: ['UserId', 'clinicDate'] },
  { table: 'StaffPunches', name: 'staff_punches_outcome', fields: ['scannerId', 'outcome'] },
  { table: 'StaffPunches', name: 'staff_punches_session', fields: ['attendanceId'] },
];

module.exports = {
  async up(queryInterface, Sequelize) {
    const users    = (await resolveTable(queryInterface, 'Users'))            || 'Users';
    const tags     = (await resolveTable(queryInterface, 'HrNfcTags'))        || 'HrNfcTags';
    const devices  = (await resolveTable(queryInterface, 'UserDevices'))      || 'UserDevices';
    const sessions = (await resolveTable(queryInterface, 'StaffAttendances')) || 'StaffAttendances';
    const fk = (model, onDelete = 'SET NULL') => ({
      type: Sequelize.INTEGER, allowNull: true, defaultValue: null,
      references: { model, key: 'id' }, onUpdate: 'CASCADE', onDelete,
    });
    const stamps = {
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    };

    if (!(await resolveTable(queryInterface, 'HrScanners'))) {
      await queryInterface.createTable('HrScanners', {
        id:           { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        serial:       { type: Sequelize.STRING(32), allowNull: false, unique: true },
        label:        { type: Sequelize.STRING, allowNull: false },
        location:     { type: Sequelize.STRING, allowNull: true, defaultValue: null },
        keyHash:      { type: Sequelize.STRING(64), allowNull: false },
        keySetAt:     { type: Sequelize.DATE, allowNull: true, defaultValue: null },
        status:       { type: Sequelize.ENUM('active', 'stopped'), allowNull: false, defaultValue: 'active' },
        goLiveAt:     { type: Sequelize.DATE, allowNull: false },
        lastSeenAt:   { type: Sequelize.DATE, allowNull: true, defaultValue: null },
        lastPunchAt:  { type: Sequelize.DATE, allowNull: true, defaultValue: null },
        recordCount:  { type: Sequelize.INTEGER, allowNull: true, defaultValue: null },
        userCount:    { type: Sequelize.INTEGER, allowNull: true, defaultValue: null },
        relayVersion: { type: Sequelize.STRING(32), allowNull: true, defaultValue: null },
        relayHost:    { type: Sequelize.STRING(64), allowNull: true, defaultValue: null },
        clockDriftSeconds: { type: Sequelize.INTEGER, allowNull: true, defaultValue: null },
        createdById:  fk(users),
        ...stamps,
      });
    }
    const scanners = (await resolveTable(queryInterface, 'HrScanners')) || 'HrScanners';

    if (!(await resolveTable(queryInterface, 'HrScannerUsers'))) {
      await queryInterface.createTable('HrScannerUsers', {
        id:          { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        scannerId:   { ...fk(scanners, 'CASCADE'), allowNull: false, defaultValue: undefined },
        userNo:      { type: Sequelize.STRING(24), allowNull: false },
        name:        { type: Sequelize.STRING, allowNull: true, defaultValue: null },
        status:      { type: Sequelize.ENUM('unlinked', 'linked', 'ignored'), allowNull: false, defaultValue: 'unlinked' },
        linkedAt:    { type: Sequelize.DATE, allowNull: true, defaultValue: null },
        lastPunchAt: { type: Sequelize.DATE, allowNull: true, defaultValue: null },
        onScanner:   { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        UserId:      fk(users),
        linkedById:  fk(users),
        ...stamps,
      });
    }

    if (!(await resolveTable(queryInterface, 'StaffPunches'))) {
      await queryInterface.createTable('StaffPunches', {
        id:            { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        at:            { type: Sequelize.DATE, allowNull: false },
        clinicDate:    { type: Sequelize.DATEONLY, allowNull: true, defaultValue: null },
        source:        { type: Sequelize.ENUM('nfc', 'fingerprint', 'card', 'manual'), allowNull: false },
        outcome:       { type: Sequelize.ENUM('pending', 'applied', 'unlinked', 'before_golive', 'implausible', 'ignored', 'voided'), allowNull: false, defaultValue: 'pending' },
        direction:     { type: Sequelize.ENUM('in', 'out'), allowNull: true, defaultValue: null },
        scannerUserNo: { type: Sequelize.STRING(24), allowNull: true, defaultValue: null },
        verifyCode:    { type: Sequelize.INTEGER, allowNull: true, defaultValue: null },
        ip:            { type: Sequelize.STRING(45), allowNull: true, defaultValue: null },
        lat:           { type: Sequelize.DECIMAL(9, 6), allowNull: true, defaultValue: null },
        lng:           { type: Sequelize.DECIMAL(9, 6), allowNull: true, defaultValue: null },
        diagnostics:   { type: Sequelize.JSON, allowNull: true, defaultValue: null },
        UserId:        fk(users),
        attendanceId:  fk(sessions),
        scannerId:     fk(scanners),
        tagId:         fk(tags),
        deviceId:      fk(devices),
        createdById:   fk(users),
        ...stamps,
      });
    }

    for (const ix of INDEXES) {
      const table = await resolveTable(queryInterface, ix.table);
      if (table && !(await hasIndex(queryInterface, table, ix.name))) {
        await queryInterface.addIndex(table, ix.fields, { name: ix.name, unique: !!ix.unique });
      }
    }

    const cols = await queryInterface.describeTable(sessions);
    for (const col of ['checkInMethod', 'checkOutMethod']) {
      if (cols[col] && !String(cols[col].type).toLowerCase().includes('fingerprint')) {
        await queryInterface.changeColumn(sessions, col, {
          type: Sequelize.ENUM(...METHODS_NEW),
          allowNull: col === 'checkOutMethod',
          ...(col === 'checkOutMethod' ? { defaultValue: null } : {}),
        });
      }
    }
  },

  async down(queryInterface, Sequelize) {
    const sessions = await resolveTable(queryInterface, 'StaffAttendances');
    if (sessions) {
      const cols = await queryInterface.describeTable(sessions);
      for (const col of COUNTERS) {
        if (cols[col]) await queryInterface.removeColumn(sessions, col);
      }
      for (const col of ['checkInMethod', 'checkOutMethod']) {
        if (cols[col] && String(cols[col].type).toLowerCase().includes('fingerprint')) {
          await queryInterface.sequelize.query(
            `UPDATE \`${sessions}\` SET \`${col}\` = 'manual' WHERE \`${col}\` IN ('fingerprint', 'card')`,
          );
          await queryInterface.changeColumn(sessions, col, {
            type: Sequelize.ENUM(...METHODS_OLD),
            allowNull: col === 'checkOutMethod',
            ...(col === 'checkOutMethod' ? { defaultValue: null } : {}),
          });
        }
      }
    }
    for (const name of ['StaffPunches', 'HrScannerUsers', 'HrScanners']) {
      const table = await resolveTable(queryInterface, name);
      if (table) await queryInterface.dropTable(table);
    }
  },
};
