'use strict';

// B27 phase 0 (2 of 6) — the yearly leave policy and public holidays.
// Spec §3.2, decisions D1–D4, D10 (Emu, 27 Sep 2026).
//
//   LeavePolicies      one row per year, DRAFT until HR publishes it. Holds the
//                      weekday values (D3), counting mode, carry-over expiry,
//                      notice, the cadre clash warning, whether a doctor's slots
//                      are blocked, and which types staff can see (D10).
//   LeavePolicyTypes   per year × leave type: days, counted as working or
//                      calendar days, how granted, carry cap, half days, when a
//                      document is needed, notice override, enabled.
//   PublicHolidays     an HR-maintained dated list (D4). Never counted as leave.
//
// Seeds DRAFT 2026 and 2027 policies from the D1 defaults (Kenya Employment Act
// minimums — Annual 21 working days, Sick 14, Maternity 90 calendar days,
// Paternity 14 calendar days; Compassionate / Study / Unpaid without a fixed
// allowance) with Mon–Sat worth a full day and Sunday 0. Nothing is published:
// HR reviews, edits and publishes. Until a year is published the HMS counts
// and reports leave exactly as it does today.
//
// Holidays seeded for 2026 and 2027 from the Public Holidays Act (Cap. 110)
// schedule as amended — 10 October is Mazingira Day. The Act's own rule —
// a Part I holiday falling on a Sunday makes the next day that is not already
// a holiday a public holiday — gives three observed Mondays in 2027
// (11 Oct, 13 Dec, 27 Dec); no 2026 fixed date falls on a Sunday.
// Idd-ul-Fitr (moon-dependent) and any ad-hoc declaration are HR's to add.
// Checked 28 Sep 2026 against new.kenyalaw.org/akn/ke/act/1912/21.
//
// Guarded both ways; `down` drops the three tables (the seeds go with them).

const SEVEN = ['Annual', 'Sick', 'Maternity', 'Paternity', 'Compassionate', 'Study', 'Unpaid'];

// D1 defaults. days null = no fixed allowance (grant 'unlimited').
const DEFAULT_TYPES = {
  Annual:        { days: 21,   countedAs: 'working',  grant: 'up_front',  halfDaysAllowed: true,  docRule: 'never',  minNoticeDays: 14 },
  Sick:          { days: 14,   countedAs: 'working',  grant: 'up_front',  halfDaysAllowed: true,  docRule: 'always', minNoticeDays: 0 },
  Maternity:     { days: 90,   countedAs: 'calendar', grant: 'per_event', halfDaysAllowed: false, docRule: 'always', minNoticeDays: null },
  Paternity:     { days: 14,   countedAs: 'calendar', grant: 'per_event', halfDaysAllowed: false, docRule: 'never',  minNoticeDays: null },
  Compassionate: { days: null, countedAs: 'working',  grant: 'unlimited', halfDaysAllowed: false, docRule: 'never',  minNoticeDays: 0 },
  Study:         { days: null, countedAs: 'working',  grant: 'unlimited', halfDaysAllowed: true,  docRule: 'never',  minNoticeDays: null },
  Unpaid:        { days: null, countedAs: 'working',  grant: 'unlimited', halfDaysAllowed: true,  docRule: 'never',  minNoticeDays: null },
};

const WEEK_WEIGHTS = { 0: 0, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 };

const HOLIDAYS = [
  ['2026-01-01', "New Year's Day"],
  ['2026-04-03', 'Good Friday'],
  ['2026-04-06', 'Easter Monday'],
  ['2026-05-01', 'Labour Day'],
  ['2026-06-01', 'Madaraka Day'],
  ['2026-10-10', 'Mazingira Day'],
  ['2026-10-20', 'Mashujaa Day'],
  ['2026-12-12', 'Jamhuri Day'],
  ['2026-12-25', 'Christmas Day'],
  ['2026-12-26', 'Boxing Day'],
  ['2027-01-01', "New Year's Day"],
  ['2027-03-26', 'Good Friday'],
  ['2027-03-29', 'Easter Monday'],
  ['2027-05-01', 'Labour Day'],
  ['2027-06-01', 'Madaraka Day'],
  ['2027-10-10', 'Mazingira Day'],
  ['2027-10-11', 'Mazingira Day (observed)'],
  ['2027-10-20', 'Mashujaa Day'],
  ['2027-12-12', 'Jamhuri Day'],
  ['2027-12-13', 'Jamhuri Day (observed)'],
  ['2027-12-25', 'Christmas Day'],
  ['2027-12-26', 'Boxing Day'],
  ['2027-12-27', 'Boxing Day (observed)'],
];

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};

