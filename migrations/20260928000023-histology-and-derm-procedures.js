'use strict';

// Dermatology Phase 3 — histology / cytology requests and skin procedures
// (7 Oct 2026; decisions D11, H1–H12).
//
//   HistologyRequests     NEW — a general tool (not dermatology-only): the
//                         specimen (kind, site — skin finding / thyroid nodule
//                         lobe, label, TI-RADS / lymph node / other — type,
//                         pieces, fixative, clinical details, lab), the Pending
//                         LabTest raised with it (LabTestId), and the typed
//                         result (diagnosis, margins, Bethesda, category,
//                         comment, report date, report MedicalDocument).
//                         status awaiting | resulted | cancelled.
//   HistologyEdits        NEW — trail: result corrections and cancellations.
//   DermProcedures        NEW — a procedure on skin findings (recorded, not
//                         billed), optionally linked to a histology request.
//   DermProcedureTargets  NEW — procedure ↔ finding.
//   DermEdits.entity      ENUM widened: + 'procedure' (amendments of a
//                         procedure share the skin record's trail).
//
// Both modules stay OFF until switched on (Settings 'modules.histology',
// 'modules.dermatology'); on CDC's server these tables stay empty. No
// existing column is changed except the DermEdits ENUM, which only gains a
// value.
//
// `down`: REFUSES once any histology request or procedure exists, or any
// DermEdits row is a procedure amendment (medical record — restore the backup
// instead). When empty it narrows the ENUM back and drops the four tables,
// children first.

const TAG = '[20260928000023]';

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};

const countRows = async (qi, table, where = '') => {
  const [rows] = await qi.sequelize.query(`SELECT COUNT(*) AS n FROM \`${table}\` ${where}`);
  return Number(rows[0].n ?? rows[0].N ?? 0);
};

