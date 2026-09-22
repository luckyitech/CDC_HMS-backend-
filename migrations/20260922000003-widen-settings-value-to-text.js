'use strict';

// Settings.value: VARCHAR(255) → TEXT.
//
// The Settings key/value store now holds ENCRYPTED credentials for the Comms
// Inbox (utils/commsConfig): the Meta App Secret, the WhatsApp System User
// token and the Facebook Page access token. AES-256-CBC output is written as
// `<iv hex>:<ciphertext hex>`, i.e. roughly 2× the plaintext plus 33 chars.
// A 32-char App Secret fits in 255; a ~230-char Page / System User token does
// not (≈510 chars) and MySQL rejects the row with "Data too long", which the
// settings screen surfaces as "Failed to update the WhatsApp settings".
//
// Guarded: reads the live column type and only alters when it is not already
// a TEXT type. Plain column widen — no foreign keys involved, so this is a
// single ALTER TABLE ... MODIFY (never sync/alter:true).

const TABLE = 'Settings';
const COLUMN = 'value';

const tableExists = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables
    .map((t) => (typeof t === 'string' ? t : t.tableName).toLowerCase())
    .includes(name.toLowerCase());
};

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface, TABLE))) return;
    const cols = await queryInterface.describeTable(TABLE);
    const col = cols[COLUMN];
    if (!col) return;
    if (/text/i.test(col.type)) return;   // already widened

    await queryInterface.changeColumn(TABLE, COLUMN, {
      type: Sequelize.TEXT,
      allowNull: false,
    });
  },

  async down(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface, TABLE))) return;
    const cols = await queryInterface.describeTable(TABLE);
    const col = cols[COLUMN];
    if (!col || !/text/i.test(col.type)) return;

    // Reversal narrows the column again. Any value longer than 255 chars (an
    // encrypted long token) would be truncated by MySQL in non-strict mode or
    // rejected in strict mode — clear those keys first if you really need to
    // roll back past this point.
    await queryInterface.changeColumn(TABLE, COLUMN, {
      type: Sequelize.STRING(255),
      allowNull: false,
    });
  },
};
