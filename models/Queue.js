const { defineModel, DataTypes } = require('../utils/defineModel');

const Queue = defineModel('Queue', {
  // patientId       — added by Patient.hasMany(Queue)
  // assignedDoctorId — added by Queue.belongsTo(User, { as: 'assignedDoctor' }) — nullable

  status: {
    type: DataTypes.ENUM('Awaiting Triage', 'In Triage', 'Awaiting Doctor', 'With Doctor', 'Pending Billing', 'Completed', 'Removed'),
    allowNull: false,
    defaultValue: 'Awaiting Triage',
  },
  priority: {
    type: DataTypes.ENUM('Normal', 'Urgent'),
    allowNull: false,
    defaultValue: 'Normal',
  },
  reason: {
    type: DataTypes.TEXT,
  },

  // Set by the controller when consultation starts / ends
  consultationStartTime: {
    type: DataTypes.DATE,
    defaultValue: null,
  },
  consultationEndTime: {
    type: DataTypes.DATE,
    defaultValue: null,
  },

  // Set by doctor when completing consultation — stored as JSON arrays of strings
  selectedCharges: {
    type: DataTypes.JSON,
    defaultValue: null,
  },
  selectedProcedures: {
    type: DataTypes.JSON,
    defaultValue: null,
  },

  // --- Accountability ---
  addedBy: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  triagedBy: {
    type: DataTypes.STRING,
    defaultValue: null,
  },

  // Set by receptionist at discharge
  finalCharges: {
    type: DataTypes.JSON,
    defaultValue: null,
  },
  finalProcedures: {
    type: DataTypes.JSON,
    defaultValue: null,
  },
  dischargeComment: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
  dischargedBy: {
    type: DataTypes.STRING,
    defaultValue: null,
  },

  // Set when a patient is removed before discharge
  removedBy: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  removalReason: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },

  // --- Referral tracking (all nullable — only set when a referral occurs) ---
  // Gives a permanent, queryable audit trail: who referred, to whom, why, and when.

  referralType: {
    type: DataTypes.ENUM('Internal', 'External'),
    defaultValue: null,
  },
  referralReason: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
  // Stored as a name string (not FK) so the record survives future reassignments
  referredByDoctorName: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  // Exact moment the referral was made — updatedAt is not reliable (changes on every update)
  referredAt: {
    type: DataTypes.DATE,
    defaultValue: null,
  },
  // Internal only: name of the doctor the patient is being sent to
  referredToDoctorName: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  // External only: name of the hospital, clinic, or specialist
  externalReferralTarget: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
});

module.exports = Queue;
