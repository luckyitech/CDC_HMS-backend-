const { defineModel, DataTypes } = require('../utils/defineModel');

// One person's appraisal in a cycle (HR Tier 3 Phase 5; utils/appraisals for
// the walk self → review → sent → acknowledged, or cancelled). The person is
// the association-generated UserId; reviewerId is aliased. Confidential: read
// only by the person, their reviewer and hr.appraisals holders (T3-10 a).
// Never deleted — a leaver's appraisal is cancelled with a note.
const Appraisal = defineModel('Appraisal', {
  cycleId:         { type: DataTypes.INTEGER, allowNull: false },
  reviewerId:      { type: DataTypes.INTEGER, allowNull: true },
  status:          { type: DataTypes.ENUM('self', 'review', 'sent', 'acknowledged', 'cancelled'), allowNull: false, defaultValue: 'self' },
  selfSummary:     { type: DataTypes.TEXT, allowNull: true },
  reviewerSummary: { type: DataTypes.TEXT, allowNull: true },
  personComment:   { type: DataTypes.TEXT, allowNull: true },
  meetingOn:       { type: DataTypes.DATEONLY, allowNull: true },
  selfSubmittedAt: { type: DataTypes.DATE, allowNull: true },
  sentAt:          { type: DataTypes.DATE, allowNull: true },
  acknowledgedAt:  { type: DataTypes.DATE, allowNull: true },
  cancelledNote:   { type: DataTypes.STRING(300), allowNull: true },
  cancelledById:   { type: DataTypes.INTEGER, allowNull: true },
  createdById:     { type: DataTypes.INTEGER, allowNull: true },
});

module.exports = Appraisal;
