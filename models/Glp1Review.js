const { defineModel, DataTypes } = require('../utils/defineModel');

// One row per monitoring visit.
//
// doctorId is the Doctor column on the monitoring table. Stamped from the JWT at
// creation, never client-supplied, and never overwritten — an amendment records a
// second name in amendedBy so the original author stays visible.
//
// Soft delete only: status flips to 'deleted'. There is deliberately no unique
// index on (Glp1TherapyId, weekNumber) — a soft-deleted row would block re-entry
// of that week. One *active* review per week is enforced in the controller.
const Glp1Review = defineModel('Glp1Review', {
  // Glp1TherapyId — added by Glp1Therapy.hasMany(Glp1Review)
  // PatientId     — added by Patient.hasMany(Glp1Review); denormalised so
  //                 merge-aware reads work without a join through the therapy
  // doctorId      — added by Glp1Review.belongsTo(User, { as: 'doctor' })

  weekNumber: {
    type: DataTypes.INTEGER,       // 4, 8, 12, 24, 36, 52 and any user-added week
    allowNull: false,
  },
  reviewDate: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  weight: {
    type: DataTypes.DECIMAL(5, 1), // kg — mirrors PatientVital precision
    defaultValue: null,
  },
  bmi: {
    type: DataTypes.DECIMAL(4, 1),
    defaultValue: null,
  },
  waistCircumference: {
    type: DataTypes.DECIMAL(4, 1), // cm
    defaultValue: null,
  },
  bp: {
    type: DataTypes.STRING,        // "128/80" — same convention as PatientVital.bp
    defaultValue: null,
  },
  heartRate: {
    type: DataTypes.INTEGER,
    defaultValue: null,
  },
  // Fasting plasma glucose. Hand-typed at the review — PatientVital carries rbs
  // but no FPG, and existing tables are deliberately left untouched by this work.
  fpg: {
    type: DataTypes.DECIMAL(5, 1),
    defaultValue: null,
  },
  hba1c: {
    type: DataTypes.DECIMAL(3, 1),
    defaultValue: null,
  },
  doseAtReview: {
    type: DataTypes.DECIMAL(5, 2), // what they were actually on, not what the ladder says
    defaultValue: null,
  },
  adherence: {
    type: DataTypes.ENUM('Good', 'Missed doses', 'Stopped'),
    defaultValue: null,
  },
  actionPlan: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },

  status: {
    type: DataTypes.ENUM('active', 'deleted'),
    allowNull: false,
    defaultValue: 'active',
  },
  deletedBy: {
    type: DataTypes.INTEGER,       // Must match User PK type (SIGNED — Sequelize default)
    defaultValue: null,
  },
  deletedAt: {
    type: DataTypes.DATE,
    defaultValue: null,
  },

  // --- Amendment trail ---
  amendedBy: {
    type: DataTypes.INTEGER,       // Must match User PK type (SIGNED — Sequelize default)
    defaultValue: null,
  },
  amendedAt: {
    type: DataTypes.DATE,
    defaultValue: null,
  },
  amendmentReason: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
});

module.exports = Glp1Review;
