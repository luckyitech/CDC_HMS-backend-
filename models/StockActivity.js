const { defineModel, DataTypes } = require('../utils/defineModel');

// One Stocks function that leaves no other trace (13 Oct 2026, Emu): a
// stocktake (even when every count matched), par levels changed, a room
// matched to a doctor, a catalogue add / edit / retire, a test settled or
// taken later, levels rebuilt. Append-only. Movements, deliveries and line
// edits carry their own who + when. See utils/stockAudit.
const StockActivity = defineModel('StockActivity', {
  // userId / locationId / stockItemId — aliased associations in models/index.js
  action: {
    type: DataTypes.STRING(40),
    allowNull: false,
  },
  detail: {
    type: DataTypes.STRING(500),
    defaultValue: null,
  },
  // A stocktake: when the counter's list was drawn (createdAt = submitted).
  startedAt: {
    type: DataTypes.DATE,
    defaultValue: null,
  },
});

module.exports = StockActivity;
