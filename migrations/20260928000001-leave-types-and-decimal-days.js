'use strict';

// B27 phase 0 (1 of 6) — leave types become data; days become decimals.
// Spec: claude/hr-leave-and-my-profile-build-spec.md §3.1–3.2, §3.4.
//
//   LeaveTypes      NEW. The list of leave types, seeded with the seven the
//                   ENUM held (isSystem — these can't be retired, so every old
//                   row stays valid). HR adds more later.
//   StaffLeaves     leaveType ENUM → VARCHAR(40) (a LeaveTypes.key)
//                   days INTEGER → DECIMAL(6,2) (half days, ½ Saturdays)
//                   status ENUM widened: + InfoRequested, Withdrawn, CancelRequested
//                   + startPart, endPart, returnDate, reachable, contactNote,
//                     submittedAt, policyYear, breakdown (calculator snapshot —
//                     display only), attachmentDocumentId (→ StaffDocuments),
//                     onBehalf (recorded by HR)
//   LeaveBalances   now the per-person OVERRIDE row: leaveType → VARCHAR(40);
//                   entitled / carriedOver → DECIMAL(6,2) NULL (null = use the
//                   policy); + reason, weekOverride. Existing rows are kept and
//                   become overrides, reason 'Set before leave policy (migrated)'.
//
// Guarded both ways. `down` REFUSES (throws) rather than truncating when the
// data no longer fits the old shape: a leave type outside the old seven, a
// status outside the old four, or a fractional number of days. Null override
// entitlements (only new code writes them) go back to 0 — the old schema had
// no "use the policy" value.
//
// NB: on the VDS MySQL stores table names in lowercase (Windows,
// lower_case_table_names=1) — every name check here is case-insensitive.

const OLD_TYPES = ['Annual', 'Sick', 'Maternity', 'Paternity', 'Compassionate', 'Study', 'Unpaid'];
const OLD_STATUSES = ['Pending', 'Approved', 'Rejected', 'Cancelled'];
const NEW_STATUSES = ['Pending', 'InfoRequested', 'Approved', 'Rejected', 'Withdrawn', 'CancelRequested', 'Cancelled'];

const SYSTEM_TYPES = [
  { key: 'Annual',        name: 'Annual',        sortOrder: 1 },
  { key: 'Sick',          name: 'Sick',          sortOrder: 2 },
  { key: 'Maternity',     name: 'Maternity',     sortOrder: 3 },
  { key: 'Paternity',     name: 'Paternity',     sortOrder: 4 },
  { key: 'Compassionate', name: 'Compassionate', sortOrder: 5 },
  { key: 'Study',         name: 'Study / CPD',   sortOrder: 6 },
  { key: 'Unpaid',        name: 'Unpaid',        sortOrder: 7 },
];

const MIGRATED_REASON = 'Set before leave policy (migrated)';

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  const hit = tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase());
  return hit || null;
};

const enumValues = (column) => {
  const m = String(column && column.type ? column.type : '').match(/^ENUM\((.*)\)$/i);
  return m ? m[1].split(',').map((v) => v.trim().replace(/^'|'$/g, '')) : [];
};
const isType = (column, re) => re.test(String(column && column.type ? column.type : ''));

