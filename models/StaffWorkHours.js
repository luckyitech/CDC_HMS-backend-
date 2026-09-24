const { defineModel, DataTypes } = require('../utils/defineModel');

// A member of staff's expected working hours (B21, decision 9).
//
// Two shapes of row share the table:
//   weekday rows   — weekday 0..6 (0 = Sunday), date NULL: the standing pattern
//   dated rows     — date set, weekday NULL: a one-day override. The future
//                    shift roster writes these, so taps will cross-reference a
//                    roster without a redesign.
//
// Resolution for a given person and clinic date (utils/workHours.js):
// active dated row → active weekday row whose effective range covers the date
// → the clinic-wide default in Settings (hr.hours.default) → none.
//
// isOff = true means "no expected hours that day": no punctuality is judged
// and no star is earned. A NULL startTime/endTime on a non-off row is treated
// as "use the clinic default".
//
// Rows are retired, never deleted, so an old month still resolves the hours
// it was judged against (though punctuality is also stored on the session).
//
// Association-injected: UserId, createdById, updatedById.
const StaffWorkHours = defineModel('StaffWorkHours', {
  weekday: {
    type: DataTypes.TINYINT,
    allowNull: true,
    defaultValue: null,
  },
  date: {
    type: DataTypes.DATEONLY,
    allowNull: true,
    defaultValue: null,
  },
  startTime: {
    type: DataTypes.TIME,
    allowNull: true,
    defaultValue: null,
  },
  endTime: {
    type: DataTypes.TIME,
    allowNull: true,
    defaultValue: null,
  },
  isOff: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  // Per-person grace in minutes; NULL = the clinic-wide setting.
  graceMinutes: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
  effectiveFrom: {
    type: DataTypes.DATEONLY,
    allowNull: true,
    defaultValue: null,
  },
  effectiveTo: {
    type: DataTypes.DATEONLY,
    allowNull: true,
    defaultValue: null,
  },
  status: {
    type: DataTypes.ENUM('active', 'retired'),
    allowNull: false,
    defaultValue: 'active',
  },
}, {
  // The table name would otherwise be inflected from the model name; "Hours"
  // is already plural, so it is pinned to avoid a surprise.
  tableName: 'StaffWorkHours',
});

// The unique (UserId, weekday, date, effectiveFrom) index is created by the
// migration, not here (association-injected UserId — see StaffLeave.js).

module.exports = StaffWorkHours;
