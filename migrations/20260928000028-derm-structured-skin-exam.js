'use strict';

// Dermatology — the structured skin examination (9 Oct 2026, Emu; plan
// claude/session-2026-10-09-derm-structured-skin-exam-plan.md, S1–S14).
//
//   DermObservations  NEW columns (one per field — reportable, never JSON):
//                     size range, primary lesion (distribution, symmetry,
//                     pattern, configuration), shape, texture, secondary
//                     changes, quantification, dermoscopy (+ its switch).
//                     WIDENED: border / surface become lists (VARCHAR 300);
//                     morphology / colours / symptoms to VARCHAR 300; plan to
//                     VARCHAR 60 — every choice field also takes a typed word.
//                     Old looks: morphology "erosion" / "ulcer" move to the new
//                     Erosion / Ulceration fields ("present"); the old
//                     placeholder word "other" is dropped from morphology.
//   DermSkinExams     NEW — "Today's whole-skin exam": hair, nails, lymph
//                     nodes, mucosa; one per patient per clinic day.
//   DermEdits.entity  gains 'skin_exam' (amendments to it are kept there).
//
// `down`: REFUSES once a whole-skin exam exists or any look uses a new field
// (medical record — restore the backup instead).

const TAG = '[20260928000028]';

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};
const count = async (qi, sql) => {
  const [rows] = await qi.sequelize.query(sql);
  return Number(rows[0].n ?? rows[0].N ?? 0);
};

const ONE = 60;
const MANY = 300;
// [column, kind] — kind: one | many | mm | int | pct | flag
const NEW_COLUMNS = [
  ['sizeMinMm', 'mm'], ['sizeMaxMm', 'mm'],
  ['distribution', 'one'], ['symmetry', 'one'], ['pattern', 'many'], ['configuration', 'many'],
  ['shape', 'one'], ['texture', 'one'],
  ['scale', 'one'], ['crust', 'one'], ['erosion', 'one'], ['ulceration', 'one'], ['ulcerBase', 'one'],
  ['excoriation', 'one'], ['lichenification', 'one'], ['atrophy', 'one'], ['scarring', 'one'],
  ['lesionCount', 'int'], ['lesionCountKind', 'one'], ['bsaPercent', 'pct'],
  ['dermoscopy', 'flag'], ['dsGlobal', 'one'], ['dsNetwork', 'one'], ['dsDots', 'one'], ['dsStreaks', 'one'],
  ['dsBlueWhite', 'one'], ['dsVascular', 'many'], ['dsRegression', 'one'], ['dsOther', 'many'],
];
const WIDEN = [['morphology', MANY, 200], ['colours', MANY, 200], ['symptoms', MANY, 100], ['border', MANY, 20], ['surface', MANY, 20], ['plan', ONE, 20]];

const typeFor = (Sequelize, kind) => ({
  one: { type: Sequelize.STRING(ONE), allowNull: true },
  many: { type: Sequelize.STRING(MANY), allowNull: true },
  mm: { type: Sequelize.DECIMAL(6, 1), allowNull: true },
  int: { type: Sequelize.INTEGER, allowNull: true },
  pct: { type: Sequelize.DECIMAL(4, 1), allowNull: true },
  flag: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
}[kind]);

