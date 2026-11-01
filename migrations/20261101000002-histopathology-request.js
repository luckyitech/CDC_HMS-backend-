'use strict';

// Histopathology request (1 Nov 2026, Emu): one request carries one or more
// specimens, each histology or cytology — one requisition, printed as one
// form. Each specimen stays its own HistologyRequests row (its own number and
// result); this groups them.
//
//   HistologyRequests + requisitionNumber STRING(30)  the request the specimen is on
//                     + priority          STRING(10)  Routine | Urgent | STAT
//                     + relevantHistory   TEXT        optional, printed
//                     + index idx_histology_requisition
//
// Existing rows get the requisition number of their lab line (each was a
// request of one specimen). Guarded; down() removes the columns and index.

const TAG = '[20261101000002]';
const INDEX = 'idx_histology_requisition';

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;
    const histo = await findTable(qi, 'HistologyRequests');
    if (!histo) throw new Error(`${TAG} HistologyRequests missing`);
    const cols = await qi.describeTable(histo);
    if (!cols.requisitionNumber) {
      await qi.addColumn(histo, 'requisitionNumber', { type: Sequelize.STRING(30), allowNull: true, defaultValue: null });
      console.log(`${TAG} HistologyRequests.requisitionNumber added`);
    }
    if (!cols.priority) {
      await qi.addColumn(histo, 'priority', { type: Sequelize.STRING(10), allowNull: true, defaultValue: null });
      console.log(`${TAG} HistologyRequests.priority added`);
    }
    if (!cols.relevantHistory) {
      await qi.addColumn(histo, 'relevantHistory', { type: Sequelize.TEXT, allowNull: true });
      console.log(`${TAG} HistologyRequests.relevantHistory added`);
    }
    const indexes = await qi.showIndex(histo);
    if (!indexes.some((i) => i.name === INDEX)) {
      await qi.addIndex(histo, ['requisitionNumber'], { name: INDEX });
    }
    const lab = await findTable(qi, 'LabTests');
    if (lab) {
      const [, meta] = await qi.sequelize.query(
        `UPDATE \`${histo}\` h JOIN \`${lab}\` l ON l.id = h.LabTestId
            SET h.requisitionNumber = l.requisitionNumber, h.priority = COALESCE(h.priority, l.priority)
          WHERE h.requisitionNumber IS NULL`,
      );
      console.log(`${TAG} existing requests numbered: ${meta && meta.affectedRows != null ? meta.affectedRows : 'done'}`);
    }
  },

  async down(queryInterface) {
    const qi = queryInterface;
    const histo = await findTable(qi, 'HistologyRequests');
    if (!histo) return;
    const indexes = await qi.showIndex(histo);
    if (indexes.some((i) => i.name === INDEX)) await qi.removeIndex(histo, INDEX);
    const cols = await qi.describeTable(histo);
    for (const c of ['relevantHistory', 'priority', 'requisitionNumber']) {
      if (cols[c]) await qi.removeColumn(histo, c);
    }
    console.log(`${TAG} reverted`);
  },
};
