const { defineModel, DataTypes } = require('../utils/defineModel');

// Consolidated profile for every member of staff — doctor, nurse, lab tech and
// the 'staff' (front desk / admission clerk) role.
//
// This replaces the three-table split (DoctorProfile / StaffProfile /
// LabTechProfile) that repeated department, shift, startDate, qualification and
// yearsExperience three times over, and named the same idea `specialty` on
// doctors but `specialization` on lab techs. Nurses had no table at all — they
// borrowed StaffProfile, so a nurse could not hold a council registration
// number, a ward or a cadre.
//
// Shared fields are real columns; the part that genuinely differs per role
// lives in `roleDetails`. Same approach Patient already takes with
// comorbidities / emergencyContact / insurance / chartMetrics.
//
// Rule for deciding where a field goes: if it is queried, filtered, sorted or
// listed, it is a column. If it is only ever displayed on the profile page, it
// belongs in roleDetails. `specialty` is a column precisely because appointment
// booking filters on it.
//
// DoctorProfile and LabTechProfile still exist and are still read during the
// transition, but nothing writes to them any more. See STAFF_PROFILE_DESIGN.md.
const StaffProfile = defineModel('StaffProfile', {
  // UserId is added automatically by User.hasOne(StaffProfile) in index.js

  // =====================================
  // Identity
  // =====================================

  // Staff equivalent of Patient.uhid — EMP001, EMP002, ... Printable on a
  // badge, quotable over the phone, and the key the profile page routes on, so
  // the URL never exposes a database PK.
  employeeId: {
    type: DataTypes.STRING,
    allowNull: true,   // nullable so the backfill migration can run before IDs are assigned
  },
  dateOfBirth: {
    type: DataTypes.DATE,
  },
  gender: {
    type: DataTypes.ENUM('Male', 'Female', 'Other'),
  },
  idNumber: {
    type: DataTypes.STRING,   // national ID
  },
  photoUrl: {
    type: DataTypes.STRING,
  },

  // =====================================
  // Contact
  // =====================================

  address: {
    type: DataTypes.STRING,
  },
  city: {
    type: DataTypes.STRING,
  },
  emergencyContact: {
    type: DataTypes.JSON,     // { name, relationship, phone }
    defaultValue: null,
  },

  // =====================================
  // Employment
  // =====================================

  // Job title — Receptionist, Consultant, Ward Nurse. Distinct from User.role,
  // which decides the portal and the permissions baseline. A person whose
  // position is 'Nurse' may well hold role 'staff'.
  position: {
    type: DataTypes.STRING,
  },
  department: {
    type: DataTypes.STRING,
  },
  ward: {
    type: DataTypes.STRING,
  },
  employmentType: {
    type: DataTypes.ENUM('Full-time', 'Part-time', 'Contract', 'Consultant', 'Locum', 'Temporary'),
  },
  shift: {
    type: DataTypes.STRING,   // Morning, Afternoon, Night, Rotating
  },
  startDate: {
    type: DataTypes.DATE,
  },
  endDate: {
    type: DataTypes.DATE,     // set when they leave
  },

  // HR-facing state. User.isActive remains the single source of truth for
  // whether login is permitted; this is the human explanation next to it.
  // 'On Leave' deliberately does NOT disable login — someone on annual leave
  // should still be able to sign in. 'Suspended' is what blocks access.
  employmentStatus: {
    type: DataTypes.ENUM('Active', 'On Leave', 'Suspended', 'Resigned', 'Terminated'),
    defaultValue: 'Active',
  },
  reportsToId: {
    type: DataTypes.INTEGER,  // Users.id — supervisor
  },

  // =====================================
  // Credentials
  //
  // One shape covers all three clinical cadres: a doctor's medical council
  // licence, a nurse's council registration and a lab tech's certification are
  // the same four facts. Left null for role 'staff', who hold no licence —
  // which is the point of one shared table rather than a table per cadre.
  // =====================================

  licenseNumber: {
    type: DataTypes.STRING,
  },
  licenseBody: {
    type: DataTypes.STRING,   // issuing council
  },
  licenseExpiry: {
    type: DataTypes.DATE,
  },
  specialty: {
    type: DataTypes.STRING,   // doctor specialty / lab section / nursing cadre
  },
  qualification: {
    type: DataTypes.STRING,
  },
  institution: {
    type: DataTypes.STRING,   // medical school / training institution
  },
  yearsExperience: {
    type: DataTypes.INTEGER,
  },

  // =====================================
  // Role-specific
  //
  // doctor: { subSpecialty, consultationFee, acceptsAppointments, signatureUrl,
  //           qualifications: [{ degree, institution, year }] }
  // nurse:  { nursingCadre, certifications: [], wardRotation }
  // lab:    { labSection, equipmentCompetencies: [], supervisingPathologistId }
  // staff:  { desk, dutyPoints: [] }
  // =====================================

  roleDetails: {
    type: DataTypes.JSON,
    allowNull: false,
    defaultValue: {},
  },

  // =====================================
  // Accountability
  //
  // Users.id, not a name string. User.createdBy stores req.user.name for
  // historical reasons; new columns follow the project rule and store the ID.
  // =====================================

  createdBy: {
    type: DataTypes.INTEGER,
    defaultValue: null,
  },
  updatedBy: {
    type: DataTypes.INTEGER,
    defaultValue: null,
  },

  // Archive, not deletion. A departed doctor's name is still attached to
  // prescriptions, consultation notes and lab results — destroying the row
  // would orphan that history. Archiving hides them from every list and
  // disables login while leaving the record intact.
  deletedAt: {
    type: DataTypes.DATE,
    defaultValue: null,
  },
  deletedBy: {
    type: DataTypes.INTEGER,
    defaultValue: null,
  },
}, {
  indexes: [
    { unique: true, fields: ['employeeId'], name: 'unique_employee_id' },
  ],
});

module.exports = StaffProfile;