const EDIT_ENTITIES = ['finding', 'observation', 'procedure'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;
    const observations = await findTable(qi, 'DermObservations');
    const edits = await findTable(qi, 'DermEdits');
    const patients = await findTable(qi, 'Patients') || 'Patients';
    const users = await findTable(qi, 'Users') || 'Users';
    if (!observations || !edits) throw new Error(`${TAG} DermObservations / DermEdits missing — run 20260928000021 first`);

    // 1 · new look columns
    const cols = await qi.describeTable(observations);
    let added = 0;
    for (const [name, kind] of NEW_COLUMNS) {
      if (cols[name]) continue;
      await qi.addColumn(observations, name, typeFor(Sequelize, kind));
      added += 1;
    }
    if (added) console.log(`${TAG} DermObservations: ${added} examination column(s) added`);

    // 2 · choice columns widened to lists / typed words
    const after = await qi.describeTable(observations);
    for (const [name, size] of WIDEN) {
      if (!after[name]) continue;
      const m = /\((\d+)\)/.exec(String(after[name].type));
      if (m && Number(m[1]) >= size) continue;
      await qi.changeColumn(observations, name, { type: Sequelize.STRING(size), allowNull: true });
      console.log(`${TAG} DermObservations.${name} widened to VARCHAR(${size})`);
    }

    // 3 · old morphology words that are now secondary changes
    const [rows] = await qi.sequelize.query(
      `SELECT id, morphology, erosion, ulceration FROM \`${observations}\` WHERE morphology LIKE '%erosion%' OR morphology LIKE '%ulcer%' OR morphology LIKE '%other%'`,
    );
    let moved = 0;
    for (const r of rows) {
      const list = String(r.morphology || '').split(',').filter(Boolean);
      const keep = list.filter((x) => !['erosion', 'ulcer', 'other'].includes(x));
      if (keep.length === list.length) continue;
      await qi.sequelize.query(
        `UPDATE \`${observations}\` SET morphology = :m, erosion = :e, ulceration = :u WHERE id = :id`,
        { replacements: {
          id: r.id, m: keep.length ? keep.join(',') : null,
          e: list.includes('erosion') ? 'present' : r.erosion, u: list.includes('ulcer') ? 'present' : r.ulceration,
        } },
      );
      moved += 1;
    }
    if (moved) console.log(`${TAG} ${moved} look(s): erosion / ulcer moved from morphology to secondary changes`);

    // 4 · DermEdits may record amendments to a whole-skin exam
    const eCols = await qi.describeTable(edits);
    if (eCols.entity && !/skin_exam/.test(String(eCols.entity.type))) {
      await qi.changeColumn(edits, 'entity', { type: Sequelize.ENUM(...EDIT_ENTITIES, 'skin_exam'), allowNull: false });
      console.log(`${TAG} DermEdits.entity accepts 'skin_exam'`);
    }

    // 5 · Today's whole-skin exam
    if (!(await findTable(qi, 'DermSkinExams'))) {
      const one = () => ({ type: Sequelize.STRING(ONE), allowNull: true });
      const many = () => ({ type: Sequelize.STRING(MANY), allowNull: true });
      const text = () => ({ type: Sequelize.TEXT, allowNull: true });
      const flag = () => ({ type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false });
      await qi.createTable('DermSkinExams', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        PatientId: { type: Sequelize.INTEGER, allowNull: false, references: { model: patients, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        visitDate: { type: Sequelize.DATEONLY, allowNull: false },
        doctorId: { type: Sequelize.INTEGER, allowNull: true, references: { model: users, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
        hairExamined: flag(),
        scalp: text(), hairDensity: one(), hairDensityPattern: many(), hairCalibre: one(), pullTest: one(),
        pullTestSite: { type: Sequelize.STRING(100), allowNull: true }, pullTestCount: { type: Sequelize.INTEGER, allowNull: true },
        exclamationHairs: one(), brokenHairs: one(),
        nailsExamined: flag(),
        nailsAffected: many(), nailPlate: many(), nailBed: many(), periungual: many(),
        nodesExamined: flag(),
        lymphadenopathy: one(), nodesNote: text(),
        mucosaExamined: flag(),
        oral: one(), oralNote: text(), genital: one(), genitalNote: text(),
        notes: text(),
        status: { type: Sequelize.ENUM('active', 'entered_in_error'), allowNull: false, defaultValue: 'active' },
        amendedById: { type: Sequelize.INTEGER, allowNull: true, references: { model: users, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
        amendedAt: { type: Sequelize.DATE, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      await qi.addIndex('DermSkinExams', ['PatientId', 'visitDate'], { unique: true, name: 'uq_derm_skin_exam_day' });
      console.log(`${TAG} DermSkinExams created`);
    }
  },

  async down(queryInterface, Sequelize) {
    const qi = queryInterface;
    const observations = await findTable(qi, 'DermObservations');
    const edits = await findTable(qi, 'DermEdits');
    const exams = await findTable(qi, 'DermSkinExams');

    if (exams) {
      const n = await count(qi, `SELECT COUNT(*) AS n FROM \`${exams}\``);
      if (n > 0) throw new Error(`${TAG} down refused: ${n} whole-skin exam(s) recorded (medical record). Restore the database backup instead.`);
    }
    if (observations) {
      const cols = await qi.describeTable(observations);
      const used = NEW_COLUMNS.filter(([name]) => cols[name]).map(([name, kind]) => (kind === 'flag' ? `\`${name}\` = 1` : `\`${name}\` IS NOT NULL`));
      if (used.length) {
        const n = await count(qi, `SELECT COUNT(*) AS n FROM \`${observations}\` WHERE ${used.join(' OR ')}`);
        if (n > 0) throw new Error(`${TAG} down refused: ${n} look(s) use the structured examination (medical record). Restore the database backup instead.`);
      }
      const long = WIDEN.filter(([name]) => cols[name]).map(([name, , old]) => `CHAR_LENGTH(\`${name}\`) > ${old}`);
      const n = await count(qi, `SELECT COUNT(*) AS n FROM \`${observations}\` WHERE ${long.join(' OR ')}`);
      if (n > 0) throw new Error(`${TAG} down refused: ${n} look(s) hold lists or typed words longer than the old columns. Restore the database backup instead.`);
    }
    if (edits) {
      const n = await count(qi, `SELECT COUNT(*) AS n FROM \`${edits}\` WHERE entity = 'skin_exam'`);
      if (n > 0) throw new Error(`${TAG} down refused: ${n} whole-skin exam amendment(s) recorded. Restore the database backup instead.`);
    }

    if (exams) await qi.dropTable(exams);
    if (edits) await qi.changeColumn(edits, 'entity', { type: Sequelize.ENUM(...EDIT_ENTITIES), allowNull: false });
    if (observations) {
      const cols = await qi.describeTable(observations);
      for (const [name] of NEW_COLUMNS) if (cols[name]) await qi.removeColumn(observations, name);
      for (const [name, , old] of WIDEN) if (cols[name]) await qi.changeColumn(observations, name, { type: Sequelize.STRING(old), allowNull: true });
    }
    console.log(`${TAG} reverted (nothing used the structured examination)`);
  },
};
