const { defineModel, DataTypes } = require('../utils/defineModel');

// One clinic day's look at one finding (Dermatology, migration
// 20260928000021). At most one per finding per day. A finding not opened at a
// visit has NO row that day — it reads "Not examined", never a copy (D6).
//
// Sizes are typed in mm with `measuredBy` (D5) — never derived from a photo.
// colours / symptoms are comma lists of fixed tokens (utils/dermRules).
// doctorId (the author) comes from the JWT and never changes. Its author may
// change it on the same clinic day; after that it is AMENDED with a reason,
// each change kept in DermEdits (D7). `status` entered_in_error hides it.
const DermObservation = defineModel('DermObservation', {
  visitDate:    { type: DataTypes.DATEONLY, allowNull: false },
  doctorId:     { type: DataTypes.INTEGER, allowNull: true },
  statusToday:  { type: DataTypes.ENUM('new', 'improved', 'stable', 'worsened', 'resolved', 'recurrence'), allowNull: false },
  lengthMm:     { type: DataTypes.DECIMAL(6, 1), allowNull: true },
  widthMm:      { type: DataTypes.DECIMAL(6, 1), allowNull: true },
  depthMm:      { type: DataTypes.DECIMAL(6, 1), allowNull: true },
  measuredBy:   { type: DataTypes.ENUM('ruler', 'dermatoscope', 'estimated'), allowNull: true },
  // Choice fields hold fixed tokens OR the doctor's typed word ("Other…");
  // lists are comma separated (utils/dermExam — 9 Oct 2026, migration …028).
  morphology:   { type: DataTypes.STRING(300), allowNull: true },
  border:       { type: DataTypes.STRING(300), allowNull: true },
  surface:      { type: DataTypes.STRING(300), allowNull: true },
  colours:      { type: DataTypes.STRING(300), allowNull: true },
  symptoms:     { type: DataTypes.STRING(300), allowNull: true },
  // Structured skin examination (…028): one column per field, reportable.
  sizeMinMm:       { type: DataTypes.DECIMAL(6, 1), allowNull: true },
  sizeMaxMm:       { type: DataTypes.DECIMAL(6, 1), allowNull: true },
  distribution:    { type: DataTypes.STRING(60), allowNull: true },
  symmetry:        { type: DataTypes.STRING(60), allowNull: true },
  pattern:         { type: DataTypes.STRING(300), allowNull: true },
  configuration:   { type: DataTypes.STRING(300), allowNull: true },
  shape:           { type: DataTypes.STRING(60), allowNull: true },
  texture:         { type: DataTypes.STRING(60), allowNull: true },
  scale:           { type: DataTypes.STRING(60), allowNull: true },
  crust:           { type: DataTypes.STRING(60), allowNull: true },
  erosion:         { type: DataTypes.STRING(60), allowNull: true },
  ulceration:      { type: DataTypes.STRING(60), allowNull: true },
  ulcerBase:       { type: DataTypes.STRING(60), allowNull: true },
  excoriation:     { type: DataTypes.STRING(60), allowNull: true },
  lichenification: { type: DataTypes.STRING(60), allowNull: true },
  atrophy:         { type: DataTypes.STRING(60), allowNull: true },
  scarring:        { type: DataTypes.STRING(60), allowNull: true },
  lesionCount:     { type: DataTypes.INTEGER, allowNull: true },
  lesionCountKind: { type: DataTypes.STRING(60), allowNull: true },
  bsaPercent:      { type: DataTypes.DECIMAL(4, 1), allowNull: true },
  dermoscopy:      { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  dsGlobal:        { type: DataTypes.STRING(60), allowNull: true },
  dsNetwork:       { type: DataTypes.STRING(60), allowNull: true },
  dsDots:          { type: DataTypes.STRING(60), allowNull: true },
  dsStreaks:       { type: DataTypes.STRING(60), allowNull: true },
  dsBlueWhite:     { type: DataTypes.STRING(60), allowNull: true },
  dsVascular:      { type: DataTypes.STRING(300), allowNull: true },
  dsRegression:    { type: DataTypes.STRING(60), allowNull: true },
  dsOther:         { type: DataTypes.STRING(300), allowNull: true },
  description:  { type: DataTypes.TEXT, allowNull: true },
  diagnosis:    { type: DataTypes.STRING(200), allowNull: true },
  differential: { type: DataTypes.STRING(300), allowNull: true },
  plan:         { type: DataTypes.STRING(60), allowNull: true },
  planNote:     { type: DataTypes.TEXT, allowNull: true },
  reviewIn:     { type: DataTypes.STRING(60), allowNull: true },
  status:       { type: DataTypes.ENUM('active', 'entered_in_error'), allowNull: false, defaultValue: 'active' },
  amendedById:  { type: DataTypes.INTEGER, allowNull: true },
  amendedAt:    { type: DataTypes.DATE, allowNull: true },
}, {
  indexes: [{ name: 'uq_derm_observation_day', unique: true, fields: ['DermFindingId', 'visitDate'] }],
});

module.exports = DermObservation;
