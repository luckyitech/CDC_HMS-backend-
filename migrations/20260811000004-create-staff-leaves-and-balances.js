'use strict';

// Staff Profiles Phase 3 — leave requests and annual entitlement.
// See STAFF_PROFILE_DESIGN.md.
//
// This migration REPAIRS as well as creates. sequelize.sync() runs on every app
// boot and will happily create these tables itself if it gets there first, so a
// plain "table exists, nothing to do" guard would let a half-built table survive
// forever while the migration reported success. Each column and index is
// therefore checked individually.

const LEAVE_TYPES = ['Annual', 'Sick', 'Maternity', 'Paternity', 'Compassionate', 'Study', 'Unpaid'];

const tableExists = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables
    .map((t) => (typeof t === 'string' ? t : t.tableName).toLowerCase())
    .includes(name.toLowerCase());
};

const indexExists = async (qi, table, name) => {
  const indexes = await qi.showIndex(table);
  return indexes.some((i) => i.name === name);
};

const userFk = (Sequelize, allowNull = true) => ({
  type: Sequelize.INTEGER,
  allowNull,
  references: { model: 'Users', key: 'id' },
  onUpdate: 'CASCADE',
  onDelete: 'SET NULL',
});

// UserId is injected by the association rather than declared on the model, so a
// table sync created may be missing it. Add it before anything indexes it.
const ensureColumns = async (qi, table, columns) => {
  const existing = await qi.describeTable(table);
  for (const [name, spec] of Object.entries(columns)) {
    if (!existing[name]) await qi.addColumn(table, name, spec);
  }
};

const STAFF_LEAVE_COLUMNS = (Sequelize) => ({
  UserId:         userFk(Sequelize),
  leaveType:      { type: Sequelize.ENUM(...LEAVE_TYPES), allowNull: false },
  startDate:      { type: Sequelize.DATEONLY, allowNull: false },
  endDate:        { type: Sequelize.DATEONLY, allowNull: false },
  days:           { type: Sequelize.INTEGER, allowNull: false },
  reason:         { type: Sequelize.TEXT, allowNull: true },
  status:         { type: Sequelize.ENUM('Pending', 'Approved', 'Rejected', 'Cancelled'), allowNull: false, defaultValue: 'Pending' },
  approvedById:   userFk(Sequelize),
  approvedAt:     { type: Sequelize.DATE, allowNull: true },
  decisionNote:   { type: Sequelize.TEXT, allowNull: true },
  doctorBlockIds: { type: Sequelize.JSON, allowNull: true },
  createdBy:      { type: Sequelize.INTEGER, allowNull: true },
  updatedBy:      { type: Sequelize.INTEGER, allowNull: true },
});

const LEAVE_BALANCE_COLUMNS = (Sequelize) => ({
  UserId:      userFk(Sequelize),
  year:        { type: Sequelize.INTEGER, allowNull: false },
  leaveType:   { type: Sequelize.ENUM(...LEAVE_TYPES), allowNull: false },
  entitled:    { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
  carriedOver: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
  createdBy:   { type: Sequelize.INTEGER, allowNull: true },
  updatedBy:   { type: Sequelize.INTEGER, allowNull: true },
});

const timestamps = (Sequelize) => ({
  createdAt: { type: Sequelize.DATE, allowNull: false },
  updatedAt: { type: Sequelize.DATE, allowNull: false },
});

module.exports = {
  async up(queryInterface, Sequelize) {
    // ---- StaffLeaves ----
    if (!(await tableExists(queryInterface, 'StaffLeaves'))) {
      await queryInterface.createTable('StaffLeaves', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        ...STAFF_LEAVE_COLUMNS(Sequelize),
        ...timestamps(Sequelize),
      });
    } else {
      await ensureColumns(queryInterface, 'StaffLeaves', STAFF_LEAVE_COLUMNS(Sequelize));
    }

    if (!(await indexExists(queryInterface, 'StaffLeaves', 'staff_leave_user_start'))) {
      await queryInterface.addIndex('StaffLeaves', {
        fields: ['UserId', 'startDate'],
        name: 'staff_leave_user_start',
      });
    }

    // ---- LeaveBalances ----
    if (!(await tableExists(queryInterface, 'LeaveBalances'))) {
      await queryInterface.createTable('LeaveBalances', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        ...LEAVE_BALANCE_COLUMNS(Sequelize),
        ...timestamps(Sequelize),
      });
    } else {
      await ensureColumns(queryInterface, 'LeaveBalances', LEAVE_BALANCE_COLUMNS(Sequelize));
    }

    if (!(await indexExists(queryInterface, 'LeaveBalances', 'unique_leave_balance_user_year_type'))) {
      await queryInterface.addIndex('LeaveBalances', {
        fields: ['UserId', 'year', 'leaveType'],
        unique: true,
        name: 'unique_leave_balance_user_year_type',
      });
    }
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface, 'LeaveBalances')) await queryInterface.dropTable('LeaveBalances');
    if (await tableExists(queryInterface, 'StaffLeaves'))   await queryInterface.dropTable('StaffLeaves');
  },
};
