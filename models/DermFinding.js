const { defineModel, DataTypes } = require('../utils/defineModel');

// A persistent skin finding — a lesion, rash, ulcer, scar… (Dermatology,
// migration 20260928000021). It lives across visits; each visit's look at it
// is a DermObservation. Part of the medical record: never hard-deleted —
// `status` 'entered_in_error' hides it, with who / when / why.
//
//   PatientId     association-generated; the canonical patient at creation
//   number        per patient record (#001…), never reused or renumbered.
//                 After a merge two may share a number — read through
//                 utils/dermRules.numberLabels, which shows "#001-B".
//   currentStatus the last observation's status (board colour)
//   diagnosis     the last diagnosis given (board line)
//   status        active | resolved | entered_in_error
//   createdById   from the JWT
const DermFinding = defineModel('DermFinding', {
  number:        { type: DataTypes.INTEGER, allowNull: false },
  type:          { type: DataTypes.ENUM('lesion', 'rash', 'ulcer', 'scar', 'pigmentation', 'hair_loss', 'nail', 'other'), allowNull: false },
  typeOther:     { type: DataTypes.STRING(60), allowNull: true },   // the name typed for type 'other' (…024)
  title:         { type: DataTypes.STRING(120), allowNull: false },
  exactSite:     { type: DataTypes.STRING(200), allowNull: true },
  firstNoticed:  { type: DataTypes.STRING(60), allowNull: true },
  concern:       { type: DataTypes.TEXT, allowNull: true },
  currentStatus: { type: DataTypes.ENUM('new', 'improved', 'stable', 'worsened', 'resolved', 'recurrence'), allowNull: false, defaultValue: 'new' },
  diagnosis:     { type: DataTypes.STRING(200), allowNull: true },
  status:        { type: DataTypes.ENUM('active', 'resolved', 'entered_in_error'), allowNull: false, defaultValue: 'active' },
  createdById:   { type: DataTypes.INTEGER, allowNull: true },
  errorReason:   { type: DataTypes.STRING(500), allowNull: true },
  errorById:     { type: DataTypes.INTEGER, allowNull: true },
  errorAt:       { type: DataTypes.DATE, allowNull: true },
}, {
  indexes: [{ name: 'idx_derm_finding_patient', fields: ['PatientId', 'number'] }],
});

module.exports = DermFinding;