module.exports = {
  async up(queryInterface, Sequelize) {
    // ---- LeaveTypes ----
    if (!(await findTable(queryInterface, 'LeaveTypes'))) {
      await queryInterface.createTable('LeaveTypes', {
        id:        { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        key:       { type: Sequelize.STRING(40), allowNull: false },
        name:      { type: Sequelize.STRING(80), allowNull: false },
        sortOrder: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        isSystem:  { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        status:    { type: Sequelize.ENUM('active', 'retired'), allowNull: false, defaultValue: 'active' },
        createdBy: { type: Sequelize.INTEGER, allowNull: true },
        updatedBy: { type: Sequelize.INTEGER, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex('LeaveTypes', ['key'], { name: 'leave_types_key_unique', unique: true });
    }
    const typesTable = await findTable(queryInterface, 'LeaveTypes');
    const [existingTypes] = await queryInterface.sequelize.query(`SELECT \`key\` FROM ${typesTable}`);
    const have = new Set(existingTypes.map((r) => r.key));
    const now = new Date();
    const toSeed = SYSTEM_TYPES.filter((t) => !have.has(t.key))
      .map((t) => ({ ...t, isSystem: true, status: 'active', createdAt: now, updatedAt: now }));
    if (toSeed.length) await queryInterface.bulkInsert(typesTable, toSeed);

    // ---- StaffLeaves ----
    const leaves = await findTable(queryInterface, 'StaffLeaves');
    if (leaves) {
      const cols = await queryInterface.describeTable(leaves);
      if (isType(cols.leaveType, /^ENUM/i)) {
        await queryInterface.changeColumn(leaves, 'leaveType', { type: Sequelize.STRING(40), allowNull: false });
      }
      if (isType(cols.days, /^INT/i)) {
        await queryInterface.changeColumn(leaves, 'days', { type: Sequelize.DECIMAL(6, 2), allowNull: false });
      }
      if (!NEW_STATUSES.every((s) => enumValues(cols.status).includes(s))) {
        await queryInterface.changeColumn(leaves, 'status', {
          type: Sequelize.ENUM(...NEW_STATUSES), allowNull: false, defaultValue: 'Pending',
        });
      }
      const add = {
        startPart:   { type: Sequelize.ENUM('full', 'pm'), allowNull: false, defaultValue: 'full' },
        endPart:     { type: Sequelize.ENUM('full', 'am'), allowNull: false, defaultValue: 'full' },
        returnDate:  { type: Sequelize.DATEONLY, allowNull: true },
        reachable:   { type: Sequelize.BOOLEAN, allowNull: true },
        contactNote: { type: Sequelize.STRING(255), allowNull: true },
        submittedAt: { type: Sequelize.DATE, allowNull: true },
        policyYear:  { type: Sequelize.INTEGER, allowNull: true },
        breakdown:   { type: Sequelize.JSON, allowNull: true },
        attachmentDocumentId: {
          type: Sequelize.INTEGER, allowNull: true,
          references: { model: 'StaffDocuments', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
        },
        onBehalf:    { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      };
      for (const [name, spec] of Object.entries(add)) {
        if (!cols[name]) await queryInterface.addColumn(leaves, name, spec);
      }
    }

    // ---- LeaveBalances → per-person overrides ----
    const balances = await findTable(queryInterface, 'LeaveBalances');
    if (balances) {
      const cols = await queryInterface.describeTable(balances);
      if (isType(cols.leaveType, /^ENUM/i)) {
        await queryInterface.changeColumn(balances, 'leaveType', { type: Sequelize.STRING(40), allowNull: false });
      }
      if (isType(cols.entitled, /^INT/i) || cols.entitled.allowNull === false) {
        await queryInterface.changeColumn(balances, 'entitled', { type: Sequelize.DECIMAL(6, 2), allowNull: true, defaultValue: null });
      }
      if (isType(cols.carriedOver, /^INT/i) || cols.carriedOver.allowNull === false) {
        await queryInterface.changeColumn(balances, 'carriedOver', { type: Sequelize.DECIMAL(6, 2), allowNull: true, defaultValue: null });
      }
      if (!cols.reason) {
        await queryInterface.addColumn(balances, 'reason', { type: Sequelize.TEXT, allowNull: true });
        await queryInterface.sequelize.query(
          `UPDATE ${balances} SET reason = :reason WHERE reason IS NULL`,
          { replacements: { reason: MIGRATED_REASON } }
        );
      }
      if (!cols.weekOverride) {
        await queryInterface.addColumn(balances, 'weekOverride', { type: Sequelize.JSON, allowNull: true });
      }
    }
  },

  async down(queryInterface, Sequelize) {
    const leaves = await findTable(queryInterface, 'StaffLeaves');
    const balances = await findTable(queryInterface, 'LeaveBalances');

    // Refuse before touching anything if the data can't go back losslessly.
    if (leaves) {
      const [badType] = await queryInterface.sequelize.query(
        `SELECT COUNT(*) AS n FROM ${leaves} WHERE leaveType NOT IN (:types)`, { replacements: { types: OLD_TYPES } });
      const [badStatus] = await queryInterface.sequelize.query(
        `SELECT COUNT(*) AS n FROM ${leaves} WHERE status NOT IN (:statuses)`, { replacements: { statuses: OLD_STATUSES } });
      const [badDays] = await queryInterface.sequelize.query(
        `SELECT COUNT(*) AS n FROM ${leaves} WHERE days <> FLOOR(days)`);
      const problems = [];
      if (Number(badType[0].n)) problems.push(`${badType[0].n} leave row(s) use a leave type outside the original seven`);
      if (Number(badStatus[0].n)) problems.push(`${badStatus[0].n} leave row(s) are InfoRequested / Withdrawn / CancelRequested`);
      if (Number(badDays[0].n)) problems.push(`${badDays[0].n} leave row(s) have fractional days`);
      if (problems.length) {
        throw new Error(`Refusing to roll back 20260928000001: ${problems.join('; ')}. Fix or restore from backup.`);
      }
    }
    if (balances) {
      const [badType] = await queryInterface.sequelize.query(
        `SELECT COUNT(*) AS n FROM ${balances} WHERE leaveType NOT IN (:types)`, { replacements: { types: OLD_TYPES } });
      const [badDays] = await queryInterface.sequelize.query(
        `SELECT COUNT(*) AS n FROM ${balances} WHERE entitled <> FLOOR(entitled) OR carriedOver <> FLOOR(carriedOver)`);
      if (Number(badType[0].n) || Number(badDays[0].n)) {
        throw new Error('Refusing to roll back 20260928000001: leave overrides use a new leave type or fractional days.');
      }
    }

    if (balances) {
      const cols = await queryInterface.describeTable(balances);
      if (cols.weekOverride) await queryInterface.removeColumn(balances, 'weekOverride');
      if (cols.reason) await queryInterface.removeColumn(balances, 'reason');
      await queryInterface.sequelize.query(`UPDATE ${balances} SET entitled = 0 WHERE entitled IS NULL`);
      await queryInterface.sequelize.query(`UPDATE ${balances} SET carriedOver = 0 WHERE carriedOver IS NULL`);
      await queryInterface.changeColumn(balances, 'entitled', { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 });
      await queryInterface.changeColumn(balances, 'carriedOver', { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 });
      await queryInterface.changeColumn(balances, 'leaveType', { type: Sequelize.ENUM(...OLD_TYPES), allowNull: false });
    }

    if (leaves) {
      const cols = await queryInterface.describeTable(leaves);
      // A foreign key goes before its column/index — MySQL refuses otherwise.
      if (cols.attachmentDocumentId) {
        const fks = await queryInterface.getForeignKeyReferencesForTable(leaves);
        for (const fk of fks.filter((f) => f.columnName === 'attachmentDocumentId')) {
          await queryInterface.removeConstraint(leaves, fk.constraintName);
        }
      }
      for (const name of ['onBehalf', 'attachmentDocumentId', 'breakdown', 'policyYear', 'submittedAt',
        'contactNote', 'reachable', 'returnDate', 'endPart', 'startPart']) {
        if (cols[name]) await queryInterface.removeColumn(leaves, name);
      }
      await queryInterface.changeColumn(leaves, 'status', {
        type: Sequelize.ENUM(...OLD_STATUSES), allowNull: false, defaultValue: 'Pending',
      });
      await queryInterface.changeColumn(leaves, 'days', { type: Sequelize.INTEGER, allowNull: false });
      await queryInterface.changeColumn(leaves, 'leaveType', { type: Sequelize.ENUM(...OLD_TYPES), allowNull: false });
    }

    const types = await findTable(queryInterface, 'LeaveTypes');
    if (types) await queryInterface.dropTable(types);
  },
};
