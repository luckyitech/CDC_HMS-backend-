const { defineModel, DataTypes } = require('../utils/defineModel');

// A single leave request or recorded absence.
//
// UserId (the staff member) and approvedById are added by the associations in
// index.js. See STAFF_PROFILE_DESIGN.md.
const StaffLeave = defineModel('StaffLeave', {
  leaveType: {
    type: DataTypes.ENUM(
      'Annual', 'Sick', 'Maternity', 'Paternity', 'Compassionate', 'Study', 'Unpaid'
    ),
    allowNull: false,
  },
  startDate: {
    type: DataTypes.DATEONLY,   // a leave day is a calendar day, not an instant
    allowNull: false,
  },
  endDate: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },

  // Stored rather than derived on read: entitlement is drawn down against this
  // number, and recomputing it later — after someone changes what counts as a
  // working day — would silently restate balances for leave already taken.
  days: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },

  reason: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
  status: {
    type: DataTypes.ENUM('Pending', 'Approved', 'Rejected', 'Cancelled'),
    allowNull: false,
    defaultValue: 'Pending',
  },
  approvedAt: {
    type: DataTypes.DATE,
    defaultValue: null,
  },
  decisionNote: {
    type: DataTypes.TEXT,       // why it was rejected, or a note on approval
    defaultValue: null,
  },

  // IDs of the DoctorBlock rows created when a doctor's leave was approved, so
  // cancelling the leave removes exactly those blocks and no others. Without
  // this the only way to undo them would be to guess by date, which would also
  // delete blocks the doctor set for their own reasons.
  doctorBlockIds: {
    type: DataTypes.JSON,
    defaultValue: null,
  },

  // --- Accountability ---
  createdBy: { type: DataTypes.INTEGER, defaultValue: null },
  updatedBy: { type: DataTypes.INTEGER, defaultValue: null },
});

// The (UserId, startDate) index is created by the migration, NOT declared here.
//
// UserId is not an attribute of this model — it is injected by
// User.hasMany(StaffLeave) in index.js. Naming it in an `indexes` option makes
// sequelize.sync() try to build an index over a column it does not yet know
// about, which MySQL rejects with "Key column 'UserId' doesn't exist in table"
// and takes the whole app down on boot.
//
// Same applies to any future index over an association-injected column: put it
// in the migration, where the column definitely exists.

module.exports = StaffLeave;
