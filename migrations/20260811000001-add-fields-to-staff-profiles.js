'use strict';

// Staff Profiles Phase 1 (1/3) — widen StaffProfiles into the single profile
// table for every cadre. See STAFF_PROFILE_DESIGN.md.
//
// Every column is nullable: existing rows have none of this data yet, and the
// backfill runs in the next migration. Guarded so a re-run is a no-op.

const TABLE = 'StaffProfiles';

// This project creates tables with sequelize.sync(), so on a brand-new database
// StaffProfiles may not exist when migrations run — and when sync does create
// it, it creates it from the model, which already has every column below. Both
// paths end in the same schema; this guard just stops the migration throwing on
// the fresh-install path.
const tableExists = async (qi) => {
  const tables = await qi.showAllTables();
  return tables
    .map((t) => (typeof t === 'string' ? t : t.tableName).toLowerCase())
    .includes(TABLE.toLowerCase());
};

const COLUMNS = (Sequelize) => ({
  // Identity
  employeeId:       { type: Sequelize.STRING,  allowNull: true },
  dateOfBirth:      { type: Sequelize.DATE,    allowNull: true },
  gender:           { type: Sequelize.ENUM('Male', 'Female', 'Other'), allowNull: true },
  idNumber:         { type: Sequelize.STRING,  allowNull: true },
  photoUrl:         { type: Sequelize.STRING,  allowNull: true },

  // Contact
  address:          { type: Sequelize.STRING,  allowNull: true },
  city:             { type: Sequelize.STRING,  allowNull: true },
  emergencyContact: { type: Sequelize.JSON,    allowNull: true, defaultValue: null },

  // Employment
  ward:             { type: Sequelize.STRING,  allowNull: true },
  employmentType:   { type: Sequelize.ENUM('Full-time', 'Part-time', 'Contract', 'Consultant', 'Locum', 'Temporary'), allowNull: true },
  endDate:          { type: Sequelize.DATE,    allowNull: true },
  employmentStatus: { type: Sequelize.ENUM('Active', 'On Leave', 'Suspended', 'Resigned', 'Terminated'), allowNull: true, defaultValue: 'Active' },
  reportsToId:      { type: Sequelize.INTEGER, allowNull: true },

  // Credentials
  licenseNumber:    { type: Sequelize.STRING,  allowNull: true },
  licenseBody:      { type: Sequelize.STRING,  allowNull: true },
  licenseExpiry:    { type: Sequelize.DATE,    allowNull: true },
  specialty:        { type: Sequelize.STRING,  allowNull: true },
  qualification:    { type: Sequelize.STRING,  allowNull: true },
  institution:      { type: Sequelize.STRING,  allowNull: true },
  yearsExperience:  { type: Sequelize.INTEGER, allowNull: true },

  // Role-specific
  roleDetails:      { type: Sequelize.JSON,    allowNull: true, defaultValue: null },

  // Accountability
  createdBy:        { type: Sequelize.INTEGER, allowNull: true, defaultValue: null },
  updatedBy:        { type: Sequelize.INTEGER, allowNull: true, defaultValue: null },
  deletedAt:        { type: Sequelize.DATE,    allowNull: true, defaultValue: null },
  deletedBy:        { type: Sequelize.INTEGER, allowNull: true, defaultValue: null },
});

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface))) return;

    const table = await queryInterface.describeTable(TABLE);
    const columns = COLUMNS(Sequelize);

    for (const [name, spec] of Object.entries(columns)) {
      if (!table[name]) await queryInterface.addColumn(TABLE, name, spec);
    }
  },

  async down(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface))) return;

    const table = await queryInterface.describeTable(TABLE);
    const columns = COLUMNS(Sequelize);

    for (const name of Object.keys(columns)) {
      if (table[name]) await queryInterface.removeColumn(TABLE, name);
    }
  },
};
