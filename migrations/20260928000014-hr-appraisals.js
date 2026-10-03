'use strict';

// HR Suite Tier 3 Phase 5 — appraisals (mockup E; T3-9 a: a yearly
// clinic-wide window, self-assessment then reviewer, four competencies rated
// 1–4 plus comments and objectives, the person acknowledges, competencies
// HR-editable; T3-10 a: read by the person, their reviewer and hr.appraisals
// holders — never by full admin access).
//
//   AppraisalCompetencies  NEW — the competencies (name, description,
//                          sortOrder, status active|archived). Seeded with the
//                          four starters (FROZEN below) only when empty.
//   AppraisalCycles        NEW — one per year (UNIQUE year): name, selfDueOn,
//                          reviewDueOn, status open|closed, closedAt/ById.
//   Appraisals             NEW — one person in a cycle: UserId, reviewerId,
//                          status self|review|sent|acknowledged|cancelled, the
//                          summaries, personComment, meetingOn, the dates.
//   AppraisalRatings       NEW — one competency on one appraisal (rows, so
//                          they can be reported on): name copied, selfRating,
//                          selfComment, reviewerRating, reviewerComment.
//   AppraisalObjectives    NEW — text, dueBy, status active|removed.
//
// Writes no staff data and changes nobody's access.
//
// `down`: REFUSES while any cycle or appraisal exists, or HR added or edited a
// competency. Otherwise drops the tables (children first). Guarded both ways;
// table names compared case-insensitively (the VDS returns them lowercase).

const TAG = '[20260928000014]';

// FROZEN copy of utils/appraisals STARTER_COMPETENCIES at the time of writing
// (tests/hrTier3Phase5 checks they match).
const STARTERS = [
  { name: 'Quality of work and patient safety', description: 'Accurate, careful, safe work; follows clinic protocols.' },
  { name: 'Teamwork and communication', description: 'Works well with colleagues and patients; shares information clearly.' },
  { name: 'Reliability and attendance', description: 'On time, dependable, follows through.' },
  { name: 'Learning and development', description: 'Keeps skills current; CPD; takes on feedback.' },
];

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};
const count = async (qi, table, where = '') => {
  const [rows] = await qi.sequelize.query(`SELECT COUNT(*) AS n FROM \`${table}\` ${where}`);
  return Number(rows[0].n ?? rows[0].N ?? 0);
};

