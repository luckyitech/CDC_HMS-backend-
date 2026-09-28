'use strict';

// B27 phase 0 (4 of 6) — the bell carries more than patient documents.
// Spec §3.1.
//
// Notifications was shaped for one thing: "a document was uploaded for this
// patient". HR alerts (a leave request to approve, a decision, an expiry) have
// no patient, so:
//   - patientName, patientUhid, documentName, documentCategory → NULLABLE
//   - + category  VARCHAR(30) NOT NULL DEFAULT 'document'  (existing rows are documents)
//   - + title     VARCHAR(255)
//   - + body      TEXT
//   - + link      VARCHAR(255)   an in-app path the bell opens
// The recipient column keeps its old name, assignedDoctorId — it is simply
// "the user this notification is for".
//
// Guarded both ways. `down` DELETES the non-document notifications (the old
// shape can't hold them — bell items only, nothing clinical) and then restores
// NOT NULL.

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};

const PATIENT_FIELDS = ['patientName', 'patientUhid', 'documentName', 'documentCategory'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await findTable(queryInterface, 'Notifications');
    if (!table) return;
    const cols = await queryInterface.describeTable(table);

    for (const name of PATIENT_FIELDS) {
      if (cols[name] && cols[name].allowNull === false) {
        await queryInterface.changeColumn(table, name, { type: Sequelize.STRING, allowNull: true });
      }
    }
    if (!cols.category) {
      await queryInterface.addColumn(table, 'category', { type: Sequelize.STRING(30), allowNull: false, defaultValue: 'document' });
    }
    if (!cols.title) await queryInterface.addColumn(table, 'title', { type: Sequelize.STRING(255), allowNull: true });
    if (!cols.body) await queryInterface.addColumn(table, 'body', { type: Sequelize.TEXT, allowNull: true });
    if (!cols.link) await queryInterface.addColumn(table, 'link', { type: Sequelize.STRING(255), allowNull: true });
  },

  async down(queryInterface, Sequelize) {
    const table = await findTable(queryInterface, 'Notifications');
    if (!table) return;
    const cols = await queryInterface.describeTable(table);

    if (cols.category) {
      await queryInterface.sequelize.query(`DELETE FROM ${table} WHERE category <> 'document'`);
    }
    // Any document row somehow missing a field can't satisfy NOT NULL either.
    await queryInterface.sequelize.query(
      `DELETE FROM ${table} WHERE ${PATIENT_FIELDS.map((f) => `${f} IS NULL`).join(' OR ')}`
    );
    for (const name of ['link', 'body', 'title', 'category']) {
      if (cols[name]) await queryInterface.removeColumn(table, name);
    }
    for (const name of PATIENT_FIELDS) {
      if (cols[name]) await queryInterface.changeColumn(table, name, { type: Sequelize.STRING, allowNull: false });
    }
  },
};
