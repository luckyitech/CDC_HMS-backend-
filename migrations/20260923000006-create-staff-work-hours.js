'use strict';

// HR Suite (B21) — per-person working hours: weekday rows (the standing
// pattern) and dated rows (one-day overrides; the future roster writes these).
// The unique index is over nullable columns, so MySQL treats NULLs as
// distinct — "one active weekday row per person per weekday" is also enforced
// in the controller. Guarded, reversible.

const TABLE = 'StaffWorkHours';

const resolveTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.find((t) => String(t).toLowerCase() === name.toLowerCase());
};
const hasIndex = async (qi, table, name) => {
  const idx = await qi.showIndex(table);
  return idx.some((i) => String(i.name).toLowerCase() === name.toLowerCase());
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const users = (await resolveTable(queryInterface, 'Users')) || 'Users';
    const fk = () => ({
      type: Sequelize.INTEGER, allowNull: true, defaultValue: null,
      references: { model: users, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
    });
    let table = await resolveTable(queryInterface, TABLE);
    if (!table) {
      await queryInterface.createTable(TABLE, {
        id:            { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        weekday:       { type: Sequelize.TINYINT, allowNull: true, defaultValue: null },
        date:          { type: Sequelize.DATEONLY, allowNull: true, defaultValue: null },
        startTime:     { type: Sequelize.TIME, allowNull: true, defaultValue: null },
        endTime:       { type: Sequelize.TIME, allowNull: true, defaultValue: null },
        isOff:         { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        graceMinutes:  { type: Sequelize.INTEGER, allowNull: true, defaultValue: null },
        effectiveFrom: { type: Sequelize.DATEONLY, allowNull: true, defaultValue: null },
        effectiveTo:   { type: Sequelize.DATEONLY, allowNull: true, defaultValue: null },
        status:        { type: Sequelize.ENUM('active', 'retired'), allowNull: false, defaultValue: 'active' },
        UserId:        fk(),
        createdById:   fk(),
        updatedById:   fk(),
        createdAt:     { type: Sequelize.DATE, allowNull: false },
        updatedAt:     { type: Sequelize.DATE, allowNull: false },
      });
      table = TABLE;
    }
    if (!(await hasIndex(queryInterface, table, 'staff_work_hours_person_slot'))) {
      await queryInterface.addIndex(table, ['UserId', 'weekday', 'date', 'effectiveFrom'],
        { name: 'staff_work_hours_person_slot', unique: true });
    }
  },

  async down(queryInterface) {
    const table = await resolveTable(queryInterface, TABLE);
    if (table) await queryInterface.dropTable(table);
  },
};
