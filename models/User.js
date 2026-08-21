const { defineModel, DataTypes } = require('../utils/defineModel');

const User = defineModel('User', {
  email: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  password: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  role: {
    // 'nurse' added for HMIS V3 inpatient. Granular non-clinical cadres
    // (billing, records, radiographer, porter) are deferred to the future RBAC
    // system; for now 'staff' is the front-desk / admission clerk.
    type: DataTypes.ENUM('doctor', 'staff', 'lab', 'patient', 'admin', 'nurse'),
    allowNull: false,
  },
  firstName: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  lastName: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  phone: {
    type: DataTypes.STRING,
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
  resetToken: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  resetTokenExpires: {
    type: DataTypes.DATE,
    defaultValue: null,
  },

  // --- Accountability ---
  createdBy: {
    type: DataTypes.STRING,
    defaultValue: null,
  },

  // --- Weekly password rotation ---
  // When the user last chose their own password. NULL means they never have —
  // an admin-created account still on its emailed temp password — which counts
  // as expired. Only read while the rotation setting is on; see
  // utils/passwordRotation.js.
  passwordChangedAt: {
    type: DataTypes.DATE,
    defaultValue: null,
  },

  // --- Stock module permission ---
  // Admin-granted per-user flag: staff/doctors with this see the Stocks pages.
  // authorizeStock reads it from the DB (not the JWT) so a grant takes effect
  // without re-login.
  // Superseded by `permissions` ('stock.manage'). Kept so the migration that
  // moved capabilities into `permissions` stays reversible, and because the API
  // still reports a derived canManageStock for the frontend. Nothing should
  // read this column directly — use constants/permissions.js.
  canManageStock: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  // Capabilities granted on top of the user's role, e.g. ['admin.access'].
  // A real admin holds all of them implicitly and stores none. See
  // constants/permissions.js for why this is an array rather than a column
  // per capability.
  permissions: {
    type: DataTypes.JSON,
    allowNull: false,
    defaultValue: [],
  },
  // Capabilities explicitly WITHDRAWN from this user, e.g. ['inpatient.access'].
  // The restrictive half of the model: `permissions` adds to what the role
  // allows, this subtracts from it, and a denial beats a grant. Empty for
  // almost everyone — a role's defaults are the norm and this is the exception
  // an admin records deliberately. Never populated for a real admin account;
  // see constants/permissions.js for why.
  deniedPermissions: {
    type: DataTypes.JSON,
    allowNull: false,
    defaultValue: [],
  },

  // Does this member of staff do clinical work?
  //
  // `role` says which portal someone lands in. It does not say whether they
  // touch patients — and 'staff' in particular is a leftover bin holding
  // receptionists, administration and nurses together, so every one of them
  // held identical powers. This is the axis that separates them.
  //
  // Here on User rather than on StaffProfile because it is an authorization
  // input, read on every authenticated request exactly like role and
  // permissions. authenticate() already selects those from this table; putting
  // it on StaffProfile would add a join to every API call in the system.
  // StaffProfile keeps the descriptive HR data — position, department, ward.
  //
  // Defaults to clinical, and that direction matters: five of the eight staff
  // accounts in production are nurses, so defaulting to non-clinical would
  // disable most of the clinical workforce the moment this column landed.
  // Access is removed by classifying people deliberately, never by a default.
  //
  // Meaningless on a patient row, and never read for one — constants/
  // permissions.js derives the clinical bundle from the role, so a stray value
  // here cannot give a patient staff capabilities.
  staffType: {
    type: DataTypes.ENUM('clinical', 'non_clinical'),
    allowNull: false,
    defaultValue: 'clinical',
  },
}, {
  indexes: [
    { unique: true, fields: ['email'], name: 'unique_email', where: { email: { [require('sequelize').Op.ne]: null } } },
  ],
});

module.exports = User;