const userRef = (Sequelize) => ({
  type: Sequelize.INTEGER, allowNull: true,
  references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
});

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await findTable(queryInterface, 'LeavePolicies'))) {
      await queryInterface.createTable('LeavePolicies', {
        id:                 { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        year:               { type: Sequelize.INTEGER, allowNull: false },
        status:             { type: Sequelize.ENUM('draft', 'published'), allowNull: false, defaultValue: 'draft' },
        weekWeights:        { type: Sequelize.JSON, allowNull: false },
        countingMode:       { type: Sequelize.ENUM('clinic_week', 'own_hours'), allowNull: false, defaultValue: 'clinic_week' },
        excludeHolidays:    { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        allowNegative:      { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        proRate:            { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        carryExpiry:        { type: Sequelize.CHAR(5), allowNull: true },
        minNoticeDays:      { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        maxCadreAwayPerDay: { type: Sequelize.INTEGER, allowNull: true },
        blockDoctorSlots:   { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        visibleTypes:       { type: Sequelize.JSON, allowNull: true },
        publishedAt:        { type: Sequelize.DATE, allowNull: true },
        publishedById:      userRef(Sequelize),
        createdBy:          { type: Sequelize.INTEGER, allowNull: true },
        updatedBy:          { type: Sequelize.INTEGER, allowNull: true },
        createdAt:          { type: Sequelize.DATE, allowNull: false },
        updatedAt:          { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex('LeavePolicies', ['year'], { name: 'leave_policies_year_unique', unique: true });
    }

    if (!(await findTable(queryInterface, 'LeavePolicyTypes'))) {
      await queryInterface.createTable('LeavePolicyTypes', {
        id:              { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        policyId: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: 'LeavePolicies', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        leaveTypeId: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: 'LeaveTypes', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        days:            { type: Sequelize.DECIMAL(6, 2), allowNull: true },
        countedAs:       { type: Sequelize.ENUM('working', 'calendar'), allowNull: false, defaultValue: 'working' },
        grant:           { type: Sequelize.ENUM('up_front', 'monthly', 'per_event', 'unlimited'), allowNull: false, defaultValue: 'up_front' },
        carryCap:        { type: Sequelize.DECIMAL(6, 2), allowNull: false, defaultValue: 0 },
        halfDaysAllowed: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        docRule:         { type: Sequelize.ENUM('never', 'always', 'over_days'), allowNull: false, defaultValue: 'never' },
        docOverDays:     { type: Sequelize.DECIMAL(6, 2), allowNull: true },
        minNoticeDays:   { type: Sequelize.INTEGER, allowNull: true },
        enabled:         { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        createdAt:       { type: Sequelize.DATE, allowNull: false },
        updatedAt:       { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex('LeavePolicyTypes', ['policyId', 'leaveTypeId'], { name: 'leave_policy_types_unique', unique: true });
    }

    if (!(await findTable(queryInterface, 'PublicHolidays'))) {
      await queryInterface.createTable('PublicHolidays', {
        id:        { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        date:      { type: Sequelize.DATEONLY, allowNull: false },
        name:      { type: Sequelize.STRING(120), allowNull: false },
        status:    { type: Sequelize.ENUM('active', 'retired'), allowNull: false, defaultValue: 'active' },
        source:    { type: Sequelize.ENUM('seed', 'hr'), allowNull: false, defaultValue: 'hr' },
        createdBy: { type: Sequelize.INTEGER, allowNull: true },
        updatedBy: { type: Sequelize.INTEGER, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      // One row per date. Re-adding a retired date reactivates it.
      await queryInterface.addIndex('PublicHolidays', ['date'], { name: 'public_holidays_date_unique', unique: true });
    }

    const now = new Date();

    // ---- Seed holidays (only dates not already present) ----
    const holTable = await findTable(queryInterface, 'PublicHolidays');
    const [haveHol] = await queryInterface.sequelize.query(`SELECT date FROM ${holTable}`);
    const haveDates = new Set(haveHol.map((r) => String(r.date instanceof Date ? r.date.toISOString() : r.date).slice(0, 10)));
    const newHol = HOLIDAYS.filter(([d]) => !haveDates.has(d))
      .map(([date, name]) => ({ date, name, status: 'active', source: 'seed', createdAt: now, updatedAt: now }));
    if (newHol.length) await queryInterface.bulkInsert(holTable, newHol);

    // ---- Seed DRAFT policies for 2026 and 2027 ----
    const polTable = await findTable(queryInterface, 'LeavePolicies');
    const ptTable = await findTable(queryInterface, 'LeavePolicyTypes');
    const typesTable = await findTable(queryInterface, 'LeaveTypes');
    const [types] = await queryInterface.sequelize.query(`SELECT id, \`key\` FROM ${typesTable}`);
    const typeId = Object.fromEntries(types.map((t) => [t.key, t.id]));

    for (const year of [2026, 2027]) {
      const [existing] = await queryInterface.sequelize.query(`SELECT id FROM ${polTable} WHERE year = :year`, { replacements: { year } });
      if (existing.length) continue;
      await queryInterface.bulkInsert(polTable, [{
        year,
        status: 'draft',
        weekWeights: JSON.stringify(WEEK_WEIGHTS),
        countingMode: 'clinic_week',
        excludeHolidays: true,
        allowNegative: false,
        proRate: true,
        carryExpiry: '03-31',
        minNoticeDays: 0,
        maxCadreAwayPerDay: 1,
        blockDoctorSlots: true,
        visibleTypes: JSON.stringify(SEVEN),
        createdAt: now,
        updatedAt: now,
      }]);
      const [[row]] = await queryInterface.sequelize.query(`SELECT id FROM ${polTable} WHERE year = :year`, { replacements: { year } });
      const rows = SEVEN.filter((k) => typeId[k]).map((k) => ({
        policyId: row.id,
        leaveTypeId: typeId[k],
        ...DEFAULT_TYPES[k],
        carryCap: 0,
        docOverDays: null,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      }));
      if (rows.length) await queryInterface.bulkInsert(ptTable, rows);
    }
  },

  async down(queryInterface) {
    for (const name of ['LeavePolicyTypes', 'LeavePolicies', 'PublicHolidays']) {
      const t = await findTable(queryInterface, name);
      if (t) await queryInterface.dropTable(t);
    }
  },
};
