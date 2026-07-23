const { defineModel, DataTypes } = require('../utils/defineModel');

// Clinic-wide symptom vocabulary for the side effects tracker.
// "Add symptom" writes here, so a symptom added for one patient is offered for
// every patient afterwards. Entries are retired via isActive, never deleted —
// historical reviews reference them.
const Glp1SideEffectCatalog = defineModel('Glp1SideEffectCatalog', {
  // addedBy — added by User.hasMany(Glp1SideEffectCatalog, { foreignKey: 'addedBy' })

  name: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
  sortOrder: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  addedBy: {
    type: DataTypes.INTEGER,       // Must match User PK type (SIGNED — Sequelize default)
    defaultValue: null,
  },
});

module.exports = Glp1SideEffectCatalog;
