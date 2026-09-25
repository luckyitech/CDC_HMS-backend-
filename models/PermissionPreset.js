const { defineModel, DataTypes } = require('../utils/defineModel');

// A permission preset — a named bundle of access that a permissions
// administrator defines once and the onboarding wizard applies to new hires.
//
// "Nurse — clinic floor", "Receptionist", "Pharmacy": the growable list of job
// shapes the clinic actually has. It is deliberately NOT a new value in the
// Users.role enum — roles stay the fixed authorization primitive; a preset is
// a template laid over one.
//
// A template, not a link. Nothing on a User points back here: editing a preset
// changes future hires only, and everyone already created from it keeps what
// they were given. The preset's name at creation time is recorded in the
// UserEditLog row the wizard writes, which is where "where did her access come
// from" is answered. appliedCount is a counter for the settings screen, never
// a join.
//
// Never holds admin.access, permissions.grant or hr.confidential — see
// PRESET_EXCLUDED in constants/permissions.js, enforced on every write.
//
// Decision of record: claude/onboarding-wizard-build-spec.md (24 Sep 2026).
// Association-injected: createdById, updatedById (models/index.js).
const PermissionPreset = defineModel('PermissionPreset', {
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
  },
  // The Users.role the preset is defined for. Applying a preset to a different
  // cadre is refused — a nurse preset carries nurse defaults.
  baseRole: {
    type: DataTypes.ENUM('doctor', 'staff', 'nurse', 'lab'),
    allowNull: false,
  },
  staffType: {
    type: DataTypes.ENUM('clinical', 'non_clinical'),
    allowNull: false,
    defaultValue: 'clinical',
  },
  // Default job title and department the wizard pre-fills on step 2. Both
  // descriptive only; the person's own StaffProfile holds what was actually
  // entered.
  position: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  department: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  permissions: {
    type: DataTypes.JSON,
    allowNull: false,
    defaultValue: [],
  },
  deniedPermissions: {
    type: DataTypes.JSON,
    allowNull: false,
    defaultValue: [],
  },
  // Soft delete: an archived preset disappears from the wizard's dropdown but
  // keeps its history, and its name may be reused by a new active one.
  status: {
    type: DataTypes.ENUM('active', 'archived'),
    allowNull: false,
    defaultValue: 'active',
  },
  appliedCount: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
});

module.exports = PermissionPreset;
