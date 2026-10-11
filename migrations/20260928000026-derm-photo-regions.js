'use strict';

// Dermatology — a photo attached to one or more areas (8 Oct 2026, Emu):
//
//   DermPhotoRegions   NEW — DermPhotoId × region id (utils/dermRegions); the
//                      areas a photo shows, each one of its finding's regions.
//                      No row = an overview of the whole finding (and every
//                      photo taken before this migration).
//
// Replaces an earlier draft (…025, a single DermPhotos.region column) that was
// only ever on a development machine: if that column exists, its values are
// copied in here and the column is removed.
//
// `down`: REFUSES once any photo is attached to an area (medical record —
// restore the backup instead); otherwise drops the empty table.

const TAG = '[20260928000026]';

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;
    const photos = await findTable(qi, 'DermPhotos');
    if (!photos) throw new Error(`${TAG} DermPhotos missing — run 20260928000022 first`);

    if (!await findTable(qi, 'DermPhotoRegions')) {
      await qi.createTable('DermPhotoRegions', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        DermPhotoId: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: photos, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        region: { type: Sequelize.STRING(40), allowNull: false },
      });
      await qi.addIndex('DermPhotoRegions', ['DermPhotoId', 'region'], { name: 'uq_derm_photo_region', unique: true });
      await qi.addIndex('DermPhotoRegions', ['region'], { name: 'idx_derm_photo_region' });
      console.log(`${TAG} DermPhotoRegions created`);
    }

    // Fold in the development-only DermPhotos.region column, if present.
    const cols = await qi.describeTable(photos);
    if (cols.region) {
      await qi.sequelize.query(
        `INSERT INTO DermPhotoRegions (DermPhotoId, region) SELECT id, region FROM \`${photos}\` WHERE region IS NOT NULL`,
      );
      await qi.removeColumn(photos, 'region');
      console.log(`${TAG} DermPhotos.region folded into DermPhotoRegions`);
    }
  },

  async down(queryInterface) {
    const qi = queryInterface;
    const table = await findTable(qi, 'DermPhotoRegions');
    if (!table) return;
    const [rows] = await qi.sequelize.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
    const n = Number(rows[0].n ?? rows[0].N ?? 0);
    if (n > 0) throw new Error(`${TAG} down refused: ${n} photo-area link(s) exist. Restore the database backup instead.`);
    await qi.dropTable(table);
    console.log(`${TAG} DermPhotoRegions dropped (it was empty)`);
  },
};
