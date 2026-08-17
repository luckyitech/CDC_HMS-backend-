// Roles that carry a StaffProfile.
//
// Patients are excluded: they are subjects of the records rather than people
// who work here, and they already have their own Patient profile. Admins are
// included — an administrator is an employee with a department, a start date
// and leave like anyone else.
//
// Kept here rather than in a controller because both userController and
// staffController need it, and a second copy would inevitably drift.
const STAFF_ROLES = ['doctor', 'nurse', 'staff', 'lab', 'admin'];

// Maps User.role to the default job title used when an account is created
// without an explicit position. `position` is the HR job title and is distinct
// from `role`, which decides the portal and the permission baseline.
const DEFAULT_POSITION = {
  doctor: 'Doctor',
  nurse:  'Nurse',
  lab:    'Lab Technician',
  staff:  'Staff',
  admin:  'Administrator',
};

module.exports = { STAFF_ROLES, DEFAULT_POSITION };
