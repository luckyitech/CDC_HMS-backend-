'use strict';

// Dermatology — photos without a finding, and taking them on a phone
// (8 Oct 2026, Emu):
//
//   DermPhotos.DermFindingId   now NULLABLE — a photo may be an "area photo"
//                              (attached to body areas, not yet to a finding).
//   DermPhotos.PatientId       NEW — the canonical patient (backfilled from the
//                              finding for every existing photo).
//   DermPhotos.captureSessionId NEW — set when the photo came from a phone.
//   DermCaptureSessions        NEW — one QR hand-off: a hashed one-time token,
//                              the patient, the areas, the finding (when one is
//                              being recorded), the doctor who opened it, a
//                              10-minute expiry, the phone it was first opened
//                              on (hashed key), and how many photos arrived.
//
// `down`: REFUSES once any photo has no finding or any capture session exists
// (medical record — restore the backup instead).

const TAG = '[20260928000027]';

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};
const count = async (qi, sql) => {
  const [rows] = await qi.sequelize.query(sql);
  return Number(rows[0].n ?? rows[0].N ?? 0);
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;
    const photos = await findTable(qi, 'DermPhotos');
    const findings = await findTable(qi, 'DermFindings');
    const patients = await findTable(qi, 'Patients') || 'Patients';
    const users = await findTable(qi, 'Users') || 'Users';
    if (!photos || !findings) throw new Error(`${TAG} DermPhotos / DermFindings missing — run 20260928000022 first`);

    const cols = await qi.describeTable(photos);
    if (cols.DermFindingId && cols.DermFindingId.allowNull === false) {
      // MODIFY keeps the foreign key; only the NOT NULL goes.
      await qi.sequelize.query(`ALTER TABLE \`${photos}\` MODIFY \`DermFindingId\` INT NULL`);
      console.log(`${TAG} DermPhotos.DermFindingId may now be empty (area photos)`);
    }
    if (!cols.PatientId) {
      await qi.addColumn(photos, 'PatientId', {
        type: Sequelize.INTEGER, allowNull: true,
        references: { model: patients, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      });
      await qi.sequelize.query(
        `UPDATE \`${photos}\` p JOIN \`${findings}\` f ON f.id = p.DermFindingId SET p.PatientId = f.PatientId WHERE p.PatientId IS NULL`,
      );
      await qi.addIndex(photos, ['PatientId'], { name: 'idx_derm_photo_patient' });
      console.log(`${TAG} DermPhotos.PatientId added and filled from each photo's finding`);
    }
    if (!cols.captureSessionId) {
      await qi.addColumn(photos, 'captureSessionId', { type: Sequelize.INTEGER, allowNull: true });
      console.log(`${TAG} DermPhotos.captureSessionId added`);
    }

    if (!await findTable(qi, 'DermCaptureSessions')) {
      await qi.createTable('DermCaptureSessions', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        tokenHash: { type: Sequelize.CHAR(64), allowNull: false },
        deviceKeyHash: { type: Sequelize.CHAR(64), allowNull: true },
        PatientId: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: patients, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        doctorId: {
          type: Sequelize.INTEGER, allowNull: true,
          references: { model: users, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
        },
        DermFindingId: {
          type: Sequelize.INTEGER, allowNull: true,
          references: { model: findings, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
        },
        purpose: { type: Sequelize.ENUM('finding', 'photos'), allowNull: false, defaultValue: 'photos' },
        regions: { type: Sequelize.STRING(1000), allowNull: true },
        expiresAt: { type: Sequelize.DATE, allowNull: false },
        openedAt: { type: Sequelize.DATE, allowNull: true },
        closedAt: { type: Sequelize.DATE, allowNull: true },
        photoCount: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      await qi.addIndex('DermCaptureSessions', ['tokenHash'], { name: 'uq_derm_capture_token', unique: true });
      console.log(`${TAG} DermCaptureSessions created`);
    }
  },

  async down(queryInterface) {
    const qi = queryInterface;
    const photos = await findTable(qi, 'DermPhotos');
    const sessions = await findTable(qi, 'DermCaptureSessions');
    if (photos) {
      const n = await count(qi, `SELECT COUNT(*) AS n FROM \`${photos}\` WHERE DermFindingId IS NULL`);
      if (n > 0) throw new Error(`${TAG} down refused: ${n} area photo(s) have no finding. Restore the database backup instead.`);
    }
    if (sessions) {
      const n = await count(qi, `SELECT COUNT(*) AS n FROM \`${sessions}\``);
      if (n > 0) throw new Error(`${TAG} down refused: ${n} phone capture session(s) exist. Restore the database backup instead.`);
      await qi.dropTable(sessions);
    }
    if (photos) {
      const cols = await qi.describeTable(photos);
      if (cols.captureSessionId) await qi.removeColumn(photos, 'captureSessionId');
      if (cols.PatientId) {
        try { await qi.removeIndex(photos, 'idx_derm_photo_patient'); } catch { /* already gone */ }
        await qi.removeColumn(photos, 'PatientId');
      }
      await qi.sequelize.query(`ALTER TABLE \`${photos}\` MODIFY \`DermFindingId\` INT NOT NULL`);
    }
    console.log(`${TAG} reverted (nothing used it)`);
  },
};
