const { defineModel, DataTypes } = require('../utils/defineModel');

const CareLinkPartner = defineModel('CareLinkPartner', {
  // PatientId — added by Patient.hasMany(CareLinkPartner)

  firstName: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  lastName: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  email: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  relationship: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  phone: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  isActive: {
    type:         DataTypes.BOOLEAN,
    defaultValue: true,
  },
  addedBy: {
    type: DataTypes.INTEGER,
    defaultValue: null,
  },
  addedDate: {
    type: DataTypes.DATE,
    defaultValue: null,
  },
});

module.exports = CareLinkPartner;