module.exports = {
  _starters: STARTERS,
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;
    const users = await findTable(qi, 'Users') || 'Users';
    const userFk = (allowNull, onDelete) => ({
      type: Sequelize.INTEGER, allowNull, references: { model: users, key: 'id' }, onUpdate: 'CASCADE', onDelete,
    });
    const stamps = {
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    };

    if (!(await findTable(qi, 'AppraisalCompetencies'))) {
      await qi.createTable('AppraisalCompetencies', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        name: { type: Sequelize.STRING(120), allowNull: false },
        description: { type: Sequelize.STRING(300), allowNull: true },
        sortOrder: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        status: { type: Sequelize.ENUM('active', 'archived'), allowNull: false, defaultValue: 'active' },
        createdById: userFk(true, 'SET NULL'),
        ...stamps,
      });
      console.log(`${TAG} AppraisalCompetencies created`);
    }
    const comps = await findTable(qi, 'AppraisalCompetencies');
    if ((await count(qi, comps)) === 0) {
      const now = new Date();
      await qi.bulkInsert(comps, STARTERS.map((c, i) => ({
        name: c.name, description: c.description, sortOrder: (i + 1) * 10, status: 'active', createdById: null, createdAt: now, updatedAt: now,
      })));
      console.log(`${TAG} starter competencies: ${STARTERS.length} added`);
    }

    if (!(await findTable(qi, 'AppraisalCycles'))) {
      await qi.createTable('AppraisalCycles', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        year: { type: Sequelize.INTEGER, allowNull: false },
        name: { type: Sequelize.STRING(80), allowNull: false },
        selfDueOn: { type: Sequelize.DATEONLY, allowNull: true },
        reviewDueOn: { type: Sequelize.DATEONLY, allowNull: true },
        status: { type: Sequelize.ENUM('open', 'closed'), allowNull: false, defaultValue: 'open' },
        closedAt: { type: Sequelize.DATE, allowNull: true },
        closedById: userFk(true, 'SET NULL'),
        createdById: userFk(true, 'SET NULL'),
        ...stamps,
      });
      await qi.addIndex('AppraisalCycles', ['year'], { unique: true, name: 'uniq_appraisal_cycle_year' });
      console.log(`${TAG} AppraisalCycles created`);
    }

    if (!(await findTable(qi, 'Appraisals'))) {
      const cycles = await findTable(qi, 'AppraisalCycles');
      await qi.createTable('Appraisals', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        cycleId: { type: Sequelize.INTEGER, allowNull: false, references: { model: cycles, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        UserId: userFk(false, 'CASCADE'),
        reviewerId: userFk(true, 'SET NULL'),
        status: { type: Sequelize.ENUM('self', 'review', 'sent', 'acknowledged', 'cancelled'), allowNull: false, defaultValue: 'self' },
        selfSummary: { type: Sequelize.TEXT, allowNull: true },
        reviewerSummary: { type: Sequelize.TEXT, allowNull: true },
        personComment: { type: Sequelize.TEXT, allowNull: true },
        meetingOn: { type: Sequelize.DATEONLY, allowNull: true },
        selfSubmittedAt: { type: Sequelize.DATE, allowNull: true },
        sentAt: { type: Sequelize.DATE, allowNull: true },
        acknowledgedAt: { type: Sequelize.DATE, allowNull: true },
        cancelledNote: { type: Sequelize.STRING(300), allowNull: true },
        cancelledById: userFk(true, 'SET NULL'),
        createdById: userFk(true, 'SET NULL'),
        ...stamps,
      });
      await qi.addIndex('Appraisals', ['cycleId', 'UserId'], { name: 'idx_appraisal_cycle_user' });
      await qi.addIndex('Appraisals', ['reviewerId', 'status'], { name: 'idx_appraisal_reviewer' });
      await qi.addIndex('Appraisals', ['UserId', 'status'], { name: 'idx_appraisal_user' });
      console.log(`${TAG} Appraisals created`);
    }

    const appraisals = await findTable(qi, 'Appraisals');
    if (!(await findTable(qi, 'AppraisalRatings'))) {
      await qi.createTable('AppraisalRatings', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        appraisalId: { type: Sequelize.INTEGER, allowNull: false, references: { model: appraisals, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        competencyId: { type: Sequelize.INTEGER, allowNull: true, references: { model: comps, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
        name: { type: Sequelize.STRING(120), allowNull: false },
        sortOrder: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        selfRating: { type: Sequelize.TINYINT, allowNull: true },
        selfComment: { type: Sequelize.TEXT, allowNull: true },
        reviewerRating: { type: Sequelize.TINYINT, allowNull: true },
        reviewerComment: { type: Sequelize.TEXT, allowNull: true },
        ...stamps,
      });
      await qi.addIndex('AppraisalRatings', ['appraisalId'], { name: 'idx_appraisal_rating' });
      console.log(`${TAG} AppraisalRatings created`);
    }

    if (!(await findTable(qi, 'AppraisalObjectives'))) {
      await qi.createTable('AppraisalObjectives', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        appraisalId: { type: Sequelize.INTEGER, allowNull: false, references: { model: appraisals, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        text: { type: Sequelize.STRING(300), allowNull: false },
        dueBy: { type: Sequelize.DATEONLY, allowNull: true },
        sortOrder: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        status: { type: Sequelize.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
        addedById: userFk(true, 'SET NULL'),
        ...stamps,
      });
      await qi.addIndex('AppraisalObjectives', ['appraisalId', 'status'], { name: 'idx_appraisal_objective' });
      console.log(`${TAG} AppraisalObjectives created`);
    }
  },

  async down(queryInterface) {
    const qi = queryInterface;
    const objectives = await findTable(qi, 'AppraisalObjectives');
    const ratings = await findTable(qi, 'AppraisalRatings');
    const appraisals = await findTable(qi, 'Appraisals');
    const cycles = await findTable(qi, 'AppraisalCycles');
    const comps = await findTable(qi, 'AppraisalCompetencies');
    for (const [table, what] of [[appraisals, 'appraisal(s)'], [cycles, 'appraisal cycle(s)']]) {
      if (!table) continue;
      const n = await count(qi, table);
      if (n > 0) throw new Error(`${TAG} down refused: ${n} ${what} exist. Restore the database backup instead.`);
    }
    if (comps) {
      const n = await count(qi, comps, 'WHERE createdById IS NOT NULL OR updatedAt > createdAt');
      if (n > 0) throw new Error(`${TAG} down refused: HR added or edited ${n} competenc(ies). Restore the database backup instead.`);
    }
    for (const t of [objectives, ratings, appraisals, cycles, comps]) if (t) await qi.dropTable(t);
  },
};