const KINDS = ['histology', 'cytology'];
const SITE_TYPES = ['skin', 'thyroid', 'lymph_node', 'other'];
const SPECIMEN_TYPES = ['punch', 'shave', 'incisional', 'excision', 'core_needle', 'other', 'fnac', 'brushings', 'fluid'];
const FIXATIVES = ['formalin', 'fresh', 'slides', 'cytolyt', 'other'];
const LOBES = ['right', 'left', 'isthmus'];
const TIRADS = ['TR1', 'TR2', 'TR3', 'TR4', 'TR5'];
const MARGINS = ['clear', 'close', 'involved', 'not_assessed'];
const BETHESDA = ['I', 'II', 'III', 'IV', 'V', 'VI'];
const CYTO_CATEGORIES = ['non_diagnostic', 'benign', 'atypical', 'suspicious', 'malignant'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;
    const users = await findTable(qi, 'Users') || 'Users';
    const patients = await findTable(qi, 'Patients') || 'Patients';
    const labTests = await findTable(qi, 'LabTests') || 'LabTests';
    const documents = await findTable(qi, 'MedicalDocuments') || 'MedicalDocuments';
    const findings = await findTable(qi, 'DermFindings');
    const edits = await findTable(qi, 'DermEdits');
    if (!findings || !edits) throw new Error(`${TAG} DermFindings / DermEdits missing — run 20260928000021 first`);
    if (!await findTable(qi, 'DermPhotos')) throw new Error(`${TAG} DermPhotos missing — run 20260928000022 first`);

    const userFk = () => ({
      type: Sequelize.INTEGER, allowNull: true,
      references: { model: users, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
    });
    const patientFk = () => ({
      type: Sequelize.INTEGER, allowNull: false,
      references: { model: patients, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
    });

    let histology = await findTable(qi, 'HistologyRequests');
    if (!histology) {
      await qi.createTable('HistologyRequests', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        PatientId: patientFk(),
        specimenNumber: { type: Sequelize.STRING(20), allowNull: false },
        kind: { type: Sequelize.ENUM(...KINDS), allowNull: false },
        siteType: { type: Sequelize.ENUM(...SITE_TYPES), allowNull: false },
        DermFindingId: {
          type: Sequelize.INTEGER, allowNull: true,
          references: { model: findings, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
        },
        thyroidLobe: { type: Sequelize.ENUM(...LOBES), allowNull: true },
        noduleLabel: { type: Sequelize.STRING(80), allowNull: true },
        tirads: { type: Sequelize.ENUM(...TIRADS), allowNull: true },
        siteText: { type: Sequelize.STRING(200), allowNull: true },
        specimenType: { type: Sequelize.ENUM(...SPECIMEN_TYPES), allowNull: false },
        pieces: { type: Sequelize.INTEGER, allowNull: true },
        fixative: { type: Sequelize.ENUM(...FIXATIVES), allowNull: true },
        clinicalDetails: { type: Sequelize.TEXT, allowNull: false },
        sendTo: { type: Sequelize.STRING(150), allowNull: true },
        visitDate: { type: Sequelize.DATEONLY, allowNull: false },
        LabTestId: {
          type: Sequelize.INTEGER, allowNull: true,
          references: { model: labTests, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
        },
        requestedById: userFk(),
        status: { type: Sequelize.ENUM('awaiting', 'resulted', 'cancelled'), allowNull: false, defaultValue: 'awaiting' },
        resultDiagnosis: { type: Sequelize.TEXT, allowNull: true },
        margins: { type: Sequelize.ENUM(...MARGINS), allowNull: true },
        marginMm: { type: Sequelize.DECIMAL(5, 1), allowNull: true },
        bethesda: { type: Sequelize.ENUM(...BETHESDA), allowNull: true },
        cytologyCategory: { type: Sequelize.ENUM(...CYTO_CATEGORIES), allowNull: true },
        resultComment: { type: Sequelize.TEXT, allowNull: true },
        reportDate: { type: Sequelize.DATEONLY, allowNull: true },
        reportDocumentId: {
          type: Sequelize.INTEGER, allowNull: true,
          references: { model: documents, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
        },
        resultById: userFk(),
        resultAt: { type: Sequelize.DATE, allowNull: true },
        cancelReason: { type: Sequelize.STRING(500), allowNull: true },
        cancelledById: userFk(),
        cancelledAt: { type: Sequelize.DATE, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      await qi.addIndex('HistologyRequests', ['specimenNumber'], { unique: true, name: 'unique_histology_specimen' });
      await qi.addIndex('HistologyRequests', ['PatientId', 'visitDate'], { name: 'idx_histology_patient' });
      await qi.addIndex('HistologyRequests', ['DermFindingId'], { name: 'idx_histology_finding' });
      await qi.addIndex('HistologyRequests', ['status', 'visitDate'], { name: 'idx_histology_status' });
      histology = 'HistologyRequests';
      console.log(`${TAG} HistologyRequests created`);
    }

    if (!await findTable(qi, 'HistologyEdits')) {
      await qi.createTable('HistologyEdits', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        HistologyRequestId: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: histology, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        action: { type: Sequelize.ENUM('amend_result', 'cancel'), allowNull: false },
        changes: { type: Sequelize.TEXT, allowNull: false },
        reason: { type: Sequelize.STRING(500), allowNull: false },
        editedById: userFk(),
        createdAt: { type: Sequelize.DATE, allowNull: false },
      });
      await qi.addIndex('HistologyEdits', ['HistologyRequestId'], { name: 'idx_histology_edit_request' });
      console.log(`${TAG} HistologyEdits created`);
    }

    let procedures = await findTable(qi, 'DermProcedures');
    if (!procedures) {
      await qi.createTable('DermProcedures', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        PatientId: patientFk(),
        procedureDate: { type: Sequelize.DATEONLY, allowNull: false },
        name: { type: Sequelize.STRING(120), allowNull: false },
        details: { type: Sequelize.TEXT, allowNull: true },
        performedById: userFk(),
        HistologyRequestId: {
          type: Sequelize.INTEGER, allowNull: true,
          references: { model: histology, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
        },
        status: { type: Sequelize.ENUM('active', 'entered_in_error'), allowNull: false, defaultValue: 'active' },
        errorReason: { type: Sequelize.STRING(500), allowNull: true },
        errorById: userFk(),
        errorAt: { type: Sequelize.DATE, allowNull: true },
        amendedById: userFk(),
        amendedAt: { type: Sequelize.DATE, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      await qi.addIndex('DermProcedures', ['PatientId', 'procedureDate'], { name: 'idx_derm_procedure_patient' });
      procedures = 'DermProcedures';
      console.log(`${TAG} DermProcedures created`);
    }

    if (!await findTable(qi, 'DermProcedureTargets')) {
      await qi.createTable('DermProcedureTargets', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        DermProcedureId: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: procedures, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        DermFindingId: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: findings, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
      });
      await qi.addIndex('DermProcedureTargets', ['DermProcedureId', 'DermFindingId'], { unique: true, name: 'unique_derm_procedure_target' });
      await qi.addIndex('DermProcedureTargets', ['DermFindingId'], { name: 'idx_derm_procedure_target_finding' });
      console.log(`${TAG} DermProcedureTargets created`);
    }

    // Widen DermEdits.entity (idempotent: only when 'procedure' is missing).
    const cols = await qi.describeTable(edits);
    if (cols.entity && !/procedure/i.test(String(cols.entity.type))) {
      await qi.changeColumn(edits, 'entity', {
        type: Sequelize.ENUM('finding', 'observation', 'procedure'), allowNull: false,
      });
      console.log(`${TAG} DermEdits.entity now includes 'procedure'`);
    }
  },

  async down(queryInterface, Sequelize) {
    const qi = queryInterface;
    for (const name of ['HistologyRequests', 'DermProcedures']) {
      const table = await findTable(qi, name);
      if (!table) continue;
      const n = await countRows(qi, table);
      if (n > 0) throw new Error(`${TAG} down refused: ${n} row(s) in ${name} (part of the medical record). Restore the database backup instead.`);
    }
    const edits = await findTable(qi, 'DermEdits');
    if (edits) {
      const n = await countRows(qi, edits, "WHERE entity = 'procedure'");
      if (n > 0) throw new Error(`${TAG} down refused: ${n} procedure amendment(s) in DermEdits. Restore the database backup instead.`);
      const cols = await qi.describeTable(edits);
      if (cols.entity && /procedure/i.test(String(cols.entity.type))) {
        await qi.changeColumn(edits, 'entity', { type: Sequelize.ENUM('finding', 'observation'), allowNull: false });
      }
    }
    for (const name of ['DermProcedureTargets', 'DermProcedures', 'HistologyEdits', 'HistologyRequests']) {
      const table = await findTable(qi, name);
      if (table) await qi.dropTable(table);
    }
    console.log(`${TAG} histology + procedure tables removed (they were empty)`);
  },
};
