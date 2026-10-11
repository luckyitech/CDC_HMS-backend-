'use strict';

// Dermatology Phase 1 + per-user preferences (7 Oct 2026).
//
//   UserPreferences     NEW — UserId, key, value (JSON TEXT). One row per user
//                       per key; first key 'consultation.tools' (which Today's
//                       Consultation tools a doctor shows / orders / keeps open).
//   DermFindings        NEW — a persistent skin finding: PatientId (canonical),
//                       number (per patient, never reused), type, title,
//                       exactSite, firstNoticed, concern, currentStatus,
//                       diagnosis, status active|resolved|entered_in_error
//                       (+ errorReason / errorById / errorAt), createdById.
//   DermFindingRegions  NEW — DermFindingId × region id (utils/dermRegions).
//   DermObservations    NEW — one per finding per clinic day: typed sizes (mm)
//                       + how measured, morphology, border, surface, colours,
//                       symptoms, description, diagnosis, differential, plan,
//                       planNote, reviewIn, doctorId (JWT), status
//                       active|entered_in_error, amendedById / amendedAt.
//   DermEdits           NEW — the amendment trail: entity finding|observation,
//                       entityId, action amend|entered_in_error, changes (JSON
//                       TEXT), reason, editedById, createdAt.
//
// The Dermatology module is OFF until an administrator switches it on
// (Setting 'modules.dermatology'); on CDC's server these tables stay empty.
// No existing table is altered.
//
// `down`: REFUSES once any skin finding exists (medical record — restore the
// backup instead) or once anyone has saved a preference (lossy). When both are
// empty it drops the five tables, children first. Guarded both ways; table
// names compared case-insensitively (the VDS returns them lowercase).

const TAG = '[20260928000021]';

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};

const countRows = async (qi, table) => {
  const [rows] = await qi.sequelize.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
  return Number(rows[0].n ?? rows[0].N ?? 0);
};

