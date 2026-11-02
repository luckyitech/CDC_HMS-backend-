'use strict';

// Check-in phones registered by HR (17 Oct 2026, Emu): "only HR with the
// register phones permission can register a phone".
//
//   UserDevices         + registeredById — the HR member who registered the
//                       phone. NULL on phones remembered before this change
//                       (staff ticked "remember this phone" themselves); they
//                       keep working until revoked, expired or replaced.
//   PhoneRegistrations  NEW — the one-time codes HR issues. Only the code's
//                       SHA-256 is kept; a code works once, for 10 minutes,
//                       and issuing a new one for the same person ends any
//                       earlier one. deviceId is the phone it registered.
//
// `down` drops the code table and the column. Phones already registered stay
// (they are ordinary UserDevices rows).

const TAG = '[20260928000039]';

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};
const columnsOf = async (qi, table) => Object.keys(await qi.describeTable(table)).map((c) => c.toLowerCase());

module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;
    const users = await findTable(qi, 'Users');
    const devices = await findTable(qi, 'UserDevices');
    if (!users || !devices) throw new Error(`${TAG} Users or UserDevices missing — run the earlier migrations first.`);

    if (!(await columnsOf(qi, devices)).includes('registeredbyid')) {
      await qi.addColumn(devices, 'registeredById', {
        type: Sequelize.INTEGER, allowNull: true,
        references: { model: users, key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE',
      });
    }

    if (!(await findTable(qi, 'PhoneRegistrations'))) {
      await qi.createTable('PhoneRegistrations', {
        id:         { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        UserId:     { type: Sequelize.INTEGER, allowNull: false,
          references: { model: users, key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
        codeHash:   { type: Sequelize.STRING(64), allowNull: false, unique: true },
        expiresAt:  { type: Sequelize.DATE, allowNull: false },
        usedAt:     { type: Sequelize.DATE, allowNull: true },
        issuedById: { type: Sequelize.INTEGER, allowNull: true,
          references: { model: users, key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE' },
        deviceId:   { type: Sequelize.INTEGER, allowNull: true,
          references: { model: devices, key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE' },
        createdAt:  { type: Sequelize.DATE, allowNull: false },
        updatedAt:  { type: Sequelize.DATE, allowNull: false },
      });
    }
    console.log(`${TAG} applied`);
  },

  async down(queryInterface) {
    const qi = queryInterface;
    const codes = await findTable(qi, 'PhoneRegistrations');
    if (codes) await qi.dropTable(codes);
    const devices = await findTable(qi, 'UserDevices');
    if (devices && (await columnsOf(qi, devices)).includes('registeredbyid')) {
      // MySQL will not drop a column a foreign key still points through.
      const [fks] = await qi.sequelize.query(
        `SELECT CONSTRAINT_NAME AS name FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'registeredById' AND REFERENCED_TABLE_NAME IS NOT NULL`,
        { replacements: [devices] },
      );
      for (const fk of fks) await qi.removeConstraint(devices, fk.name);
      await qi.removeColumn(devices, 'registeredById');
    }
    console.log(`${TAG} reverted`);
  },
};
