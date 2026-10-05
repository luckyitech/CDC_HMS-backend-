const { defineModel, DataTypes } = require('../utils/defineModel');

// One line of the clinic's shared HR go-live / first-week checklist (HR Suite
// → Manual → Checklist, migration 20260928000018). ONE list for the whole
// clinic, shared by every member of HR staff.
//
// The built-in items' wording lives in the frontend content module (generated
// from the HR Suite Manual); their row here is created the first time someone
// ticks one or writes a note, keyed by the item's stable `itemKey`. Custom
// items HR adds carry their own `label` (key "custom-…").
//
// Current state only — every change is ALSO written to HrChecklistEvent, so an
// untick never loses who ticked it first. Archived, never deleted.
const HrChecklistItem = defineModel('HrChecklistItem', {
  itemKey:      { type: DataTypes.STRING(64), allowNull: false, unique: true },
  section:      { type: DataTypes.STRING(20), allowNull: false },
  label:        { type: DataTypes.STRING(300), allowNull: true },
  isCustom:     { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  done:         { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  doneById:     { type: DataTypes.INTEGER, allowNull: true },
  doneAt:       { type: DataTypes.DATE, allowNull: true },
  note:         { type: DataTypes.STRING(500), allowNull: true },
  noteById:     { type: DataTypes.INTEGER, allowNull: true },
  noteAt:       { type: DataTypes.DATE, allowNull: true },
  status:       { type: DataTypes.ENUM('active', 'archived'), allowNull: false, defaultValue: 'active' },
  createdById:  { type: DataTypes.INTEGER, allowNull: true },
  archivedById: { type: DataTypes.INTEGER, allowNull: true },
  archivedAt:   { type: DataTypes.DATE, allowNull: true },
});

module.exports = HrChecklistItem;
