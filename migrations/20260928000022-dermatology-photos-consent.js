'use strict';

// Dermatology Phase 2 — photos and photography consent (7 Oct 2026).
//
//   DermConsents    NEW — append-only: PatientId (canonical), clinical (bool),
//                   teaching (bool), note, recordedById (JWT), createdAt. The
//                   newest row across the merge family is the current answer.
//   DermPhotos      NEW — DermFindingId, DermObservationId (that day's look,
//                   nullable), visitDate, photoType overview|close_up|
//                   dermoscopy, fileName (random name in private/derm-photos/),
//                   sizeBytes, width, height, marker (JSON TEXT ellipse),
//                   sensitive, uploadedById, status active|entered_in_error
//                   (+ errorReason / errorById / errorAt).
//   DermPhotoViews  NEW — DermPhotoId, viewedById, createdAt: every opening.
//
// Files are not touched by this migration (it creates no folder; the upload
// route creates private/derm-photos/ on first use).
//
// `down`: REFUSES once any photo or consent exists (medical record — restore
// the backup instead). When empty it drops the three tables, children first.

const TAG = '[20260928000022]';

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};

const countRows = async (qi, table) => {
  const [rows] = await qi.sequelize.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
  return Number(rows[0].n ?? rows[0].N ?? 0);
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;
    const users = await findTable(qi, 'Users') || 'Users';
    const patients = await findTable(qi, 'Patients') || 'Patients';
    const findings = await findTable(qi, 'DermFindings');
    const observations = await findTable(qi, 'DermObservations');
    if (!findings || !observations) throw new Error(`${TAG} DermFindings / DermObservations missing — run 20260928000021 first`);
    const userFk = () => ({
      type: Sequelize.INTEGER, allowNull: true,
      references: { model: users, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
    });

    if (!await findTable(qi, 'DermConsents')) {
      await qi.createTable('DermConsents', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        PatientId: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: patients, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        clinical: { type: Sequelize.BOOLEAN, allowNull: false },
        teaching: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        note: { type: Sequelize.STRING(500), allowNull: true },
        recordedById: userFk(),
        createdAt: { type: Sequelize.DATE, allowNull: false },
      });
      await qi.addIndex('DermConsents', ['PatientId', 'createdAt'], { name: 'idx_derm_consent_patient' });
      console.log(`${TAG} DermConsents created`);
    }

    let photos = await findTable(qi, 'DermPhotos');
    if (!photos) {
      await qi.createTable('DermPhotos', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        DermFindingId: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: findings, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        DermObservationId: {
          type: Sequelize.INTEGER, allowNull: true,
          references: { model: observations, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
        },
        visitDate: { type: Sequelize.DATEONLY, allowNull: false },
        photoType: { type: Sequelize.ENUM('overview', 'close_up', 'dermoscopy'), allowNull: false, defaultValue: 'close_up' },
        fileName: { type: Sequelize.STRING(80), allowNull: false },
        sizeBytes: { type: Sequelize.INTEGER, allowNull: true },
        width: { type: Sequelize.INTEGER, allowNull: true },
        height: { type: Sequelize.INTEGER, allowNull: true },
        marker: { type: Sequelize.STRING(200), allowNull: true },
        sensitive: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        uploadedById: userFk(),
        status: { type: Sequelize.ENUM('active', 'entered_in_error'), allowNull: false, defaultValue: 'active' },
        errorReason: { type: Sequelize.STRING(500), allowNull: true },
        errorById: userFk(),
        errorAt: { type: Sequelize.DATE, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      await qi.addIndex('DermPhotos', ['DermFindingId', 'visitDate'], { name: 'idx_derm_photo_finding' });
      photos = 'DermPhotos';
      console.log(`${TAG} DermPhotos created`);
    }

    if (!await findTable(qi, 'DermPhotoViews')) {
      await qi.createTable('DermPhotoViews', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        DermPhotoId: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: photos, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        viewedById: userFk(),
        createdAt: { type: Sequelize.DATE, allowNull: false },
      });
      await qi.addIndex('DermPhotoViews', ['DermPhotoId', 'createdAt'], { name: 'idx_derm_photo_view' });
      console.log(`${TAG} DermPhotoViews created`);
    }
  },

  async down(queryInterface) {
    const qi = queryInterface;
    for (const name of ['DermPhotos', 'DermConsents']) {
      const table = await findTable(qi, name);
      if (!table) continue;
      const n = await countRows(qi, table);
      if (n > 0) throw new Error(`${TAG} down refused: ${n} row(s) in ${name} (part of the medical record). Restore the database backup instead.`);
    }
    for (const name of ['DermPhotoViews', 'DermPhotos', 'DermConsents']) {
      const table = await findTable(qi, name);
      if (table) await qi.dropTable(table);
    }
    console.log(`${TAG} dermatology photo + consent tables removed (they were empty)`);
  },
};
