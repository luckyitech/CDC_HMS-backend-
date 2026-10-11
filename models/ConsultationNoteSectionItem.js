const { defineModel, DataTypes } = require('../utils/defineModel');

// One tick inside a consultation-note section (10 Oct 2026):
//   chips  item "Polyuria"            value "yes"
//   rows   item "Retinopathy"         value "No" / "Yes" / "Not known"
//   meds   item "Metformin 1 g BD"    value "current" / "stopped"
// Its own row rather than JSON so the clinic can report on it in SQL.
const ConsultationNoteSectionItem = defineModel('ConsultationNoteSectionItem', {
  // ConsultationNoteSectionId — added by ConsultationNoteSection.hasMany(...)
  item: {
    type: DataTypes.STRING(120),
    allowNull: false,
  },
  value: {
    type: DataTypes.STRING(120),
    allowNull: false,
    defaultValue: 'yes',
  },
}, {
  timestamps: false,
});

module.exports = ConsultationNoteSectionItem;
