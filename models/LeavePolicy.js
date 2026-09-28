const { defineModel, DataTypes } = require('../utils/defineModel');

// The clinic's leave rules for one year (B27, migration 20260928000002;
// decisions D1–D4, D10). A DRAFT until HR publishes it; until a year is
// published the HMS counts leave as it did before B27.
//
//   weekWeights    { "0": 0, "1": 1, …, "6": 1 } — what each weekday is worth
//                  (1 / ½ / 0). Read through utils/jsonColumn parseJsonColumn:
//                  MariaDB returns JSON columns as strings.
//   countingMode   'clinic_week' — everyone by weekWeights;
//                  'own_hours'   — a day the person is not expected in is 0.
//   carryExpiry    'MM-DD' when carried days lapse, or null (never).
//   visibleTypes   JSON [LeaveType.key] staff can see and apply for (D10).
//
// Association-injected: publishedById (models/index.js). The unique index on
// `year` lives in the migration.
const LeavePolicy = defineModel('LeavePolicy', {
  year:               { type: DataTypes.INTEGER, allowNull: false },
  status:             { type: DataTypes.ENUM('draft', 'published'), allowNull: false, defaultValue: 'draft' },
  weekWeights:        { type: DataTypes.JSON, allowNull: false },
  countingMode:       { type: DataTypes.ENUM('clinic_week', 'own_hours'), allowNull: false, defaultValue: 'clinic_week' },
  excludeHolidays:    { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  allowNegative:      { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  proRate:            { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  carryExpiry:        { type: DataTypes.CHAR(5), allowNull: true },
  minNoticeDays:      { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  maxCadreAwayPerDay: { type: DataTypes.INTEGER, allowNull: true },
  blockDoctorSlots:   { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  visibleTypes:       { type: DataTypes.JSON, allowNull: true },
  publishedAt:        { type: DataTypes.DATE, allowNull: true },
  createdBy:          { type: DataTypes.INTEGER, defaultValue: null },
  updatedBy:          { type: DataTypes.INTEGER, defaultValue: null },
});

module.exports = LeavePolicy;
