'use strict';

// HR Suite Tier 3 Phase 3 — onboarding checklists (Emu, 3 Oct 2026: T3-4 = a
// template per role; O-1…O-8).
//
//   OnboardingTemplateItems  NEW — the template lines per role (doctor, nurse,
//                            lab, staff, admin): label, autoKey (a fact on the
//                            staff file that ticks it by itself) or NULL (HR
//                            ticks), dueDays, sortOrder, status active|archived.
//                            Seeded with the starter lines (utils/onboarding
//                            starterTemplate) ONLY when the table is empty.
//   OnboardingChecklists     NEW — one person's checklist (UserId, status
//                            open|complete|closed, role, startDate, completedAt,
//                            closedNote, createdById, closedById).
//   OnboardingItems          NEW — the lines of one checklist, copied from the
//                            template or added by HR (status active|removed).
//
// Writes no staff data and changes nobody's access: checklists start when the
// wizard creates an account, or when HR presses "Start" on a staff file.
//
// `down`: REFUSES while any checklist exists, or while a template line was
// edited or added by HR (createdById set or updatedAt later than createdAt).
// Otherwise drops the three tables (items first). Guarded both ways; table
// names compared case-insensitively (the VDS returns them lowercase).

const TAG = '[20260928000012]';

// The starter lines, FROZEN here (a migration must not change meaning if
// utils/onboarding is edited later). Kept in step with utils/onboarding
// starterTemplate at the time of writing; tests/hrTier3Phase3 checks they match.
const ROLES = ['doctor', 'nurse', 'lab', 'staff', 'admin'];
const CLINICAL = ['doctor', 'nurse', 'lab'];
const starterTemplate = (role) => [
  ['Employment contract on file', 'contract', 7],
  ['National ID copy on file', 'national_id', 7],
  ...(CLINICAL.includes(role) ? [['Practising licence with expiry date', 'licence', 7]] : []),
  ['Department and position set', 'department', 1],
  ['Permissions set', 'permissions', 1],
  ['Has logged in to the HMS', 'first_login', 3],
  ['Photo on file', 'photo', 14],
  ['Phone registered for check-in', 'phone', 7],
  ['Clinic orientation done', null, 7],
  ['Fire and safety briefing', null, 14],
  ['Confidentiality agreement signed', null, 7],
  ['Uniform and ID badge issued', null, 14],
].map(([label, autoKey, dueDays], i) => ({ label, autoKey, dueDays, sortOrder: (i + 1) * 10 }));

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
  _starterTemplate: starterTemplate,
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

    if (!(await findTable(qi, 'OnboardingTemplateItems'))) {
      await qi.createTable('OnboardingTemplateItems', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        role: { type: Sequelize.ENUM('doctor', 'nurse', 'lab', 'staff', 'admin'), allowNull: false },
        label: { type: Sequelize.STRING(160), allowNull: false },
        autoKey: { type: Sequelize.STRING(40), allowNull: true, defaultValue: null },
        dueDays: { type: Sequelize.INTEGER, allowNull: true, defaultValue: null },
        sortOrder: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        status: { type: Sequelize.ENUM('active', 'archived'), allowNull: false, defaultValue: 'active' },
        createdById: userFk(true, 'SET NULL'),
        ...stamps,
      });
      await qi.addIndex('OnboardingTemplateItems', ['role', 'status', 'sortOrder'], { name: 'idx_onb_template_role' });
      console.log(`${TAG} OnboardingTemplateItems created`);
    }
    const templates = await findTable(qi, 'OnboardingTemplateItems');
    if ((await count(qi, templates)) === 0) {
      const now = new Date();
      const rows = ROLES.flatMap((role) => starterTemplate(role).map((x) => ({
        role, label: x.label, autoKey: x.autoKey, dueDays: x.dueDays, sortOrder: x.sortOrder,
        status: 'active', createdById: null, createdAt: now, updatedAt: now,
      })));
      await qi.bulkInsert(templates, rows);
      console.log(`${TAG} starter templates: ${rows.length} lines added for ${ROLES.length} roles`);
    }

    if (!(await findTable(qi, 'OnboardingChecklists'))) {
      await qi.createTable('OnboardingChecklists', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        UserId: userFk(false, 'CASCADE'),
        status: { type: Sequelize.ENUM('open', 'complete', 'closed'), allowNull: false, defaultValue: 'open' },
        role: { type: Sequelize.STRING(20), allowNull: true },
        startDate: { type: Sequelize.DATEONLY, allowNull: true },
        completedAt: { type: Sequelize.DATE, allowNull: true },
        closedNote: { type: Sequelize.STRING(500), allowNull: true },
        createdById: userFk(true, 'SET NULL'),
        closedById: userFk(true, 'SET NULL'),
        ...stamps,
      });
      await qi.addIndex('OnboardingChecklists', ['UserId', 'status'], { name: 'idx_onb_checklist_user' });
      await qi.addIndex('OnboardingChecklists', ['status'], { name: 'idx_onb_checklist_status' });
      console.log(`${TAG} OnboardingChecklists created`);
    }

    if (!(await findTable(qi, 'OnboardingItems'))) {
      const checklists = await findTable(qi, 'OnboardingChecklists');
      await qi.createTable('OnboardingItems', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        checklistId: { type: Sequelize.INTEGER, allowNull: false, references: { model: checklists, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        label: { type: Sequelize.STRING(160), allowNull: false },
        autoKey: { type: Sequelize.STRING(40), allowNull: true, defaultValue: null },
        dueDate: { type: Sequelize.DATEONLY, allowNull: true },
        sortOrder: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        doneAt: { type: Sequelize.DATE, allowNull: true },
        doneById: userFk(true, 'SET NULL'),
        note: { type: Sequelize.STRING(500), allowNull: true },
        status: { type: Sequelize.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
        addedById: userFk(true, 'SET NULL'),
        ...stamps,
      });
      await qi.addIndex('OnboardingItems', ['checklistId', 'status', 'sortOrder'], { name: 'idx_onb_item_checklist' });
      console.log(`${TAG} OnboardingItems created`);
    }
  },

  async down(queryInterface) {
    const qi = queryInterface;
    const items = await findTable(qi, 'OnboardingItems');
    const checklists = await findTable(qi, 'OnboardingChecklists');
    const templates = await findTable(qi, 'OnboardingTemplateItems');

    if (checklists) {
      const n = await count(qi, checklists);
      if (n > 0) throw new Error(`${TAG} down refused: ${n} onboarding checklist(s) exist. Restore the database backup instead.`);
    }
    if (templates) {
      const n = await count(qi, templates, 'WHERE createdById IS NOT NULL OR updatedAt > createdAt');
      if (n > 0) throw new Error(`${TAG} down refused: HR added or edited ${n} template line(s). Restore the database backup instead.`);
    }
    if (items) await qi.dropTable(items);
    if (checklists) await qi.dropTable(checklists);
    if (templates) await qi.dropTable(templates);
  },
};
