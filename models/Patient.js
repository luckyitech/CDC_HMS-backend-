const { defineModel, DataTypes } = require('../utils/defineModel');

const Patient = defineModel('Patient', {
  // userId links to User if this patient has a login account (nullable)
  // primaryDoctorId links to the assigned doctor in Users (set in association with alias)

  uhid: {
    type: DataTypes.STRING,
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
  gender: {
    type: DataTypes.ENUM('Male', 'Female', 'Other'),
  },
  phone: {
    type: DataTypes.STRING,
  },
  email: {
    type: DataTypes.STRING,
  },
  address: {
    type: DataTypes.STRING,
  },
  dateOfBirth: {
    type: DataTypes.DATE,
  },
  idNumber: {
    type: DataTypes.STRING,   // national ID
  },

  // --- Medical info ---
  diagnosis: {
    type: DataTypes.STRING,
  },
  diagnosisDate: {
    type: DataTypes.DATE,
  },
  hba1c: {
    type: DataTypes.STRING,   // stored as "7.2%" to match frontend
  },
  referredBy: {
    type: DataTypes.STRING,
  },

  // --- Status ---
  status: {
    type: DataTypes.ENUM('Active', 'Inactive'),
    defaultValue: 'Active',
  },
  riskLevel: {
    type: DataTypes.ENUM('Low', 'Medium', 'High'),
  },

  // --- JSON fields (stored as single columns) ---
  comorbidities: {
    type: DataTypes.JSON,       // ["Hypertension", "Dyslipidemia"]
    defaultValue: [],
  },
  allergies: {
    type: DataTypes.STRING,     // "None" or "Penicillin"
    defaultValue: 'None',
  },
  currentMedications: {
    type: DataTypes.JSON,       // ["Metformin 500mg - Twice daily"]
    defaultValue: [],
  },
  emergencyContact: {
    type: DataTypes.JSON,       // { name, relationship, phone }
    defaultValue: null,
  },
  insurance: {
    type: DataTypes.JSON,       // { provider, policyNumber, type }
    defaultValue: null,
  },

  // --- Doctor summary (shared recognition note visible to all doctors) ---
  patientSummary: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
  },
  summaryUpdatedBy: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  summaryUpdatedAt: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
  },

  // --- Visit dates ---
  lastVisit: {
    type: DataTypes.DATE,
  },
  nextVisit: {
    type: DataTypes.DATE,
  },

  // --- Accountability ---
  registeredBy: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  registeredByRole: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  registrationComplete: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
}, {
  indexes: [
    { unique: true, fields: ['uhid'], name: 'unique_uhid' },
  ],
});

module.exports = Patient;
