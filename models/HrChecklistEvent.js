const { defineModel, DataTypes } = require('../utils/defineModel');

// The history of the shared HR checklist (migration 20260928000018): one row
// per change — tick, untick, note, add, archive, restore — with who (from the
// JWT, never the client) and when (createdAt). Append-only: never updated,
// never deleted.
const HrChecklistEvent = defineModel('HrChecklistEvent', {
  itemKey: { type: DataTypes.STRING(64), allowNull: false },
  action:  { type: DataTypes.ENUM('tick', 'untick', 'note', 'add', 'archive', 'restore'), allowNull: false },
  byId:    { type: DataTypes.INTEGER, allowNull: true },
  detail:  { type: DataTypes.STRING(500), allowNull: true },
}, { updatedAt: false });

module.exports = HrChecklistEvent;
