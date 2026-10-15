'use strict';

// Suppliers — details read from the invoice (15 Oct 2026, Emu): when a supplier
// new to the clinic is added while receiving from an invoice, everything the
// invoice shows about it is kept — phone and email already had columns; this
// adds the postal / street address, the KRA PIN and a notes line.
//
//   Suppliers  + address    STRING(255)
//              + taxPin     STRING(40)    (KRA PIN as printed on the invoice)
//              + notes      STRING(255)   (website, contact person, anything else read)

const TAG = '[20260928000037]';

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};

const COLUMNS = {
  address: (S) => ({ type: S.STRING(255), allowNull: true, defaultValue: null }),
  taxPin: (S) => ({ type: S.STRING(40), allowNull: true, defaultValue: null }),
  notes: (S) => ({ type: S.STRING(255), allowNull: true, defaultValue: null }),
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;
    const suppliers = await findTable(qi, 'Suppliers');
    if (!suppliers) throw new Error(`${TAG} Suppliers missing`);
    const cols = await qi.describeTable(suppliers);
    for (const [name, def] of Object.entries(COLUMNS)) {
      if (!cols[name]) {
        await qi.addColumn(suppliers, name, def(Sequelize));
        console.log(`${TAG} Suppliers.${name} added`);
      }
    }
  },

  async down(queryInterface) {
    const qi = queryInterface;
    const suppliers = await findTable(qi, 'Suppliers');
    if (!suppliers) return;
    const cols = await qi.describeTable(suppliers);
    for (const name of Object.keys(COLUMNS)) {
      if (cols[name]) await qi.removeColumn(suppliers, name);
    }
    console.log(`${TAG} reverted`);
  },
};
