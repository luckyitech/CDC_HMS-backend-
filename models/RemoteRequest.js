const { defineModel, DataTypes } = require('../utils/defineModel');

// A prescription or lab request written OUTSIDE a consultation (migration
// 20260928000020): the patient, a relative or a pharmacy phoned, sent a
// WhatsApp or email, or walked in without a visit. Part of the medical record:
// the clinical note is required, it is never hard-deleted (status cancelled),
// and the prescription / lab rows it produced point back to it through their
// remoteRequestId. The author (doctorId) comes from the JWT; PatientId is the
// canonical patient.
const RemoteRequest = defineModel('RemoteRequest', {
  doctorId:        { type: DataTypes.INTEGER, allowNull: true },
  channel:         { type: DataTypes.ENUM('phone', 'whatsapp', 'email', 'walk_in'), allowNull: false },
  requestedByType: { type: DataTypes.ENUM('patient', 'relative', 'pharmacy'), allowNull: false },
  requestedByName: { type: DataTypes.STRING(120), allowNull: true },
  note:            { type: DataTypes.TEXT, allowNull: false },
  status:          { type: DataTypes.ENUM('active', 'cancelled'), allowNull: false, defaultValue: 'active' },
  cancelledById:   { type: DataTypes.INTEGER, allowNull: true },
  cancelledAt:     { type: DataTypes.DATE, allowNull: true },
});

module.exports = RemoteRequest;