const STATUS_TODAY = ['new', 'improved', 'stable', 'worsened', 'resolved', 'recurrence'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;
    const users = await findTable(qi, 'Users') || 'Users';
    const patients = await findTable(qi, 'Patients') || 'Patients';
    const userFk = (allowNull = true) => ({
      type: Sequelize.INTEGER, allowNull,
      references: { model: users, key: 'id' }, onUpdate: 'CASCADE', onDelete: allowNull ? 'SET NULL' : 'CASCADE',
    });
    const stamps = {
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    };

    if (!await findTable(qi, 'UserPreferences')) {
      await qi.createTable('UserPreferences', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        UserId: userFk(false),
        key: { type: Sequelize.STRING(80), allowNull: false },
        value: { type: Sequelize.TEXT, allowNull: false },
        ...stamps,
      });
      await qi.addIndex('UserPreferences', ['UserId', 'key'], { name: 'uq_user_preference', unique: true });
      console.log(`${TAG} UserPreferences created`);
    }

    let findings = await findTable(qi, 'DermFindings');
    if (!findings) {
      await qi.createTable('DermFindings', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        PatientId: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: patients, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        number: { type: Sequelize.INTEGER, allowNull: false },
        type: { type: Sequelize.ENUM('lesion', 'rash', 'ulcer', 'scar', 'pigmentation', 'hair_loss', 'nail', 'other'), allowNull: false },
        title: { type: Sequelize.STRING(120), allowNull: false },
        exactSite: { type: Sequelize.STRING(200), allowNull: true },
        firstNoticed: { type: Sequelize.STRING(60), allowNull: true },
        concern: { type: Sequelize.TEXT, allowNull: true },
        currentStatus: { type: Sequelize.ENUM(...STATUS_TODAY), allowNull: false, defaultValue: 'new' },
        diagnosis: { type: Sequelize.STRING(200), allowNull: true },
        status: { type: Sequelize.ENUM('active', 'resolved', 'entered_in_error'), allowNull: false, defaultValue: 'active' },
        createdById: userFk(),
        errorReason: { type: Sequelize.STRING(500), allowNull: true },
        errorById: userFk(),
        errorAt: { type: Sequelize.DATE, allowNull: true },
        ...stamps,
      });
      await qi.addIndex('DermFindings', ['PatientId', 'number'], { name: 'idx_derm_finding_patient' });
      findings = 'DermFindings';
      console.log(`${TAG} DermFindings created`);
    }
    const findingFk = {
      type: Sequelize.INTEGER, allowNull: false,
      references: { model: findings, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
    };

    if (!await findTable(qi, 'DermFindingRegions')) {
      await qi.createTable('DermFindingRegions', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        DermFindingId: findingFk,
        region: { type: Sequelize.STRING(40), allowNull: false },
      });
      await qi.addIndex('DermFindingRegions', ['DermFindingId', 'region'], { name: 'uq_derm_finding_region', unique: true });
      console.log(`${TAG} DermFindingRegions created`);
    }

    if (!await findTable(qi, 'DermObservations')) {
      await qi.createTable('DermObservations', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        DermFindingId: findingFk,
        visitDate: { type: Sequelize.DATEONLY, allowNull: false },
        doctorId: userFk(),
        statusToday: { type: Sequelize.ENUM(...STATUS_TODAY), allowNull: false },
        lengthMm: { type: Sequelize.DECIMAL(6, 1), allowNull: true },
        widthMm: { type: Sequelize.DECIMAL(6, 1), allowNull: true },
        depthMm: { type: Sequelize.DECIMAL(6, 1), allowNull: true },
        measuredBy: { type: Sequelize.ENUM('ruler', 'dermatoscope', 'estimated'), allowNull: true },
        morphology: { type: Sequelize.STRING(20), allowNull: true },
        border: { type: Sequelize.STRING(20), allowNull: true },
        surface: { type: Sequelize.STRING(20), allowNull: true },
        colours: { type: Sequelize.STRING(200), allowNull: true },
        symptoms: { type: Sequelize.STRING(100), allowNull: true },
        description: { type: Sequelize.TEXT, allowNull: true },
        diagnosis: { type: Sequelize.STRING(200), allowNull: true },
        differential: { type: Sequelize.STRING(300), allowNull: true },
        plan: { type: Sequelize.STRING(20), allowNull: true },
        planNote: { type: Sequelize.TEXT, allowNull: true },
        reviewIn: { type: Sequelize.STRING(60), allowNull: true },
        status: { type: Sequelize.ENUM('active', 'entered_in_error'), allowNull: false, defaultValue: 'active' },
        amendedById: userFk(),
        amendedAt: { type: Sequelize.DATE, allowNull: true },
        ...stamps,
      });
      await qi.addIndex('DermObservations', ['DermFindingId', 'visitDate'], { name: 'uq_derm_observation_day', unique: true });
      console.log(`${TAG} DermObservations created`);
    }

    if (!await findTable(qi, 'DermEdits')) {
      await qi.createTable('DermEdits', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        entity: { type: Sequelize.ENUM('finding', 'observation'), allowNull: false },
        entityId: { type: Sequelize.INTEGER, allowNull: false },
        action: { type: Sequelize.ENUM('amend', 'entered_in_error'), allowNull: false },
        changes: { type: Sequelize.TEXT, allowNull: false },
        reason: { type: Sequelize.STRING(500), allowNull: false },
        editedById: userFk(),
        createdAt: { type: Sequelize.DATE, allowNull: false },
      });
      await qi.addIndex('DermEdits', ['entity', 'entityId'], { name: 'idx_derm_edit_entity' });
      console.log(`${TAG} DermEdits created`);
    }
  },

  async down(queryInterface) {
    const qi = queryInterface;
    const findings = await findTable(qi, 'DermFindings');
    if (findings) {
      const n = await countRows(qi, findings);
      if (n > 0) throw new Error(`${TAG} down refused: ${n} skin finding(s) exist (part of the medical record). Restore the database backup instead.`);
    }
    const prefs = await findTable(qi, 'UserPreferences');
    if (prefs) {
      const n = await countRows(qi, prefs);
      if (n > 0) throw new Error(`${TAG} down refused: ${n} saved user preference(s) would be lost. Restore the database backup instead.`);
    }
    for (const name of ['DermEdits', 'DermObservations', 'DermFindingRegions', 'DermFindings', 'UserPreferences']) {
      const table = await findTable(qi, name);
      if (table) await qi.dropTable(table);
    }
    console.log(`${TAG} dermatology + user preference tables removed (they were empty)`);
  },
};
