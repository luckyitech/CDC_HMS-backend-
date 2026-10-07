'use strict';

// Remote requests (6 Oct 2026) — a prescription or lab request written OUTSIDE
// a consultation: the patient (or a relative, or a pharmacy) phoned, sent a
// WhatsApp or email, or walked in without a visit.
//
//   RemoteRequests   NEW — one per request: PatientId (canonical), doctorId
//                    (the author, from the JWT), channel phone|whatsapp|email|
//                    walk_in, requestedByType patient|relative|pharmacy,
//                    requestedByName, note (the clinical note — required),
//                    status active|cancelled (+ cancelledById / cancelledAt),
//                    createdAt, updatedAt. Never hard-deleted.
//   Prescriptions.remoteRequestId   NEW, nullable — the request it answered.
//   LabTests.remoteRequestId        NEW, nullable — same, on every row of the
//                                   requisition.
// NULL on both = written in a consultation (every existing row).
//
// `down`: REFUSES once any remote request exists (it is part of the medical
// record — restore the backup instead). When empty, removes the two columns
// (foreign key before index) and drops the table. Guarded both ways; table
// names compared case-insensitively (the VDS returns them lowercase).

const TAG = '[20260928000020]';

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};

const LINKED = ['Prescriptions', 'LabTests'];
const fkName = (table) => `fk_${table.toLowerCase()}_remote_request`;
const idxName = (table) => `idx_${table.toLowerCase()}_remote_request`;

module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;
    const users = await findTable(qi, 'Users') || 'Users';
    const patients = await findTable(qi, 'Patients') || 'Patients';

    let rr = await findTable(qi, 'RemoteRequests');
    if (!rr) {
      await qi.createTable('RemoteRequests', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        PatientId: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: patients, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        doctorId: {
          type: Sequelize.INTEGER, allowNull: true,
          references: { model: users, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
        },
        channel: { type: Sequelize.ENUM('phone', 'whatsapp', 'email', 'walk_in'), allowNull: false },
        requestedByType: { type: Sequelize.ENUM('patient', 'relative', 'pharmacy'), allowNull: false },
        requestedByName: { type: Sequelize.STRING(120), allowNull: true },
        note: { type: Sequelize.TEXT, allowNull: false },
        status: { type: Sequelize.ENUM('active', 'cancelled'), allowNull: false, defaultValue: 'active' },
        cancelledById: {
          type: Sequelize.INTEGER, allowNull: true,
          references: { model: users, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
        },
        cancelledAt: { type: Sequelize.DATE, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      await qi.addIndex('RemoteRequests', ['PatientId', 'createdAt'], { name: 'idx_remote_request_patient' });
      rr = 'RemoteRequests';
      console.log(`${TAG} RemoteRequests created`);
    }

    for (const name of LINKED) {
      const table = await findTable(qi, name);
      if (!table) { console.log(`${TAG} ${name} not found — skipped`); continue; }
      const cols = await qi.describeTable(table);
      if (cols.remoteRequestId) continue;
      await qi.addColumn(table, 'remoteRequestId', { type: Sequelize.INTEGER, allowNull: true });
      await qi.addIndex(table, ['remoteRequestId'], { name: idxName(name) });
      await qi.addConstraint(table, {
        fields: ['remoteRequestId'], type: 'foreign key', name: fkName(name),
        references: { table: rr, field: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      });
      console.log(`${TAG} ${name}.remoteRequestId added`);
    }
  },

  async down(queryInterface) {
    const qi = queryInterface;
    const rr = await findTable(qi, 'RemoteRequests');
    if (rr) {
      const [rows] = await qi.sequelize.query(`SELECT COUNT(*) AS n FROM \`${rr}\``);
      const n = Number(rows[0].n ?? rows[0].N ?? 0);
      if (n > 0) throw new Error(`${TAG} down refused: ${n} remote request(s) exist (part of the medical record). Restore the database backup instead.`);
    }
    for (const name of LINKED) {
      const table = await findTable(qi, name);
      if (!table) continue;
      const cols = await qi.describeTable(table);
      if (!cols.remoteRequestId) continue;
      try { await qi.removeConstraint(table, fkName(name)); } catch { /* already gone */ }
      try { await qi.removeIndex(table, idxName(name)); } catch { /* already gone */ }
      await qi.removeColumn(table, 'remoteRequestId');
    }
    if (rr) await qi.dropTable(rr);
    console.log(`${TAG} remote requests removed (table was empty)`);
  },
};
