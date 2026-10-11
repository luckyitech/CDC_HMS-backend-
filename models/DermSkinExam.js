const { defineModel, DataTypes } = require('../utils/defineModel');

// "Today's whole-skin exam" (Dermatology, 9 Oct 2026, migration
// 20260928000028): the parts of a skin examination that belong to the patient
// that day rather than to one finding — hair, nails, lymph nodes, mucosa. One
// per patient per clinic day. Each part is "not examined" until its switch is
// on; a part not examined keeps none of its fields (utils/dermExam).
//
// Same rules as a look: the author (doctorId, from the JWT) may change it the
// same day; after that, or by someone else, it is AMENDED with a reason and
// each change kept in DermEdits (entity 'skin_exam'). Never deleted.
const one = () => ({ type: DataTypes.STRING(60), allowNull: true });
const many = () => ({ type: DataTypes.STRING(300), allowNull: true });
const text = () => ({ type: DataTypes.TEXT, allowNull: true });
const flag = () => ({ type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });

const DermSkinExam = defineModel('DermSkinExam', {
  visitDate:        { type: DataTypes.DATEONLY, allowNull: false },
  doctorId:         { type: DataTypes.INTEGER, allowNull: true },
  hairExamined:     flag(),
  scalp:            text(),
  hairDensity:      one(),
  hairDensityPattern: many(),
  hairCalibre:      one(),
  pullTest:         one(),
  pullTestSite:     { type: DataTypes.STRING(100), allowNull: true },
  pullTestCount:    { type: DataTypes.INTEGER, allowNull: true },
  exclamationHairs: one(),
  brokenHairs:      one(),
  nailsExamined:    flag(),
  nailsAffected:    many(),
  nailPlate:        many(),
  nailBed:          many(),
  periungual:       many(),
  nodesExamined:    flag(),
  lymphadenopathy:  one(),
  nodesNote:        text(),
  mucosaExamined:   flag(),
  oral:             one(),
  oralNote:         text(),
  genital:          one(),
  genitalNote:      text(),
  notes:            text(),
  status:           { type: DataTypes.ENUM('active', 'entered_in_error'), allowNull: false, defaultValue: 'active' },
  amendedById:      { type: DataTypes.INTEGER, allowNull: true },
  amendedAt:        { type: DataTypes.DATE, allowNull: true },
}, {
  indexes: [{ name: 'uq_derm_skin_exam_day', unique: true, fields: ['PatientId', 'visitDate'] }],
});

module.exports = DermSkinExam;
