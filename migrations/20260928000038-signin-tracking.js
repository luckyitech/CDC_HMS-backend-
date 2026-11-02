'use strict';

// Sign-in tracking (16 Oct 2026, Emu): where and how each member of staff
// signs in — and every attempt that fails.
//
//   UserLoginLogs  + outcome ('success' | 'failed'), failReason, emailTried,
//                  userAgent, deviceLabel, network ('clinic' | 'outside' |
//                  'unknown') + networkLabel, the looked-up place (countryCode,
//                  country, region, city, isp), the browser's own location
//                  (gpsStatus, gpsLat, gpsLng, gpsAccuracy, gpsAt), and the
//                  suspicious flag (flagged, flagReasons, alertedAt).
//                  userId / name / role become NULLABLE: a failed attempt on an
//                  address that is no account has no person to name.
//   IpLocations    NEW — one row per outside address ever looked up, so each
//                  is sent to the lookup service once and the answer is kept.
//
// Kept forever (Emu: "the system never forgets"); nothing here expires rows.
//
// `down`: REFUSES once a failed attempt is recorded (those rows cannot go
// back under a NOT NULL userId) — restore the backup instead. Otherwise it
// removes the columns and the cache table.

const TAG = '[20260928000038]';
const ROLES = ['doctor', 'staff', 'lab', 'nurse', 'admin'];

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};
const columnsOf = async (qi, table) => Object.keys(await qi.describeTable(table)).map((c) => c.toLowerCase());
const indexNames = async (qi, table) => (await qi.showIndex(table)).map((i) => String(i.name).toLowerCase());

const NEW_COLUMNS = (S) => ({
  outcome:      { type: S.STRING(16), allowNull: false, defaultValue: 'success' },
  failReason:   { type: S.STRING(32), allowNull: true },
  emailTried:   { type: S.STRING(255), allowNull: true },
  userAgent:    { type: S.STRING(512), allowNull: true },
  deviceLabel:  { type: S.STRING(64), allowNull: true },
  network:      { type: S.STRING(16), allowNull: true },
  networkLabel: { type: S.STRING(60), allowNull: true },
  countryCode:  { type: S.STRING(2), allowNull: true },
  country:      { type: S.STRING(80), allowNull: true },
  region:       { type: S.STRING(100), allowNull: true },
  city:         { type: S.STRING(100), allowNull: true },
  isp:          { type: S.STRING(150), allowNull: true },
  gpsStatus:    { type: S.STRING(16), allowNull: true },
  gpsLat:       { type: S.DECIMAL(9, 6), allowNull: true },
  gpsLng:       { type: S.DECIMAL(9, 6), allowNull: true },
  gpsAccuracy:  { type: S.INTEGER, allowNull: true },
  gpsAt:        { type: S.DATE, allowNull: true },
  flagged:      { type: S.BOOLEAN, allowNull: false, defaultValue: false },
  flagReasons:  { type: S.STRING(255), allowNull: true },
  alertedAt:    { type: S.DATE, allowNull: true },
});

const INDEXES = [
  { name: 'idx_login_log_user_time', fields: ['userId', 'loginAt'] },
  { name: 'idx_login_log_outcome_time', fields: ['outcome', 'loginAt'] },
  { name: 'idx_login_log_flagged_time', fields: ['flagged', 'loginAt'] },
  { name: 'idx_login_log_ip', fields: ['ipAddress'] },
  { name: 'idx_login_log_email_tried', fields: ['emailTried', 'loginAt'] },
];

module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;
    const logs = await findTable(qi, 'UserLoginLogs');
    if (!logs) throw new Error(`${TAG} UserLoginLogs is missing`);

    // A failed attempt may name no account.
    const desc = await qi.describeTable(logs);
    const col = (name) => desc[Object.keys(desc).find((c) => c.toLowerCase() === name.toLowerCase())];
    if (col('userId') && col('userId').allowNull === false) {
      await qi.changeColumn(logs, 'userId', { type: Sequelize.INTEGER, allowNull: true });
    }
    if (col('name') && col('name').allowNull === false) {
      await qi.changeColumn(logs, 'name', { type: Sequelize.STRING, allowNull: true });
    }
    if (col('role') && col('role').allowNull === false) {
      await qi.changeColumn(logs, 'role', { type: Sequelize.ENUM(...ROLES), allowNull: true });
    }

    const have = await columnsOf(qi, logs);
    for (const [name, spec] of Object.entries(NEW_COLUMNS(Sequelize))) {
      if (!have.includes(name.toLowerCase())) await qi.addColumn(logs, name, spec);
    }
    const idx = await indexNames(qi, logs);
    for (const i of INDEXES) {
      if (!idx.includes(i.name)) await qi.addIndex(logs, i.fields, { name: i.name });
    }

    if (!await findTable(qi, 'IpLocations')) {
      await qi.createTable('IpLocations', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        ip: { type: Sequelize.STRING(45), allowNull: false },
        countryCode: { type: Sequelize.STRING(2), allowNull: true },
        country: { type: Sequelize.STRING(80), allowNull: true },
        region: { type: Sequelize.STRING(100), allowNull: true },
        city: { type: Sequelize.STRING(100), allowNull: true },
        isp: { type: Sequelize.STRING(150), allowNull: true },
        provider: { type: Sequelize.STRING(16), allowNull: true },
        status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'ok' },
        lookedUpAt: { type: Sequelize.DATE, allowNull: false },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      await qi.addIndex('IpLocations', ['ip'], { name: 'uq_ip_locations_ip', unique: true });
    }
    console.log(`${TAG} sign-in tracking columns and IpLocations ready`);
  },

  async down(queryInterface, Sequelize) {
    const qi = queryInterface;
    const logs = await findTable(qi, 'UserLoginLogs');
    if (logs) {
      const have = await columnsOf(qi, logs);
      if (have.includes('outcome')) {
        const [rows] = await qi.sequelize.query(`SELECT COUNT(*) AS n FROM \`${logs}\` WHERE outcome = 'failed' OR userId IS NULL`);
        const n = Number(rows[0].n ?? rows[0].N ?? 0);
        if (n > 0) throw new Error(`${TAG} down refused: ${n} failed sign-in record(s). Restore the database backup instead.`);
      }
      const idx = await indexNames(qi, logs);
      for (const i of INDEXES) if (idx.includes(i.name)) await qi.removeIndex(logs, i.name);
      for (const name of Object.keys(NEW_COLUMNS(Sequelize))) {
        if (have.includes(name.toLowerCase())) await qi.removeColumn(logs, name);
      }
      await qi.changeColumn(logs, 'userId', { type: Sequelize.INTEGER, allowNull: false });
      await qi.changeColumn(logs, 'name', { type: Sequelize.STRING, allowNull: false });
      await qi.changeColumn(logs, 'role', { type: Sequelize.ENUM(...ROLES), allowNull: false });
    }
    const cache = await findTable(qi, 'IpLocations');
    if (cache) await qi.dropTable(cache);
    console.log(`${TAG} reverted`);
  },
};
