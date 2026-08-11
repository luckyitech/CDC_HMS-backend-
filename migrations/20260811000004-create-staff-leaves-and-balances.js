'use strict';

// Staff Profiles Phase 3 — leave requests and annual entitlement.
// See STAFF_PROFILE_DESIGN.md.

const LEAVE_TYPES = ['Annual', 'Sick', 'Maternity', 'Paternity', 'Compassionate', 'Study', 'Unpaid'];

const tableExists = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables
    .map((t) => (typeof t === 'string' ? t : t.tableName).toLowerCase())
    .includes(name.toLowerCase());
};

const userFk = (Sequelize, allowNull = true) => ({
  type: Sequelize.INTEGER,
  allowNull,
  references: { model: 'Users', key: 'id' },
  onUpdate: 'CASCADE',
  onDelete: 'SET NULL',
});

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface, 'StaffLeaves'))) {
      await queryInterface.createTable('StaffLeaves', {
        id:             { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
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
        createdAt:      { type: Sequelize.DATE, allowNull: false },
        updatedAt:      { type: Sequelize.DATE, allowNull: false },
      });

      await queryInterface.addIndex('StaffLeaves', {
        fields: ['UserId', 'startDate'],
        name: 'staff_leave_user_start',
      });
    }

    if (!(await tableExists(queryInterface, 'LeaveBalances'))) {
      await queryInterface.createTable('LeaveBalances', {
        id:          { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        UserId:      userFk(Sequelize),
        year:        { type: Sequelize.INTEGER, allowNull: false },
        leaveType:   { type: Sequelize.ENUM(...LEAVE_TYPES), allowNull: false },
        entitled:    { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        carriedOver: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        createdBy:   { type: Sequelize.INTEGER, allowNull: true },
        updatedBy:   { type: Sequelize.INTEGER, allowNull: true },
        createdAt:   { type: Sequelize.DATE, allowNull: false },
        updatedAt:   { type: Sequelize.DATE, allowNull: false },
      });

      // One entitlement row per person per type per year — a duplicate would
      // silently double someone's allowance.
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
