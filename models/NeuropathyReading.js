const { defineModel, DataTypes } = require('../utils/defineModel');
const { FEET, SITES, MODALITIES } = require('../constants/neuropathy');

// Neuropathy Studio — one site reading. Normalised (foot × site × modality)
// rather than the vendor's 48 wide columns or a JSON blob, so any analyte can
// be queried/reported in SQL and new sites/protocols need no schema change.
//
//   value   — VPT: volts (integer); HOT/COLD: °C (0.1); MONO: 1 = felt, 0 = not felt
//   omitted — the clinician deliberately skipped this site (kept explicit,
//             like the vendor's "MTH 3, Instep" omission record). An omitted
//             site never counts toward the per-foot average.

const NeuropathyReading = defineModel('NeuropathyReading', {
  // NeuropathyStudyId — added by NeuropathyStudy.hasMany(NeuropathyReading)

  foot: {
    type: DataTypes.ENUM(...FEET),
    allowNull: false,
  },
  site: {
    type: DataTypes.ENUM(...SITES),
    allowNull: false,
  },
  modality: {
    type: DataTypes.ENUM(...MODALITIES),
    allowNull: false,
  },
  value: {
    type: DataTypes.DECIMAL(5, 1),
    defaultValue: null,
  },
  omitted: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
}, {
  indexes: [
    // One reading per foot × site × modality per study; upserts key on this.
    { unique: true, fields: ['NeuropathyStudyId', 'foot', 'site', 'modality'], name: 'unique_neuropathy_reading' },
  ],
});

module.exports = NeuropathyReading;
